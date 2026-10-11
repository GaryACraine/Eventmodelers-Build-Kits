import type { BetterAuthPlugin, GenericEndpointContext } from "@better-auth/core"
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx, sessionMiddleware } from "better-auth/api"

/**
 * How a session signed in (ADR-056 D1): the factors it proved, recorded on the session when it's created and carried
 * in the token as `amr` (RFC 8176's claim, with our own values). Our API reads them to decide whether a session is
 * strong enough for the caller's role (D3); the sign-in service reads them to guard enrolling or removing a factor.
 *
 *   pwd             the password
 *   email-otp       a code sent by email (the baseline second factor, D2)
 *   totp            a code from an authenticator app
 *   backup-code     one of the app's backup codes
 *   passkey         a passkey, with the device's own check (biometric or PIN): two factors on its own (NIST)
 *   trusted-device  "remember this device": a second factor was proved on this device before, which one isn't known
 *   email-link      the link that verified the email of a new account
 *
 * A session created where none of these is known gets no factors, so it passes no check (fail closed).
 */
/** `mfa` (RFC 8176): a second factor was proved, but too long ago to count as the app or a passkey (D15) */
export type Factor = "pwd" | "email-otp" | "totp" | "backup-code" | "passkey" | "trusted-device" | "email-link" | "mfa"

/** The factors that don't depend on the inbox (D3's `not-by-email`) */
const NOT_BY_EMAIL: readonly Factor[] = ["totp", "backup-code", "passkey"]

export const factorsOf = (amr: unknown): Factor[] =>
    String(amr ?? "")
        .split(" ")
        .filter(Boolean) as Factor[]

export const isNotByEmail = (factors: readonly Factor[]) => factors.some(f => NOT_BY_EMAIL.includes(f))

type Session = { userId: string; amr?: string | null; strongAt?: Date | string | null } & Record<string, unknown>

/**
 * The factors the token carries (D15): a factor that doesn't depend on the inbox counts for `stepUpHours` after it was
 * last proved, then drops out, so the API asks for it again. It was still a second factor (D2), which lasts as long
 * as the session: `mfa` takes its place, so a passkey-only session (or the password and the app) isn't left with
 * none, and is asked for the passkey or the app again rather than to sign in again.
 */
export function factorsInToken(session: Session, stepUpHours: number, now = Date.now()): Factor[] {
    const factors = factorsOf(session.amr)
    const strongAt = session.strongAt ? new Date(session.strongAt).getTime() : 0
    if (now - strongAt < stepUpHours * 3_600_000 || !isNotByEmail(factors)) return factors
    return [...factors.filter(f => !NOT_BY_EMAIL.includes(f)), "mfa"]
}

/** The factors a session created by signing in at `path` has proved; the password came first for the two-factor paths */
const SIGNED_IN_AT: Record<string, Factor[]> = {
    "/two-factor/verify-otp": ["pwd", "email-otp"],
    "/two-factor/verify-totp": ["pwd", "totp"],
    "/two-factor/verify-backup-code": ["pwd", "backup-code"],
    "/passkey/verify-authentication": ["passkey"]
}

/** What a verification token is for: none for a sign-up's, `change-email-…` for a change of email (read, not trusted) */
function verificationPurpose(token: unknown): string | undefined {
    try {
        return JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString()).requestType
    } catch {
        return "unreadable"
    }
}

/** How long after sign-up the verification link still counts as signing in (its own lifetime is an hour) */
const NEW_ACCOUNT_MS = 24 * 3_600_000

/**
 * `databaseHooks.session.create.before`: record the factors on every new session.
 * - **Replacing a session** (one is signed in already: changing the password, turning two-factor on or off) keeps its
 *   factors. Proving a factor while enrolling it never makes a session stronger.
 * - **A passkey** is `passkey`, signed in already or not: a passkey step-up is a new session of the same person.
 * - **Signing in with the password** (`/sign-in/email`): a session survives it only when two-factor is off, or the
 *   device is trusted. Otherwise the two-factor plugin deletes it and asks for the code.
 * - **The verification link** signs in a new account only. The same endpoint confirms a change of email, and that
 *   never signs an existing account in.
 */
