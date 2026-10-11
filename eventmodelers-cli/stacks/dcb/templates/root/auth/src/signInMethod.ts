import type { GenericEndpointContext } from "@better-auth/core"
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api"

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
 *   email-link      the link that verified the email at sign-up
 *
 * A session created where none of these is known gets no factors, so it passes no check (fail closed).
 */
export type Factor = "pwd" | "email-otp" | "totp" | "backup-code" | "passkey" | "trusted-device" | "email-link"

/** The factors that don't depend on the inbox (D3's `not-by-email`) */
const NOT_BY_EMAIL: readonly Factor[] = ["totp", "backup-code", "passkey"]

export const factorsOf = (amr: unknown): Factor[] =>
    String(amr ?? "")
        .split(" ")
        .filter(Boolean) as Factor[]

export const isNotByEmail = (factors: readonly Factor[]) => factors.some(f => NOT_BY_EMAIL.includes(f))

/** The factors a session created by signing in at `path` has proved; the password came first for the two-factor paths */
const SIGNED_IN_AT: Record<string, Factor[]> = {
    "/two-factor/verify-otp": ["pwd", "email-otp"],
    "/two-factor/verify-totp": ["pwd", "totp"],
    "/two-factor/verify-backup-code": ["pwd", "backup-code"],
    "/passkey/verify-authentication": ["passkey"],
    "/verify-email": ["email-link"]
}

type Session = { userId: string; amr?: string | null } & Record<string, unknown>

/**
 * `databaseHooks.session.create.before`: record the factors on every new session.
 * - **Replacing a session** (one is signed in already: changing the password, turning two-factor on) keeps its
 *   factors. Proving a factor while enrolling it never makes a session stronger.
 * - **Signing in with the password** (`/sign-in/email`): a session survives it only when two-factor is off, or the
 *   device is trusted. Otherwise the two-factor plugin deletes it and asks for the code.
 */
export async function recordFactors(session: Session, ctx: GenericEndpointContext | null) {
    const current = ctx?.context.session?.session as Session | undefined
    let factors: Factor[]
    if (current) factors = factorsOf(current.amr)
    else if (ctx?.path === "/sign-in/email") {
        const user = (await ctx.context.internalAdapter.findUserById(session.userId)) as { twoFactorEnabled?: boolean } | null
        factors = user?.twoFactorEnabled ? ["pwd", "trusted-device"] : ["pwd"]
    } else factors = (ctx?.path && SIGNED_IN_AT[ctx.path]) || []
    if (!factors.length) console.warn(`[auth] a session was created at ${ctx?.path ?? "(no request)"} with no known factor: it passes no check`)
    return { data: { ...session, amr: factors.join(" ") } }
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

const hasNotByEmailFactor = async (ctx: GenericEndpointContext, userId: string) => {
    if ((await twoFactorOf(ctx, userId))?.verified === true) return true
    return (await ctx.context.adapter.count({ model: "passkey", where: [{ field: "userId", value: userId }] })) > 0
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

/**
 * `hooks.before`:
 * - **Changing a factor needs the strongest factor the person has.** Someone who has the app or a passkey can't add,
 *   remove or view one from a session that only proved the inbox. Otherwise taking the inbox would let an attacker
 *   enrol their own app, then step up with it.
 * - **Registering a passkey never signs anyone in** (`createSession` is refused): the new passkey proves nothing yet.
 * - **The app code while signed in is how a session steps up** (D1). The plugin doesn't count wrong codes there, so
 *   we do, with the plugin's own lock. Only an app that was set up already counts: proving the code that sets it up
 *   doesn't step up.
 */
export const beforeHook = createAuthMiddleware(async ctx => {
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
    if (ctx.path === "/two-factor/verify-totp") {
        const current = await getSessionFromCtx(ctx)
        if (!current) return
        const row = await twoFactorOf(ctx, current.user.id)
        if (row?.lockedUntil && new Date(row.lockedUntil).getTime() > Date.now())
            throw APIError.from("TOO_MANY_REQUESTS", { message: "Too many wrong codes: try again later", code: "ACCOUNT_TEMPORARILY_LOCKED" })
        if (row?.verified === true) return { context: { stepUpWithApp: true } }
    }
})

/** `hooks.after`: a right app code while signed in adds `totp` to the session; a wrong one counts toward the lock */
export const afterHook = createAuthMiddleware(async ctx => {
    if (ctx.path !== "/two-factor/verify-totp" || !(ctx as { stepUpWithApp?: boolean }).stepUpWithApp) return
    const current = ctx.context.session
    if (!current) return
    const row = await twoFactorOf(ctx, current.user.id)
    if (!row) return
    const returned = ctx.context.returned
    const failed = returned instanceof Error || (returned instanceof Response && !returned.ok)
    if (failed) {
        const count = (row.failedVerificationCount ?? 0) + 1
        await ctx.context.adapter.update({
            model: "twoFactor",
            where: [{ field: "id", value: row.id }],
            update: { failedVerificationCount: count, ...(count >= LOCK_AFTER ? { lockedUntil: new Date(Date.now() + LOCK_FOR_MS) } : {}) }
        })
        return
    }
    const factors = factorsOf((current.session as Session).amr)
    if (!factors.includes("totp")) await ctx.context.internalAdapter.updateSession(current.session.token, { amr: [...factors, "totp"].join(" ") })
    await ctx.context.adapter.update({
        model: "twoFactor",
        where: [{ field: "id", value: row.id }],
        update: { failedVerificationCount: 0, lockedUntil: null }
    })
})
