import { betterAuth } from "better-auth"
import { APIError } from "better-auth/api"
import { haveIBeenPwned, jwt, twoFactor } from "better-auth/plugins"
import { passkey } from "@better-auth/passkey"
import { Pool, types } from "pg"
import { accountChanges } from "./accountChanges.js"
import type { AuthConfig } from "./config.js"
import type { Email, SendEmail } from "./email.js"
import { factorsInToken, recordFactors, signInMethod } from "./signInMethod.js"

/**
 * The pool for the sign-in service's tables, on the `auth` schema. A `bigint` is read as a number: Better Auth keeps
 * milliseconds in one (`rateLimit.lastRequest`) and adds to it, which on pg's default string makes the 429's
 * `X-Retry-After` nonsense (a wait of billions of minutes). Every one it keeps is a time in milliseconds, far inside a
 * safe integer.
 */
export function authPool(databaseUrl: string): Pool {
    return new Pool({
        connectionString: databaseUrl,
        options: "-c search_path=auth",
        types: { getTypeParser: ((oid: number, format?: "text" | "binary") => (oid === types.builtins.INT8 ? Number : types.getTypeParser(oid, format))) as typeof types.getTypeParser }
    })
}

/**
 * Better Auth, configured for this platform (ADR-054, ADR-055, ADR-056). Each part follows Better Auth's docs:
 *
 *   - the database: the PostgreSQL adapter (better-auth.com/docs/adapters/postgresql). Its tables live in their own
 *     `auth` schema in our Postgres, through `search_path`; `auth/migrations` creates them (the CLI's SQL);
 *   - email and password, with the email verified at sign-up (docs/authentication/email-password,
 *     docs/concepts/email). Emails are sent without being awaited: awaiting them would let response times reveal
 *     which addresses have accounts;
 *   - the JWT plugin (docs/plugins/jwt): the token our API checks against `/api/auth/jwks` (ADR-037). `sub` is
 *     Better Auth's user id; the payload adds `email`, `email_verified` and `amr` (how the session signed in); the
 *     issuer and audience are `baseURL`; tokens last 15 minutes; keys are EdDSA (Ed25519);
 *   - rate limits stored in Postgres, so they hold across instances, stricter on sign-in, sign-up, reset and change
 *     (docs/reference/options; ADR-056 D11);
 *   - the account's security (ADR-056, the "Decided" table):
 *     - a second factor for everyone: an emailed code, on from the moment the email is verified (D2), and the
 *       authenticator app with backup codes, or a passkey, as stronger factors (D8). How each session signed in, and
 *       the guards on changing a factor, are in `signInMethod.ts` (D1, D4a, D15);
 *     - a reset by an emailed link, valid an hour, that ends every session (D4); changing the password needs the
 *       current one and ends the other sessions (D5); changing the email is confirmed at the old address and verified
 *       at the new one (D6);
 *     - passwords of 12 to 128 characters, breached ones refused (D7); sessions of 7 days, refreshed daily (D9);
 *     - notices by email (D10, `accountChanges.ts`); signing up again with the same address emails its owner (D12).
 *
 * Deleting an account waits on ADR-062 (personal data in our events).
 *
 * `database` is the pool for its tables: by default one on the `auth` schema (tests pass their own, to close it).
 */
