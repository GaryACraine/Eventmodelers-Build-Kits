import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose"
import { sendProblem, type WebApiSetup } from "@dcb-es/event-store-express"

/** Express's response, as the library's router types it (the project may resolve another copy of express's types) */
type ApiResponse = Parameters<typeof sendProblem>[0]

/**
 * Who is signed in, checked the one way the API ever checks it (ADR-037, ADR-055): the bearer token the sign-in
 * service issued (Better Auth's JWT plugin), verified against its JWKS for the issuer, the audience, expiry, and a
 * verified email. This is the only code here that knows about sign-in; a route reads the result with
 * `signedInOf(res)`.
 *
 *   - no `Authorization` header → passes through, as before (which routes require sign-in is ADR-055 part 2);
 *   - a valid token → `signedInOf(res)` is `{ sub, email }`;
 *   - a token that fails any check, or sign-in isn't configured → 401, nothing else runs.
 *
 * Configured by `AUTH_ISSUER`, `AUTH_AUDIENCE` (both the sign-in service's BETTER_AUTH_URL by default) and
 * `AUTH_JWKS_URL` (where this service reaches its JWKS, e.g. http://auth:3001/api/auth/jwks inside Compose). The same
 * in our cloud and on-premises. Put it after CORS and before every route in `apis`.
 */
export interface SignedIn {
    /** The sign-in service's permanent id for the person (ADR-037: our own user is linked by it) */
    sub: string
    email: string
}

export interface SignInSettings {
    issuer: string
    audience: string
    jwks: JWTVerifyGetKey
}

/** The settings from the environment, or undefined when sign-in isn't configured (every token is then refused) */
export function signInSettings(env: Record<string, string | undefined> = process.env): SignInSettings | undefined {
    const issuer = env["AUTH_ISSUER"]
    const jwksUrl = env["AUTH_JWKS_URL"]
    if (!issuer || !jwksUrl) return undefined
    return { issuer, audience: env["AUTH_AUDIENCE"] || issuer, jwks: createRemoteJWKSet(new URL(jwksUrl)) }
}

export function configureSignIn(settings: SignInSettings | undefined = signInSettings()): WebApiSetup {
    return router => {
        router.use(async (req, res, next) => {
            const header = req.headers.authorization
            if (!header) return next()
            const token = /^Bearer (\S+)$/i.exec(header)?.[1]
            if (!token) return refuse(res, "The Authorization header isn't a bearer token.")
            if (!settings) return refuse(res, "Sign-in isn't configured on this service (AUTH_ISSUER, AUTH_JWKS_URL).")
            try {
                const { payload } = await jwtVerify(token, settings.jwks, { issuer: settings.issuer, audience: settings.audience })
                if (payload.email_verified !== true) return refuse(res, "The email address isn't verified yet.")
                if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
                    return refuse(res, "The token doesn't say who is signed in.")
                }
                res.locals["signedIn"] = { sub: payload.sub, email: payload.email } satisfies SignedIn
                next()
            } catch {
                refuse(res, "The token is invalid or has expired: sign in again.")
            }
        })
    }
}

/** The person this request was made by, or undefined if it carried no token */
export function signedInOf(res: { locals: Record<string, unknown> }): SignedIn | undefined {
    return res.locals["signedIn"] as SignedIn | undefined
}

function refuse(res: ApiResponse, detail: string): void {
    res.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"')
    sendProblem(res, 401, { type: "about:blank", title: "Unauthorized", status: 401, detail })
}
