import createClient, { type Middleware } from "openapi-fetch"
import type { paths } from "./api-types"
import { bearerToken, forgetBearerToken, signInMode } from "./auth-client"

/**
 * The only place that talks to the backend. Components never call `fetch`: they call `api` (typed from the API
 * contract, api/openapi.json, by `npm run gen:api`) and pass the result through `command` or `read`.
 *
 *   const { position } = await command(api.POST("/subscribe-student", { body }))
 *   const course = await read(api.GET("/course-details/{courseId}", { params, headers: afterWrite(position) }))
 *
 * API paths are named after the model (ADR-025) and have nothing to do with the app's page routes.
 *
 * In mock mode (`npm run dev:mock`, and in tests) MSW answers these same requests from src/mocks/handlers.ts.
 */

/** The backend's origin: VITE_API_BASE, or this page's own origin (a proxy, or the backend serving web/dist). */
export const API_BASE: string = import.meta.env.VITE_API_BASE || globalThis.location?.origin || ""

/** The full URL of an API path, for MSW handlers: `http.get(apiUrl("/course-details/:courseId"), …)`. */
export const apiUrl = (path: string): string => `${API_BASE}${path}`

/** Every mutation carries an Idempotency-Key, so a retried request isn't applied twice. */
const idempotency: Middleware = {
    onRequest({ request }) {
        if (request.method !== "GET" && !request.headers.has("Idempotency-Key")) {
            request.headers.set("Idempotency-Key", crypto.randomUUID())
        }
        return request
    }
}

/** How strongly the API asked the caller to sign in (ADR-056 D3): its `acr_values` */
export type StepUpLevel = "second-factor" | "not-by-email"

/**
 * The level a 401 asks for, when it's a step-up (RFC 9470: `WWW-Authenticate: Bearer
 * error="insufficient_user_authentication", acr_values="…"`), or undefined when it's a plain "not signed in".
 */
export function stepUpLevelOf(response: Response): StepUpLevel | undefined {
    if (response.status !== 401) return undefined
    const challenge = response.headers.get("WWW-Authenticate") ?? ""
    if (!challenge.includes('error="insufficient_user_authentication"')) return undefined
    return challenge.includes('acr_values="not-by-email"') ? "not-by-email" : "second-factor"
}

/** Asks the person to sign in more strongly, resolving true once they have (`StepUpProvider`, step-up.tsx) */
export type StepUpPrompt = (level: StepUpLevel) => Promise<boolean>
let stepUpPrompt: StepUpPrompt | undefined

/** Set the prompt the API client shows on a step-up; returns the way to take it away again */
export function onStepUp(prompt: StepUpPrompt): () => void {
    stepUpPrompt = prompt
    return () => {
        if (stepUpPrompt === prompt) stepUpPrompt = undefined
    }
}

/** A copy of each request as it was sent, to send again after a step-up (fetch reads the body of the original) */
const sent = new WeakMap<Request, Request>()

/**
 * With real sign-in, every request carries the signed-in person's bearer token, which the API checks (ADR-037,
 * ADR-055). A 401 drops the kept token, so the next request fetches a fresh one.
 *
 * A 401 that asks for a stronger sign-in (step-up, ADR-056 D1) shows the prompt; once the person has proved the app or
 * a passkey, the same request goes again with a fresh token, its Idempotency-Key unchanged. If they don't, the 401
 * stands (`ApiError.stepUp` says why).
 */
const signedIn: Middleware = {
    async onRequest({ request }) {
        if (signInMode === "better-auth" && !request.headers.has("Authorization")) {
            const token = await bearerToken()
            if (token) request.headers.set("Authorization", `Bearer ${token}`)
        }
        // Kept with real sign-in, or whenever a prompt is set: a page's first requests can go out before StepUpProvider
        // has set its prompt, and the prompt is only needed once the answer comes back
        if (signInMode === "better-auth" || stepUpPrompt) sent.set(request, request.clone())
        return request
    },
    async onResponse({ request, response }) {
        if (response.status !== 401) return response
        forgetBearerToken()
        const level = stepUpLevelOf(response)
        const again = sent.get(request)
        if (!level || !again || !stepUpPrompt || !(await stepUpPrompt(level))) return response
        if (signInMode === "better-auth") {
            // The new session's token; never the weaker one the request was refused with
            const token = await bearerToken()
            if (token) again.headers.set("Authorization", `Bearer ${token}`)
            else again.headers.delete("Authorization")
        }
        const retried = await globalThis.fetch(again)
        if (retried.status === 401) forgetBearerToken()
        return retried
    }
}

