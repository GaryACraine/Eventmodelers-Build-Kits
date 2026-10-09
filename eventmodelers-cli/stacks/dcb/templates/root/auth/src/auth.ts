import { betterAuth } from "better-auth"
import { jwt } from "better-auth/plugins"
import { Pool } from "pg"
import type { AuthConfig } from "./config.js"
import type { SendEmail } from "./email.js"

/**
 * Better Auth, configured for this platform (ADR-054, ADR-055). Each part follows Better Auth's docs:
 *
 *   - the database: the PostgreSQL adapter (better-auth.com/docs/adapters/postgresql). Its tables live in their own
 *     `auth` schema in our Postgres, through `search_path`; `auth/migrations` creates them (the CLI's SQL);
 *   - email and password, with the email verified at sign-up (docs/authentication/email-password,
 *     docs/concepts/email). Emails are sent without being awaited: awaiting them would let response times reveal
 *     which addresses have accounts;
 *   - the JWT plugin (docs/plugins/jwt): the token our API checks against `/api/auth/jwks` (ADR-037). `sub` is
 *     Better Auth's user id; the payload adds `email` and `email_verified`; the issuer and audience are `baseURL`;
 *     tokens last 15 minutes; keys are EdDSA (Ed25519);
 *   - rate limits stored in Postgres, so they hold across instances (docs/reference/options).
 *
 * Everything else a person does with their account (resetting or changing a password, changing an email, a second
 * factor, passkeys) is off until ADR-056 is decided.
 *
 * `database` is the pool for its tables: by default one on the `auth` schema (tests pass their own, to close it).
 */
export function createAuth(
    config: AuthConfig,
    sendEmail: SendEmail,
    database = new Pool({ connectionString: config.databaseUrl, options: "-c search_path=auth" })
) {
    const send = (email: Parameters<SendEmail>[0]) => {
        void sendEmail(email).catch(error => console.error(`[auth] couldn't send "${email.subject}" to ${email.to}:`, error))
    }

    return betterAuth({
        baseURL: config.baseURL,
        secret: config.secret,
        database,
        trustedOrigins: config.trustedOrigins,
        emailAndPassword: {
            enabled: true,
            requireEmailVerification: true
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
        rateLimit: { enabled: true, storage: "database" },
        advanced: {
            // Always check a browser request's origin, even under NODE_ENV=test (Better Auth's default skips it there)
            disableOriginCheck: false,
            useSecureCookies: config.secureCookies,
            ipAddress: { ipAddressHeaders: config.ipAddressHeaders, trustedProxies: config.trustedProxies }
        },
        telemetry: { enabled: false },
        plugins: [
            jwt({
                jwt: {
                    definePayload: ({ user }) => ({ email: user.email, email_verified: user.emailVerified })
                }
            })
        ]
    })
}

export type Auth = ReturnType<typeof createAuth>
