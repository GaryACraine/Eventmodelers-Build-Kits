import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose"
import { sendProblem, type WebApiSetup } from "@dcb-es/event-store-express"
import { decide, meets, roleMap as roleMapFromFile, type RoleLookup, type RoleMap, type SignInLevel } from "./permissions.js"

/** Express's response, as the library's router types it (the project may resolve another copy of express's types) */
type ApiResponse = Parameters<typeof sendProblem>[0]

/**
 * Who is signed in, checked the one way the API ever checks it (ADR-037, ADR-055): the bearer token the sign-in
 * service issued (Better Auth's JWT plugin), verified against its JWKS for the issuer, the audience, expiry, and a
 * verified email. This is the only code here that knows about sign-in; a route reads the result with
 * `signedInOf(res)`.
 *
 *   - no `Authorization` header → passes through: a route says who may call it (ADR-058 point 1), with
 *     `requirePermission` (a permission), `requireSession` (self: the signed-in person's own values), or nothing
 *     (anonymous). A command or read model the model doesn't declare has no route at all;
 *   - a valid token → `signedInOf(res)` is `{ sub, email }`;
 *   - a token that fails any check, or sign-in isn't configured → 401, nothing else runs.
 *
 * **The signed-in person's values** (ADR-055 part 2): a field the model maps `session:<key>` never comes from the
 * body, the path or the query string. A route lists the keys it needs, `requireSession(["sub", "email"])`, and reads
 * them with `sessionOf(req)`. `sub` and `email` are the token's; any other key (`userId`) comes from the **session
 * lookup**, the read model the model marks `--session-lookup`, which `index.ts` passes to `configureSignIn`.
 *
 * **Permissions** (ADR-060): `roles` is the project's `RoleLookup` (the caller's roles, from its read models), and the
 * role map is `api/roles.json` (tests pass `roleMap`). Without either, every permission route answers 403.
 *
 * **How strongly the person signed in** (ADR-056): the token's `amr` lists the factors the session proved. Every
 * route that needs someone signed in needs a second factor (D2), and a role may need more (D3, the role map's
 * `signIn`). When the session falls short, the answer is **401 with `WWW-Authenticate: Bearer
 * error="insufficient_user_authentication"`** (RFC 9470, step-up) and the level needed (`acr_values`, and `signIn` in
 * the body). The web app then asks for the stronger factor and retries.
 *
 * Configured by `AUTH_ISSUER`, `AUTH_AUDIENCE` (both the sign-in service's BETTER_AUTH_URL by default) and
 * `AUTH_JWKS_URL` (where this service reaches its JWKS, e.g. http://auth:3001/api/auth/jwks inside Compose). The same
 * in our cloud and on-premises. Put it after CORS and before every route in `apis`.
 */
export interface SignedIn {
    /** The sign-in service's permanent id for the person (ADR-037: our own user is linked by it) */
    sub: string
    email: string
    /** The factors this session proved (the token's `amr`), e.g. ["pwd", "email-otp"]; none when the token has none */
    amr: string[]
}

/** The signed-in person's values a route asked for: `sub`, `email`, and any looked-up key (`userId`) */
export type Session = Record<string, string>

/** The session lookup: the person's other session keys (`userId`), from their `sub`; undefined if unknown (not registered) */
export type SessionLookup = (sub: string) => Promise<Session | undefined>

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

export function configureSignIn({
    settings = signInSettings(),
    lookup,
    roles,
    roleMap
}: { settings?: SignInSettings; lookup?: SessionLookup; roles?: RoleLookup; roleMap?: RoleMap } = {}): WebApiSetup {
    return router => {
        router.use(async (req, res, next) => {
            if (lookup) res.locals["sessionLookup"] = lookup
            if (roles) res.locals["roleLookup"] = roles
            if (roleMap) res.locals["roleMap"] = roleMap
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
                const amr = Array.isArray(payload["amr"]) ? payload["amr"].filter((f): f is string => typeof f === "string") : []
                res.locals["signedIn"] = { sub: payload.sub, email: payload.email, amr } satisfies SignedIn
                next()
            } catch {
                refuse(res, "The token is invalid or has expired: sign in again.")
            }
        })
    }
}

const sessions = new WeakMap<object, Session>()

/**
 * Route middleware for a route that uses the signed-in person's values: 401 without a valid token, or a step-up when
 * the session proved no second factor (ADR-056 D2); 403 when a key the token doesn't hold isn't in the session lookup
 * (signed up, not registered yet). Then `sessionOf(req)` has them.
 *
 *   router.post("/activate-organisation", requireSession(["userId"]), validateBody(Schema), on(async req => {
 *       const { userId } = sessionOf(req)
 */