export function createAuth(config: AuthConfig, sendEmail: SendEmail, database = authPool(config.databaseUrl)) {
    /**
     * Sent without being awaited. A failure is logged as an alert line (ADR-032's format: a log-based rule turns it into
     * an email or a page); the person has a "send it again" on every screen that sends one. No address in the line.
     */
    const send = (email: Email) => {
        void sendEmail(email).catch(error =>
            console.error(
                JSON.stringify({
                    level: "alert",
                    at: new Date().toISOString(),
                    code: "sign-in-email-failed",
                    severity: "warning",
                    message: `The sign-in service couldn't send "${email.subject}"`,
                    details: { error: String(error) }
                })
            )
        )
    }
    const page = (path: string) => new URL(path, config.baseURL).toString()

    const auth = betterAuth({
        baseURL: config.baseURL,
        secret: config.secret,
        database,
        trustedOrigins: config.trustedOrigins,
        emailAndPassword: {
            enabled: true,
            requireEmailVerification: true,
            minPasswordLength: 12,
            maxPasswordLength: 128,
            sendResetPassword: async ({ user, url }) => {
                send({
                    to: user.email,
                    subject: "Reset your password",
                    text: `Open this link to choose a new password: ${url}\n\nIt works once, for an hour, and signs you out everywhere. If you didn't ask for it, ignore this email.`
                })
            },
            resetPasswordTokenExpiresIn: 3600,
            revokeSessionsOnPasswordReset: true,
            onPasswordReset: async ({ user }) => {
                send({
                    to: user.email,
                    subject: "Your password was reset",
                    text: "The password for your account was reset, and every session was signed out.\n\nIf this wasn't you, reset your password again now."
                })
            },
            // Signing up again with an address that has an account: the screen answers as for a new one (no probing),
            // and the owner of the address hears about it
            onExistingUserSignUp: async ({ user }) => {
                if (!user.emailVerified) {
                    await auth.api.sendVerificationEmail({ body: { email: user.email } })
                    return
                }
                send({
                    to: user.email,
                    subject: "You already have an account",
                    text: `Someone tried to sign up with this address, which already has an account. To sign in: ${page("/sign-in")}\nForgotten your password? ${page("/forgot-password")}\n\nIf it wasn't you, you needn't do anything.`
                })
            }
            // The answer to a sign-up with an existing address already looks like a new account's, plugin fields
            // included (Better Auth's synthetic user; accountLifecycle.tests.ts checks it)
        },
        emailVerification: {
            sendOnSignUp: true,
            // Signing in unverified is refused (403) and sends the link again: the sign-in form says so
            sendOnSignIn: true,
            autoSignInAfterVerification: true,
            sendVerificationEmail: async ({ user, url }) => {
                send({ to: user.email, subject: "Verify your email address", text: `Open this link to verify your email address: ${url}` })
            }
        },
        user: {
            changeEmail: {
                enabled: true,
                sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
                    send({
                        to: user.email,
                        subject: "Confirm the change of your email address",
                        text: `Someone asked to change your account's email address to ${newEmail}. If it was you, open this link to confirm: ${url}\n\nIf it wasn't, ignore this email and reset your password.`
                    })
                }
            }
        },
        session: {
            expiresIn: 7 * 24 * 3600,
            updateAge: 24 * 3600
        },
        databaseHooks: {
            session: { create: { before: recordFactors } },
            // D2: the emailed code is on for everyone from the moment their email is verified
            user: {
                create: { before: async user => (user.emailVerified ? { data: { ...user, twoFactorEnabled: true } } : undefined) },
                update: { before: async user => (user.emailVerified === true ? { data: { ...user, twoFactorEnabled: true } } : undefined) }
            }
        },
        rateLimit: {
            enabled: true,
            storage: "database",
            // D11: per address, stricter where a guess or a flood would hurt. The two-factor plugin's own: 3 per 10 s
            customRules: {
                "/sign-in/email": { window: 60, max: 5 },
                "/sign-up/email": { window: 60, max: 5 },
                "/request-password-reset": { window: 300, max: 3 },
                "/reset-password": { window: 300, max: 5 },
                "/send-verification-email": { window: 300, max: 3 },
                "/change-password": { window: 300, max: 5 },
                "/change-email": { window: 300, max: 3 }
            }
        },
        advanced: {
            // Always check a browser request's origin, even under NODE_ENV=test (Better Auth's default skips it there)
            disableOriginCheck: false,
            useSecureCookies: config.secureCookies,
            ipAddress: { ipAddressHeaders: config.ipAddressHeaders, trustedProxies: config.trustedProxies }
        },
        telemetry: { enabled: false },
        plugins: [
            twoFactor({
                issuer: new URL(config.baseURL).hostname,
                otpOptions: {
                    sendOTP: async ({ user, otp }) => {
                        send({ to: user.email, subject: "Your sign-in code", text: `Your sign-in code is ${otp}. It expires in 3 minutes.` })
                    }
                }
            }),
            // After twoFactor: its after-hooks read the plugin's answer to a sign-in
            signInMethod(),
            passkey({
                rpName: new URL(config.baseURL).hostname,
                // The device's own check (biometric or PIN) is what makes a passkey two factors (NIST): required
                authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
                registration: {
                    afterVerification: async ({ verification }) => {
                        if (!verification.registrationInfo?.userVerified)
                            throw APIError.from("BAD_REQUEST", { message: "The passkey must check it's you (biometric or PIN)", code: "PASSKEY_USER_NOT_VERIFIED" })
                    }
                },
                authentication: {
                    afterVerification: async ({ verification }) => {
                        if (!verification.authenticationInfo.userVerified)
                            throw APIError.from("UNAUTHORIZED", { message: "The passkey must check it's you (biometric or PIN)", code: "PASSKEY_USER_NOT_VERIFIED" })
                    }
                }
            }),
            accountChanges({ send, secret: config.secret }),
            ...(config.breachedPasswords
                ? [haveIBeenPwned({ customPasswordCompromisedMessage: "This password has appeared in a data breach: choose another" })]
                : []),
            jwt({
                jwt: {
                    definePayload: ({ user, session }) => ({
                        email: user.email,
                        email_verified: user.emailVerified,
                        amr: factorsInToken(session, config.stepUpHours)
                    })
                }
            })
        ]
    })
    return auth
}

export type Auth = ReturnType<typeof createAuth>