export async function recordFactors(session: Session, ctx: GenericEndpointContext | null) {
    const current = ctx?.context.session?.session as Session | undefined
    let factors: Factor[]
    let strongAt: Date | string | null | undefined = null
    if (ctx?.path === "/passkey/verify-authentication") {
        // A passkey proves itself, signed in or not; while signed in it's the same person's (the before hook)
        factors = ["passkey"]
    } else if (current) {
        factors = factorsOf(current.amr)
        strongAt = current.strongAt
    } else if (ctx?.path === "/sign-in/email") {
        const user = (await ctx.context.internalAdapter.findUserById(session.userId)) as { twoFactorEnabled?: boolean } | null
        factors = user?.twoFactorEnabled ? ["pwd", "trusted-device"] : ["pwd"]
    } else if (ctx?.path === "/verify-email") {
        // Only a sign-up's verification signs in: a change of email's links carry a `requestType`
        const purpose = verificationPurpose((ctx.query as { token?: string } | undefined)?.token)
        const user = await ctx.context.internalAdapter.findUserById(session.userId)
        const isNew = !!user && Date.now() - new Date(user.createdAt).getTime() < NEW_ACCOUNT_MS
        factors = !purpose && isNew && !(await hasNotByEmailFactor(ctx, session.userId)) ? ["email-link"] : []
    } else factors = (ctx?.path && SIGNED_IN_AT[ctx.path]) || []
    if ((!current || ctx?.path === "/passkey/verify-authentication") && isNotByEmail(factors)) strongAt = new Date()
    if (!factors.length) console.warn(`[auth] a session was created at ${ctx?.path ?? "(no request)"} with no known factor: it passes no check`)
    return { data: { ...session, amr: factors.join(" "), strongAt } }
}

interface TwoFactorRow {
    id: string
    verified?: boolean | null
    failedVerificationCount?: number | null
    lockedUntil?: Date | string | null
}

/** Consecutive wrong app codes while signed in before the account is locked, and for how long (as the plugin's sign-in) */
const LOCK_AFTER = 10
const LOCK_FOR_MS = 15 * 60_000

const twoFactorOf = (ctx: GenericEndpointContext, userId: string) =>
    ctx.context.adapter.findOne<TwoFactorRow>({ model: "twoFactor", where: [{ field: "userId", value: userId }] })

/** Whether the person has the app (set up) or a passkey: a factor that doesn't depend on the inbox */
export const hasNotByEmailFactor = async (ctx: GenericEndpointContext, userId: string) => {
    if ((await twoFactorOf(ctx, userId))?.verified === true) return true
    return (await ctx.context.adapter.count({ model: "passkey", where: [{ field: "userId", value: userId }] })) > 0
}

/** Who is signing in, between the password and the second factor: the two-factor plugin's own cookie */
async function signingIn(ctx: GenericEndpointContext): Promise<string | undefined> {
    const cookie = ctx.context.createAuthCookie("two_factor")
    const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret)
    if (!identifier) return undefined
    return (await ctx.context.internalAdapter.findVerificationValue(identifier))?.value
}

/** Paths that add or remove a factor, or show the backup codes: guarded by the strongest factor the person has */
const CHANGES_A_FACTOR = new Set([
    "/two-factor/enable",
    "/two-factor/disable",
    "/two-factor/get-totp-uri",
    "/two-factor/generate-backup-codes",
    "/two-factor/view-backup-codes",
    "/passkey/generate-register-options",
    "/passkey/verify-registration",
    "/passkey/delete-passkey"
])

const failed = (returned: unknown) => returned instanceof Error || (returned instanceof Response && !returned.ok)

