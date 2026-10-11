import { createAuthClient } from "better-auth/react"
import { jwtClient, twoFactorClient } from "better-auth/client/plugins"
import { passkeyClient } from "@better-auth/passkey/client"

/**
 * Sign-in (ADR-055): Better Auth's client (better-auth.com/docs/concepts/client) with its JWT plugin
 * (docs/plugins/jwt). It talks to the sign-in service at this page's own origin, `/api/auth` (Vite proxies it
 * locally; a reverse proxy or CloudFront does when deployed), so its session cookie is first-party.
 *
 * `VITE_SIGN_IN=better-auth` turns real sign-in on. Until then (and in mock mode and the tests) the session is the
 * stub in session.tsx, which asks for the IDs: switch it on once the project's Sign Up screen is built.
 */
export type SignInMode = "stub" | "better-auth"

export const signInMode: SignInMode =
    import.meta.env.VITE_SIGN_IN === "better-auth" && import.meta.env.VITE_DATA_MODE !== "mock" ? "better-auth" : "stub"

/** Seconds the sign-in service said to wait, from the last 429 (its `X-Retry-After`) */
let retryAfter: number | undefined

export const authClient = createAuthClient({
    baseURL: globalThis.location?.origin,
    // The two-factor plugin's client never redirects here: the sign-in form asks for the code itself
    plugins: [jwtClient(), twoFactorClient(), passkeyClient()],
    fetchOptions: {
        onError: ({ response }) => {
            if (response.status === 429) retryAfter = Number(response.headers.get("X-Retry-After")) || undefined
        }
    }
})

/** What a refused call to the sign-in service returns (`{ error }`) */
export interface ServiceError {
    status: number
    message?: string
    code?: string
}

/**
 * What to tell the person about a refused call: "too many attempts" with the wait (D11), or the service's message.
 * `fallback` when it gave none.
 */
export function messageOf(error: ServiceError, fallback: string): string {
    if (error.status === 429) {
        const minutes = retryAfter ? Math.ceil(retryAfter / 60) : undefined
        return minutes ? `Too many attempts: try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` : "Too many attempts: try again in a few minutes."
    }
    return error.message || fallback
}

/** The second factors a sign-in with the password can ask for: the emailed code, the app's code (D2, D4a) */
export type SecondFactorMethod = "otp" | "totp"

/** The pages the sign-in service's links land on (a path on this site) */
export const RESET_PASSWORD_PAGE = "/reset-password"
/** The project's page an email change lands on, if it has one (routes.tsx passes it when a page has this path) */
export const EMAIL_CHANGED_PAGE = "/email-changed"

/**
 * Every call to the sign-in service, through one plain object of ours: the session, the API client and the screens
 * (the provider-better-auth skill) use it, never `authClient` directly. Tests replace its methods with `vi.spyOn`
 * (Better Auth's client is a Proxy, which can't be spied on). Each is a call from Better Auth's docs.
 */
export const signInService = {
    useSession: () => authClient.useSession(),
    /** docs/authentication/email-password: `name` is required; `callbackURL` is where the verification link lands */
    signUpWithEmail: (input: { name: string; email: string; password: string; callbackURL?: string }) => authClient.signUp.email(input),
    /**
     * With a second factor on (everyone, ADR-056 D2), `data` is `{ twoFactorRedirect, twoFactorMethods }` unless this
     * device is trusted. The emailed code isn't offered to someone with the app or a passkey (D4a)
     */
    signInWithEmail: (email: string, password: string) => authClient.signIn.email({ email, password }),
    /** The verification link again: from "check your email" and the expired-link notice (D12) */
    sendVerificationEmail: (email: string, callbackURL?: string) => authClient.sendVerificationEmail({ email, callbackURL }),
    signOut: () => authClient.signOut(),
    token: () => authClient.token(),

    // The second factor (docs/plugins/2fa): at sign-in, or while signed in for the app's code (a step-up)
    sendCode: () => authClient.twoFactor.sendOtp(),
    verifyCode: (code: string, trustDevice: boolean) => authClient.twoFactor.verifyOtp({ code, trustDevice }),
    verifyAppCode: (code: string, trustDevice = false) => authClient.twoFactor.verifyTotp({ code, trustDevice }),
    verifyBackupCode: (code: string, trustDevice: boolean) => authClient.twoFactor.verifyBackupCode({ code, trustDevice }),
    /** Starts setting up the app: its `totpURI` (the QR code) and the backup codes. Its first code finishes it */
    setUpApp: (password: string) => authClient.twoFactor.enable({ password }),
    /** Removes the app; the emailed code stays on (D2) */
    removeApp: (password: string) => authClient.twoFactor.disable({ password }),
    newBackupCodes: (password: string) => authClient.twoFactor.generateBackupCodes({ password }),
    /** What the person can prove beyond the inbox: the app (set up) and how many passkeys (`signInMethod.ts`) */
    factors: () => authClient.$fetch<{ app: boolean; passkeys: number }>("/sign-in-method/factors", { method: "GET" }),

    // Passkeys (docs/plugins/passkey)
    signInWithPasskey: () => authClient.signIn.passkey(),
    addPasskey: (name?: string) => authClient.passkey.addPasskey({ name }),
    listPasskeys: () => authClient.passkey.listUserPasskeys(),
    removePasskey: (id: string) => authClient.passkey.deletePasskey({ id }),

    // Forgotten password (D4): the same answer whether or not the account exists
    requestPasswordReset: (email: string) => authClient.requestPasswordReset({ email, redirectTo: RESET_PASSWORD_PAGE }),
    resetPassword: (token: string, newPassword: string) => authClient.resetPassword({ token, newPassword }),

    // The account page (D5, D6, D9)
    changePassword: (currentPassword: string, newPassword: string) =>
        authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: true }),
    /** Confirmed at the current address, then verified at the new one; both links land on `callbackURL` */
    changeEmail: (newEmail: string, callbackURL: string) => authClient.changeEmail({ newEmail, callbackURL }),
    listSessions: () => authClient.listSessions(),
    signOutEverywhereElse: () => authClient.revokeOtherSessions()
}

let cached: { token: string; expiresAt: number } | undefined

/**
 * The bearer token our API checks (ADR-037), from `authClient.token()` (the JWT docs' recommended way). It lasts
 * 15 minutes; it's kept until a minute before it expires, so most requests don't ask for a new one. Undefined
 * when no one is signed in.
 */
export async function bearerToken(now = Date.now()): Promise<string | undefined> {
    if (cached && cached.expiresAt - 60_000 > now) return cached.token
    const { data } = await signInService.token()
    if (!data?.token) {
        cached = undefined
        return undefined
    }
    cached = { token: data.token, expiresAt: expiryOf(data.token) }
    return cached.token
}

/** Drop the kept token: on signing out, or when the API refuses it */
export function forgetBearerToken(): void {
    cached = undefined
}

/** A JWT's `exp`, in milliseconds (0 if it can't be read, so it's fetched again next time) */
function expiryOf(token: string): number {
    try {
        const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number }
        return (payload.exp ?? 0) * 1000
    } catch {
        return 0
    }
}
