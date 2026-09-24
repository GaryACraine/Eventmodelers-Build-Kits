import createClient, { type Middleware } from "openapi-fetch"
import type { paths } from "./api-types"

/**
 * The only place that talks to the backend. Components never call `fetch`: they call `api` (typed from
 * /openapi.json by `npm run gen:api`) and pass the result through `command` or `read`.
 *
 *   const { position } = await command(api.POST("/courses/{courseId}/subscriptions", { params, body }))
 *   const course = await read(api.GET("/courses/{courseId}", { params, headers: afterWrite(position) }))
 *
 * In mock mode (`npm run dev:mock`, and in tests) MSW answers these same requests from src/mocks/handlers.ts.
 */

/** The backend's origin: VITE_API_BASE, or this page's own origin (a proxy, or the backend serving web/dist). */
export const API_BASE: string = import.meta.env.VITE_API_BASE || globalThis.location?.origin || ""

/** The full URL of an API path, for MSW handlers: `http.get(apiUrl("/courses/:courseId"), …)`. */
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

// `fetch` is looked up per request, so MSW (mock mode, tests) can intercept it after the client is created.
export const api = createClient<paths>({ baseUrl: API_BASE, fetch: (request) => globalThis.fetch(request) })
api.use(idempotency)

/** A rejected request: the backend's Problem-JSON (`title`, `detail`: a rejection's message) and the status. */
export class ApiError extends Error {
    readonly status: number
    readonly problem: Problem | undefined

    constructor(status: number, problem: Problem | undefined) {
        super(problem?.detail ?? problem?.title ?? `Request failed with status ${status}`)
        this.name = "ApiError"
        this.status = status
        this.problem = problem
    }
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
    if (!response.ok) throw new ApiError(response.status, error as Problem | undefined)
    return { data, position: positionOf(response) }
}

/** Read a view or query. Resolves with its body; throws `ApiError` on any non-2xx status (404 included). */
export async function read<T>(request: Promise<Result<T>>): Promise<T> {
    const { data, error, response } = await request
    if (!response.ok) throw new ApiError(response.status, error as Problem | undefined)
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
