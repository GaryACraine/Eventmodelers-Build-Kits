import type { BetterAuthPlugin, GenericEndpointContext } from "@better-auth/core"
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api"
import { createHmac } from "node:crypto"
import type { Email } from "./email.js"

/**
 * What the sign-in service does around a change to an account (ADR-056):
 * - **D5:** changing the password always ends every other session, whatever the form asks;
 * - **D10:** an email to the person when something about their account's security changes, or someone signs in
 *   from a device we haven't seen them use;
 * - **D6:** the old address is told once a change of email has gone through (it confirmed the change first).
 *
 * The reset password notice is sent from `onPasswordReset` (`auth.ts`), which Better Auth calls only on success.
 */

/** A request's outcome: an error, or a redirect to a page that shows one, both count as failed only by status */
const failed = (returned: unknown) => {
    const status =
        returned instanceof Response ? returned.status : returned instanceof Error ? ((returned as { statusCode?: number }).statusCode ?? 500) : 200
    return status >= 400
}

/** The device cookie: which people have signed in on this browser before (keyed digests of their ids) */
const KNOWN_DEVICE = "known_device"
const KNOWN_DEVICE_MAX_AGE = 400 * 24 * 3600

/** Sign-ins that create a session from nothing, so a device can be new to the person */
const SIGN_INS = new Set([
    "/sign-in/email",
    "/two-factor/verify-otp",
    "/two-factor/verify-totp",
    "/two-factor/verify-backup-code",
    "/passkey/verify-authentication",
    "/verify-email"
])

/** What changed, by the path that changed it, for the notice */
const NOTICES: Record<string, { subject: string; text: string }> = {
    "/change-password": {
        subject: "Your password was changed",
        text: "The password for your account was changed, and every other session was signed out."
    },
    "/two-factor/disable": {
        subject: "Your authenticator app was removed",
        text: "Your authenticator app no longer signs you in. Signing in now needs a code sent to this address."
    },
    "/two-factor/generate-backup-codes": {
        subject: "New backup codes were made",
        text: "New backup codes were made for your account. The old ones no longer work."
    },
    "/two-factor/verify-backup-code": {
        subject: "A backup code was used",
        text: "One of your backup codes was used to sign in. Each code works once."
    },
    "/passkey/verify-registration": { subject: "A passkey was added", text: "A passkey was added to your account." },
    "/passkey/delete-passkey": { subject: "A passkey was removed", text: "A passkey was removed from your account." }
}

const IF_NOT_YOU =
    "\n\nIf this wasn't you, reset your password now and remove any authenticator app or passkey you don't recognise."

/** The payload of Better Auth's email-verification token (a JWT): read, not trusted, to know what to check after */
function tokenPayload(token: unknown): { email?: string; updateTo?: string; requestType?: string } {
    try {
        return JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString())
    } catch {
        return {}
    }
}

export const accountChanges = ({ send, secret }: { send: (email: Email) => void; secret: string }) => {
    const deviceMark = (userId: string) => createHmac("sha256", secret).update(`known-device:${userId}`).digest("base64url").slice(0, 16)

    async function rememberDevice(ctx: GenericEndpointContext, userId: string): Promise<boolean> {
        const cookie = ctx.context.createAuthCookie(KNOWN_DEVICE, { maxAge: KNOWN_DEVICE_MAX_AGE })
        const marks = ((await ctx.getSignedCookie(cookie.name, ctx.context.secret)) || "").split(" ").filter(Boolean)
        const mark = deviceMark(userId)
        const known = marks.includes(mark)
        const kept = [mark, ...marks.filter(m => m !== mark)].slice(0, 10)
        await ctx.setSignedCookie(cookie.name, kept.join(" "), ctx.context.secret, cookie.attributes)
        return known
    }

    const before = createAuthMiddleware(async ctx => {
        if (ctx.path === "/change-password")
            return { context: { body: { ...(ctx.body as object), revokeOtherSessions: true } } }
        if (ctx.path === "/verify-email") {
            const payload = tokenPayload((ctx.query as { token?: string } | undefined)?.token)
            if (payload.requestType === "change-email-verification" && payload.email && payload.updateTo)
                return { context: { emailChange: { from: payload.email, to: payload.updateTo } } }
        }
        if (ctx.path in NOTICES && !ctx.context.session) await getSessionFromCtx(ctx)
    })

    const after = createAuthMiddleware(async ctx => {
        const returned = ctx.context.returned
        if (failed(returned)) return

        const change = (ctx as { emailChange?: { from: string; to: string } }).emailChange
        if (change) {
            // Checked by its effect: verification answers a failure with a redirect too
            const moved = await ctx.context.internalAdapter.findUserByEmail(change.to)
            if (moved && !(await ctx.context.internalAdapter.findUserByEmail(change.from)))
                send({
                    to: change.from,
                    subject: "Your email address was changed",
                    text: `Your account's email address was changed to ${change.to}. Sign-in emails go there from now on.${IF_NOT_YOU}`
                })
        }

        const signedIn = ctx.context.newSession
        if (SIGN_INS.has(ctx.path) && signedIn) {
            const known = await rememberDevice(ctx, signedIn.user.id)
            // The verification link is the account's first sign-in: its device is the first one, not a new one
            if (!known && ctx.path !== "/verify-email") {
                const agent = ctx.headers?.get("user-agent") || "an unknown browser"
                send({
                    to: signedIn.user.email,
                    subject: "A new sign-in to your account",
                    text: `Someone signed in to your account from a device we haven't seen you use before (${agent}), at ${new Date().toUTCString()}.${IF_NOT_YOU}`
                })
            }
        }

        const notice = NOTICES[ctx.path]
        if (notice && ctx.path !== "/two-factor/verify-backup-code") {
            const user = ctx.context.session?.user
            if (user) send({ to: user.email, subject: notice.subject, text: notice.text + IF_NOT_YOU })
        }
        if (ctx.path === "/two-factor/verify-backup-code") {
            const user = signedIn?.user ?? ctx.context.session?.user
            if (user) send({ to: user.email, subject: notice!.subject, text: notice!.text + IF_NOT_YOU })
        }
        if (ctx.path === "/two-factor/verify-totp" && (ctx as { enrollingApp?: boolean }).enrollingApp) {
            const user = ctx.context.session?.user
            if (user)
                send({
                    to: user.email,
                    subject: "An authenticator app was set up",
                    text: `An authenticator app now signs you in to your account, and the emailed code is no longer offered.${IF_NOT_YOU}`
                })
        }
    })

    return {
        id: "account-changes",
        hooks: {
            before: [{ matcher: () => true, handler: before }],
            after: [{ matcher: () => true, handler: after }]
        }
    } satisfies BetterAuthPlugin
}