export function requireSession(keys: string[]) {
    return async (req: object, res: ApiResponse, next: () => void): Promise<void> => {
        const signedIn = signedInOf(res)
        if (!signedIn) return refuse(res, "Sign in first.")
        if (!meets(signedIn.amr, "second-factor")) return stepUp(res, "second-factor")
        const session: Session = { sub: signedIn.sub, email: signedIn.email }
        if (keys.some(key => !(key in session))) {
            const lookup = res.locals["sessionLookup"] as SessionLookup | undefined
            const found = lookup ? await lookup(signedIn.sub) : undefined
            const missing = keys.filter(key => !(key in session) && !found?.[key])
            if (missing.length > 0) {
                return sendProblem(res, 403, {
                    type: "about:blank",
                    title: "Forbidden",
                    status: 403,
                    detail: `Register first: there's no ${missing.join(", ")} for the signed-in person yet.`
                })
            }
            // Only what the token doesn't say: the token's `sub` and `email` are the sign-in service's now, and the
            // lookup's copy can be older (an email just changed, not yet recorded here)
            for (const [key, value] of Object.entries(found ?? {})) if (!(key in session)) session[key] = value
        }
        sessions.set(req, session)
        next()
    }
}

/**
 * Route middleware for an endpoint the model declares with a permission (`--api <resource:action>`, ADR-058,
 * ADR-060). Give it the session keys the route also uses, as for `requireSession`.
 *
 *   router.post("/assign-seat", requirePermission("seat:assign"), validateBody(Schema), on(async req => { … }))
 *   readModelRoute(seatList, deps.readModels!, "/seat-list/:organisationId", { schema, guard: requirePermission("seat:read") })
 *
 * - 401 when nobody is signed in (and 403 "register first" for a missing session key, as `requireSession`);
 * - allowed when a platform role the caller holds has the permission;
 * - otherwise the organisation is the role map's tenant key (`organisationId`) in the path, else the body:
 *   **404** when the caller holds no role there (it doesn't reveal that the organisation exists), **403** when they
 *   hold one without the permission;
 * - **401, step up** (RFC 9470) when a role that holds it needs a stronger sign-in than this session's (ADR-056 D3:
 *   an owner needs the app or a passkey).
 * Put it where the path's parameters are known (on the route, or readModelRoute's `guard`), never `router.use`.
 */
export function requirePermission(permission: string, keys: string[] = []) {
    const signedIn = requireSession(keys)
    return async (req: object, res: ApiResponse, next: () => void): Promise<void> => {
        await signedIn(req, res, async () => {
            const who = signedInOf(res)!
            const map = (res.locals["roleMap"] as RoleMap | undefined) ?? roleMapFromFile()
            const rolesOf = res.locals["roleLookup"] as RoleLookup | undefined
            if (!map || !rolesOf) {
                return sendProblem(res, 403, {
                    type: "about:blank",
                    title: "Forbidden",
                    status: 403,
                    detail: "Permissions aren't configured on this service (the role map and the caller's roles)."
                })
            }
            const lookup = res.locals["sessionLookup"] as SessionLookup | undefined
            const session: Session = { sub: who.sub, email: who.email, ...((lookup && (await lookup(who.sub))) ?? {}) }
            const request = req as { params?: Record<string, unknown>; body?: Record<string, unknown> }
            const named = request.params?.[map.tenantKey] ?? request.body?.[map.tenantKey]
            const tenant = typeof named === "string" ? named : undefined
            const decision = decide(map, await rolesOf({ sub: who.sub, email: who.email, session }, tenant), permission, who.amr, tenant)
            if (decision === "allow") return next()
            if (typeof decision === "object") return stepUp(res, decision.stepUp)
            if (decision === "not-found") {
                return sendProblem(res, 404, { type: "about:blank", title: "Not Found", status: 404, detail: "Not found." })
            }
            sendProblem(res, 403, {
                type: "about:blank",
                title: "Forbidden",
                status: 403,
                detail: `You don't have the permission ${permission}${tenant ? " in this organisation" : ""}.`
            })
        })
    }
}

/** The signed-in person's values a route asked for with `requireSession` (empty without it) */
export function sessionOf(req: object): Session {
    return sessions.get(req) ?? {}
}

/**
 * A session lookup from the read model marked `--session-lookup` (keyed by `sub`): its document's other fields, as
 * strings. Make that read model inline-projected, so it's current as soon as registration returns.
 *
 *   configureSignIn({ lookup: readModelLookup(readModelRuntime.reader(myAccount)) })
 */
export function readModelLookup(read: (sub: string) => Promise<Record<string, unknown> | null>): SessionLookup {
    return async sub => {
        const doc = await read(sub)
        if (!doc) return undefined
        return Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]))
    }
}

/** The person this request was made by, or undefined if it carried no token */
export function signedInOf(res: { locals: Record<string, unknown> }): SignedIn | undefined {
    return res.locals["signedIn"] as SignedIn | undefined
}

const STEP_UP: Record<SignInLevel, string> = {
    "second-factor": "Confirm it's you with a second factor: sign in again.",
    "not-by-email": "Confirm it's you with your authenticator app or passkey."
}

/** 401 asking for a stronger sign-in (RFC 9470): the level needed is `acr_values`, and `signIn` in the body */
function stepUp(res: ApiResponse, level: SignInLevel): void {
    res.setHeader("WWW-Authenticate", `Bearer error="insufficient_user_authentication", error_description="${STEP_UP[level]}", acr_values="${level}"`)
    sendProblem(res, 401, { type: "about:blank", title: "Unauthorized", status: 401, detail: STEP_UP[level], signIn: level })
}

function refuse(res: ApiResponse, detail: string): void {
    res.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"')
    sendProblem(res, 401, { type: "about:blank", title: "Unauthorized", status: 401, detail })
}
