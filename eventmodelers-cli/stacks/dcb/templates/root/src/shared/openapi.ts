/* eslint-disable @typescript-eslint/no-explicit-any */
import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi, type RouteConfig } from "@asteasolutions/zod-to-openapi"
import { z, type ZodTypeAny } from "zod"
import type { ReadModel } from "./readModels.js"

extendZodWithOpenApi(z)

/**
 * The API's OpenAPI document, assembled from the slices (Phase 14.1).
 *
 * Every slice documents its own paths, so `/openapi.json` stays complete as the loop adds slices and a
 * frontend can generate its client from it:
 *
 * - a state-change slice calls `registerCommand` in its `schema.ts`, next to the body schema;
 * - a fold-form read model is documented by `readModelRoute` itself, from the Zod schema of its document:
 *   the keyed GET and every query, at the paths it serves;
 * - a hand-written read route calls `registerRead` in its `schema.ts`.
 *
 * Registrations are keyed by method and path, so registering the same path again (a route configured
 * once per test) replaces it. `buildOpenApiDocument` is called on the first request for `/openapi.json`,
 * after every slice has registered.
 */

const paths = new Map<string, RouteConfig>()

/** Registers (or replaces) one operation. Paths may use Express `:param` form; they're documented as `{param}`. */
export function registerPath(route: RouteConfig): void {
    const path = toOpenApiPath(route.path)
    paths.set(`${route.method} ${path}`, { ...route, path })
}

export function toOpenApiPath(path: string): string {
    return path.replace(/:(\w+)/g, "{$1}")
}

function pathParamsOf(path: string): z.AnyZodObject | undefined {
    const names = [...path.matchAll(/[:{](\w+)}?/g)].map(m => m[1])
    if (names.length === 0) return undefined
    return z.object(Object.fromEntries(names.map(name => [name, z.string()])))
}

// ─── Shared shapes ───────────────────────────────────────────────────────────

export const ProblemDetailsSchema = z
    .object({
        status: z.number().int().openapi({ example: 422 }),
        title: z.string().openapi({ example: "Unprocessable Entity" }),
        detail: z.string().openapi({ example: "Course is full" }),
        type: z.string().optional().openapi({ example: "about:blank" }),
        instance: z.string().optional()
    })
    .openapi("ProblemDetails")

const IdempotencyKeyHeader = z.string().uuid().optional().openapi({
    description: "Client-generated UUID. A replayed request with the same key returns the original response without appending a duplicate event."
})

const ETagResponseHeader = z.string().openapi({
    example: '"5"',
    description: "Sequence position of the last appended event (writes) or the read model's position (async reads). Send it back as If-None-Match with Prefer: wait to read your own write."
})

const ReadHeaders = z.object({
    "If-None-Match": z.string().optional().openapi({
        example: '"5"',
        description: "The ETag of a prior write. With Prefer: wait, the read waits until the read model has processed it."
    }),
    Prefer: z.string().optional().openapi({
        example: "wait=5",
        description: "Wait up to this many seconds for the read model to reach If-None-Match. 504 if it doesn't."
    })
})

export function problemResponse(description: string) {
    return { description, content: { "application/problem+json": { schema: ProblemDetailsSchema } } }
}

// ─── Commands ────────────────────────────────────────────────────────────────

export interface CommandPath {
    method: "post" | "put" | "patch" | "delete"
    /** The route's path, exactly as `route.ts` registers it ("/courses/:courseId/capacity") */
    path: string
    summary: string
    /** The body schema from this `schema.ts`; leave out for a command without a body */
    body?: ZodTypeAny
    /** What the route answers with: `Created({ createdId })`, `Created({ url })` or `NoContent()` */
    success: "createdId" | "createdUrl" | "noContent"
    /** The rejections the slice's specifications name, by status: `{ 422: "Course is full" }` */
    errors?: Partial<Record<404 | 409 | 422, string>>
}