// `fetch` is looked up per request, so MSW (mock mode, tests) can intercept it after the client is created.
export const api = createClient<paths>({ baseUrl: API_BASE, fetch: (request) => globalThis.fetch(request) })
api.use(idempotency, signedIn)

/** A rejected request: the backend's Problem-JSON (`title`, `detail`: a rejection's message) and the status. */
/** What a read shows when its read model is still catching up with the person's last change (a 504) */
export const STILL_UPDATING = "Still updating: your last change will show in a moment. Refresh if it doesn't."

export class ApiError extends Error {
    readonly status: number
    readonly problem: Problem | undefined
    /** A 401 asking for a stronger sign-in that the person didn't give: the level it asked for */
    readonly stepUp: StepUpLevel | undefined
    /**
     * A 504: a read waiting for its read model to catch up with the last write (`afterWrite`, ADR-013) ran out of time.
     * Not a failure: the change is recorded, and the read model shows it once it has caught up.
     */
    readonly stillUpdating: boolean

    constructor(status: number, problem: Problem | undefined, stepUp?: StepUpLevel) {
        super(status === 504 ? STILL_UPDATING : (problem?.detail ?? problem?.title ?? `Request failed with status ${status}`))
        this.name = "ApiError"
        this.status = status
        this.problem = problem
        this.stepUp = stepUp
        this.stillUpdating = status === 504
    }
}

/**
 * Whether a failed read is tried again (TanStack Query's `retry`): a read model still catching up with the last write
 * (`stillUpdating`) up to 5 more times, each waiting again, so it's shown as soon as it has caught up and never as an
 * error before then; any other 5xx or a network error once; a refusal (4xx) never, since it would be refused again.
 */
export function retryRead(failures: number, error: Error): boolean {
    if (error instanceof ApiError && error.stillUpdating) return failures < 5
    return !(error instanceof ApiError && error.status < 500) && failures < 1
}

export interface Problem {
    type?: string
    title?: string
    status?: number
    detail?: string
    [key: string]: unknown
}

interface Result<T> {
    data?: T
    error?: unknown
    response: Response
}

/**
 * The event store position a write reached (the command's `ETag`), or undefined if it sent none.
 * Pass it to `afterWrite` to read that write back from an async read model.
 */
export function positionOf(response: Response): string | undefined {
    const etag = response.headers.get("ETag")
    return etag ? etag.replace(/^W\//, "").replace(/^"(.*)"$/, "$1") : undefined
}

/** Send a command. Resolves with its response body and the position it reached; throws `ApiError` if rejected. */
export async function command<T>(request: Promise<Result<T>>): Promise<{ data: T | undefined; position: string | undefined }> {
    const { data, error, response } = await request
    if (!response.ok) throw new ApiError(response.status, error as Problem | undefined, stepUpLevelOf(response))
    return { data, position: positionOf(response) }
}

/** Read a view or query. Resolves with its body; throws `ApiError` on any non-2xx status (404 included). */
export async function read<T>(request: Promise<Result<T>>): Promise<T> {
    const { data, error, response } = await request
    if (!response.ok) throw new ApiError(response.status, error as Problem | undefined, stepUpLevelOf(response))
    return data as T
}

/**
 * Read-your-writes, for **async (`database-projected`) read models only**: the headers that make the read wait
 * until the read model has caught up with `position` (the position `command` returned), up to `seconds`.
 *
 * An `inline-projected` or `live-report` read model is already current when the command returns, so don't send
 * these to one: it has no wait to do, and an `If-None-Match` it doesn't consume can turn the read into a 304.
 * Undefined `position` → no headers, so it's safe to pass straight through.
 */
export function afterWrite(position: string | undefined, seconds = 5): Record<string, string> {
    if (!position) return {}
    return { "If-None-Match": `"${position}"`, Prefer: `wait=${seconds}` }
}