/**
 * Before each request:
 * - **Changing a factor needs the strongest factor the person has.** Someone who has the app or a passkey can't add,
 *   remove or view one from a session that only proved the inbox. Otherwise taking the inbox would let an attacker
 *   enrol their own app, then step up with it.
 * - **Registering a passkey never signs anyone in** (`createSession` is refused): the new passkey proves nothing yet.
 * - **No emailed code once there's a stronger factor** (D4a): asking for one, or entering one, is refused at sign-in.
 * - **A passkey while signed in steps up the same person only.** Better Auth signs in whoever owns the passkey used, so
 *   on a device holding two people's passkeys, the wrong one would switch accounts mid-action; it's refused. The
 *   weaker session it replaces is ended (`steppingUpFrom`).
 * - **The app code while signed in is how a session steps up** (D1). The plugin doesn't count wrong codes there, so
 *   we do, with the plugin's own lock. Only an app that was set up already counts: proving the code that sets it up
 *   doesn't step up (`enrollingApp`, which the notices read too).
 */
const before = createAuthMiddleware(async ctx => {
    if (CHANGES_A_FACTOR.has(ctx.path)) {
        if (ctx.path === "/passkey/verify-registration" && (ctx.body as { createSession?: boolean } | undefined)?.createSession)
            throw APIError.from("BAD_REQUEST", { message: "A new passkey doesn't sign anyone in", code: "PASSKEY_REGISTRATION_CANNOT_SIGN_IN" })
        const current = await getSessionFromCtx(ctx)
        if (current && !isNotByEmail(factorsOf((current.session as Session).amr)) && (await hasNotByEmailFactor(ctx, current.user.id)))
            throw APIError.from("FORBIDDEN", {
                message: "Confirm it's you with your authenticator app or passkey first",
                code: "STRONGER_FACTOR_REQUIRED"
            })
        return
    }
    if (ctx.path === "/two-factor/send-otp" || ctx.path === "/two-factor/verify-otp") {
        if (await getSessionFromCtx(ctx)) return
        const userId = await signingIn(ctx)
        if (userId && (await hasNotByEmailFactor(ctx, userId)))
            throw APIError.from("FORBIDDEN", {
                message: "Sign in with your authenticator app, a backup code or your passkey",
                code: "EMAILED_CODE_NOT_OFFERED"
            })
        return
    }
    if (ctx.path === "/passkey/verify-authentication") {
        const current = await getSessionFromCtx(ctx)
        if (!current) return
        const credentialID = (ctx.body as { response?: { id?: string } } | undefined)?.response?.id
        const key = credentialID
            ? await ctx.context.adapter.findOne<{ userId: string }>({ model: "passkey", where: [{ field: "credentialID", value: credentialID }] })
            : null
        if (!key || key.userId !== current.user.id)
            throw APIError.from("FORBIDDEN", { message: "That passkey is for another account: use your own", code: "PASSKEY_OF_ANOTHER_ACCOUNT" })
        return { context: { steppingUpFrom: current.session.token } }
    }
    if (ctx.path === "/two-factor/verify-totp") {
        const current = await getSessionFromCtx(ctx)
        if (!current) return
        const row = await twoFactorOf(ctx, current.user.id)
        if (row?.lockedUntil && new Date(row.lockedUntil).getTime() > Date.now())
            throw APIError.from("TOO_MANY_REQUESTS", { message: "Too many wrong codes: try again later", code: "ACCOUNT_TEMPORARILY_LOCKED" })
        if (row?.verified === true) return { context: { stepUpWithApp: true } }
        if (row) return { context: { enrollingApp: true } }
    }
})

