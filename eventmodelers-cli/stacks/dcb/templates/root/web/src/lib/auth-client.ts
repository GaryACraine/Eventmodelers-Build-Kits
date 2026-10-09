import { createAuthClient } from "better-auth/react"
import { jwtClient } from "better-auth/client/plugins"

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

export const authClient = createAuthClient({
    baseURL: globalThis.location?.origin,
    plugins: [jwtClient()]
})

/**
 * Every call to the sign-in service, through one plain object of ours: the session, the API client and the screens
 * (the provider-better-auth skill) use it, never `authClient` directly. Tests replace its methods with `vi.spyOn`
 * (Better Auth's client is a Proxy, which can't be spied on). Each is a call from Better Auth's docs.
 */
export const signInService = {
    useSession: () => authClient.useSession(),
    /** docs/authentication/email-password: `name` is required; `callbackURL` is where the verification link lands */
    signUpWithEmail: (input: { name: string; email: string; password: string; callbackURL?: string }) => authClient.signUp.email(input),
    signInWithEmail: (email: string, password: string) => authClient.signIn.email({ email, password }),
    signOut: () => authClient.signOut(),
    token: () => authClient.token()
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