/** Documents a state-change route: body, Idempotency-Key, ETag, 400 on a bad body, and its rejections. */
export function registerCommand(command: CommandPath): void {
    const params = pathParamsOf(command.path)
    const responses: RouteConfig["responses"] = {}
    if (command.success === "createdId") {
        responses[201] = {
            description: "Created",
            headers: z.object({ ETag: ETagResponseHeader }),
            content: { "application/json": { schema: z.object({ id: z.string() }) } }
        }
    } else if (command.success === "createdUrl") {
        responses[201] = { description: "Created", headers: z.object({ ETag: ETagResponseHeader, Location: z.string() }) }
    } else {
        responses[204] = { description: "Done", headers: z.object({ ETag: ETagResponseHeader }) }
    }
    if (command.body) responses[400] = problemResponse("The body failed validation")
    for (const [status, description] of Object.entries(command.errors ?? {})) {
        responses[status] = problemResponse(description!)
    }
    registerPath({
        method: command.method,
        path: command.path,
        summary: command.summary,
        request: {
            ...(params && { params }),
            headers: z.object({ "Idempotency-Key": IdempotencyKeyHeader }),
            ...(command.body && {
                body: { content: { "application/json": { schema: command.body } }, required: true }
            })
        },
        responses
    })
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export interface ReadPath {
    /** The route's path, exactly as `route.ts` registers it ("/students/:studentId") */
    path: string
    summary: string
    /** The response body */
    response: ZodTypeAny
    /** Default "application/json" */
    contentType?: string
    /** Query-string parameters, if the route reads any */
    query?: z.AnyZodObject
    /** 404 detail, for a keyed read */
    notFound?: string
    /** true when the route honours Prefer: wait and sends an ETag (async read models) */
    wait?: boolean
}

/** Documents a hand-written GET route (imperative read models). Fold-form read models don't need it. */
export function registerRead(read: ReadPath): void {
    const params = pathParamsOf(read.path)
    registerPath({
        method: "get",
        path: read.path,
        summary: read.summary,
        request: {
            ...(params && { params }),
            ...(read.query && { query: read.query }),
            ...(read.wait && { headers: ReadHeaders })
        },
        responses: {
            200: {
                description: "OK",
                ...(read.wait && { headers: z.object({ ETag: ETagResponseHeader }) }),
                content: { [read.contentType ?? "application/json"]: { schema: read.response } }
            },
            ...(read.notFound && { 404: problemResponse(read.notFound) }),
            ...(read.wait && { 504: problemResponse("Prefer: wait timed out") })
        }
    })
}

const PARAM_SCHEMAS = { string: () => z.string(), number: () => z.number(), boolean: () => z.boolean() }

/**
 * Documents a fold-form read model at the paths `readModelRoute` serves: the keyed GET (the document, 404
 * for an unknown key) and each query (`{ data, cursor? }` pages, 400 for a bad parameter), ADR-023.
 */
export function registerReadModel(
    readModel: ReadModel<any, any>,
    path: string,
    options: { schema?: ZodTypeAny; summary?: string; notFound?: string; wait: boolean }
): void {
    const schema = options.schema ?? z.record(z.string(), z.unknown()).openapi({ description: `${readModel.name} (undocumented)` })
    registerRead({
        path,
        summary: options.summary ?? `Get ${readModel.name}`,
        response: schema,
        notFound: options.notFound ?? `${readModel.name} not found`,
        wait: options.wait
    })
    for (const [name, query] of Object.entries(readModel.queries ?? {})) {
        if (!query.path) continue
        const inPath = new Set([...query.path.matchAll(/:(\w+)/g)].map(m => m[1]))
        const queryParams = Object.fromEntries(
            Object.entries(query.params)
                .filter(([param]) => !inPath.has(param))
                .map(([param, def]) => {
                    const list = (def.op ?? "eq") === "in"
                    const schema = list ? z.string().openapi({ description: `Comma-separated ${def.type} values` }) : PARAM_SCHEMAS[def.type]()
                    return [param, def.optional ? schema.optional() : schema]
                })
        )
        registerPath({
            method: "get",
            path: query.path,
            summary: `${readModel.name}: ${name}`,
            request: {
                ...(inPath.size > 0 && { params: pathParamsOf(query.path) }),
                query: z.object({
                    ...queryParams,
                    limit: z.number().int().min(1).optional().openapi({ description: "Page size (default 50, max 200)" }),
                    cursor: z.string().optional().openapi({ description: "The cursor of the previous page" })
                }),
                ...(options.wait && { headers: ReadHeaders })
            },
            responses: {
                200: {
                    description: "A page of matching documents, in the query's order",
                    content: {
                        "application/json": {
                            schema: z.object({ data: z.array(schema), cursor: z.string().optional() })
                        }
                    }
                },
                400: problemResponse("A parameter is missing or invalid"),
                ...(options.wait && { 504: problemResponse("Prefer: wait timed out") })
            }
        })
    }
}

// ─── The document ────────────────────────────────────────────────────────────

export function buildOpenApiDocument(info: { title: string; version: string; description?: string }): object {
    const registry = new OpenAPIRegistry()
    registry.register("ProblemDetails", ProblemDetailsSchema)
    const sorted = [...paths.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
    for (const route of sorted) registry.registerPath(route)
    return new OpenApiGeneratorV31(registry.definitions).generateDocument({
        openapi: "3.1.0",
        info,
        servers: [{ url: "/" }]
    })
}