/**
 * After the two-factor plugin's own hooks:
 * - **the sign-in's offer** (`twoFactorMethods`) leaves the emailed code out for someone with a stronger factor (D4a);
 * - **a right app code while signed in** adds `totp` to the session and restarts its 12 hours (D15); a wrong one counts
 *   toward the lock;
 * - **turning the app off keeps the emailed code** (D2): the plugin turns two-factor off altogether, so it's turned
 *   back on;
 * - **a passkey step-up** ends the session it replaced.
 */
const after = createAuthMiddleware(async ctx => {
    const returned = ctx.context.returned
    if (ctx.path === "/sign-in/email") {
        const offer = returned as { twoFactorRedirect?: boolean; twoFactorMethods?: string[] } | undefined
        if (!offer?.twoFactorRedirect || !offer.twoFactorMethods?.includes("otp")) return
        const email = (ctx.body as { email?: string } | undefined)?.email
        const user = email ? await ctx.context.internalAdapter.findUserByEmail(email.toLowerCase()) : null
        if (user && (await hasNotByEmailFactor(ctx, user.user.id)))
            return ctx.json({ ...offer, twoFactorMethods: offer.twoFactorMethods.filter(m => m !== "otp") })
        return
    }
    if (ctx.path === "/two-factor/disable") {
        const current = ctx.context.session
        if (current && !failed(returned)) await ctx.context.internalAdapter.updateUser(current.user.id, { twoFactorEnabled: true })
        return
    }
    if (ctx.path === "/passkey/verify-authentication") {
        const from = (ctx as { steppingUpFrom?: string }).steppingUpFrom
        if (from && !failed(returned)) await ctx.context.internalAdapter.deleteSession(from)
        return
    }
    if (ctx.path !== "/two-factor/verify-totp" || !(ctx as { stepUpWithApp?: boolean }).stepUpWithApp) return
    const current = ctx.context.session
    if (!current) return
    const row = await twoFactorOf(ctx, current.user.id)
    if (!row) return
    if (failed(returned)) {
        const count = (row.failedVerificationCount ?? 0) + 1
        await ctx.context.adapter.update({
            model: "twoFactor",
            where: [{ field: "id", value: row.id }],
            update: { failedVerificationCount: count, ...(count >= LOCK_AFTER ? { lockedUntil: new Date(Date.now() + LOCK_FOR_MS) } : {}) }
        })
        return
    }
    const factors = factorsOf((current.session as Session).amr)
    await ctx.context.internalAdapter.updateSession(current.session.token, {
        amr: (factors.includes("totp") ? factors : [...factors, "totp"]).join(" "),
        strongAt: new Date()
    })
    await ctx.context.adapter.update({
        model: "twoFactor",
        where: [{ field: "id", value: row.id }],
        update: { failedVerificationCount: 0, lockedUntil: null }
    })
})

/**
 * `GET /sign-in-method/factors`: what the signed-in person can prove beyond the inbox, so the web app offers the right
 * step-up (the app code, a passkey, or setting one up). Their own account only; it changes nothing.
 */
const factors = createAuthEndpoint("/sign-in-method/factors", { method: "GET", use: [sessionMiddleware] }, async ctx => {
    const userId = ctx.context.session.user.id
    return ctx.json({
        app: (await twoFactorOf(ctx, userId))?.verified === true,
        passkeys: await ctx.context.adapter.count({ model: "passkey", where: [{ field: "userId", value: userId }] })
    })
})

/**
 * The plugin: the session's factors and when a stronger one was last proved, the hooks above, and `factors`. It goes after
 * `twoFactor` in the plugin list, so its after-hooks see the plugin's answer to the sign-in.
 */
export const signInMethod = () =>
    ({
        id: "sign-in-method",
        schema: {
            session: {
                fields: {
                    amr: { type: "string", required: false, input: false },
                    strongAt: { type: "date", required: false, input: false }
                }
            }
        },
        endpoints: { signInFactors: factors },
        hooks: {
            before: [{ matcher: () => true, handler: before }],
            after: [{ matcher: () => true, handler: after }]
        }
    }) satisfies BetterAuthPlugin
