import { describe, test, expect } from "vitest"
import supertest from "supertest"
import { z } from "zod"
import { getApplication } from "@dcb-es/event-store-express"
import { buildOpenApiDocument, registerCommand, registerRead, registerReadModel } from "./openapi.js"
import { defineReadModel } from "./readModels.js"
import { configureCors } from "./cors.js"

/* eslint-disable @typescript-eslint/no-explicit-any */
const doc = (): any => buildOpenApiDocument({ title: "test", version: "1" })

describe("OpenAPI registry", () => {
    test("a command documents its body, path parameters, success and rejections", () => {
        const Body = z.object({ newCapacity: z.number().int() }).openapi("OaChangeCapacityBody")
        registerCommand({
            method: "put",
            path: "/oa/courses/:courseId/capacity",
            summary: "Change capacity",
            body: Body,
            success: "noContent",
            errors: { 404: "Course not found", 422: "Same capacity" }
        })
        const op = doc().paths["/oa/courses/{courseId}/capacity"].put
        expect(op.summary).toBe("Change capacity")
        expect(op.parameters.map((p: any) => [p.in, p.name])).toEqual(
            expect.arrayContaining([["path", "courseId"], ["header", "Idempotency-Key"]])
        )
        expect(op.requestBody.content["application/json"].schema).toEqual({ $ref: "#/components/schemas/OaChangeCapacityBody" })
        expect(Object.keys(op.responses).sort()).toEqual(["204", "400", "404", "422"])
        expect(op.responses["422"].description).toBe("Same capacity")
    })

    test("a command without a body has no 400, and createdId returns { id }", () => {
        registerCommand({ method: "delete", path: "/oa/things/:thingId", summary: "Remove", success: "noContent" })
        registerCommand({ method: "post", path: "/oa/things", summary: "Add", body: z.object({ name: z.string() }), success: "createdId" })
        const paths = doc().paths
        expect(Object.keys(paths["/oa/things/{thingId}"].delete.responses)).toEqual(["204"])
        expect(paths["/oa/things"].post.responses["201"].content["application/json"].schema.properties).toHaveProperty("id")
    })

    test("registering the same method and path again replaces it", () => {
        registerRead({ path: "/oa/again", summary: "first", response: z.object({}) })
        registerRead({ path: "/oa/again", summary: "second", response: z.object({}) })
        expect(doc().paths["/oa/again"].get.summary).toBe("second")
    })

    test("a read model documents its keyed GET and every query with a path", () => {
        interface Doc {
            [key: string]: unknown
            courseId: string
            remainingSeats: number
        }
        const Schema = z.object({ courseId: z.string(), remainingSeats: z.number() }).openapi("OaCourseSeats")
        const seats = defineReadModel<Doc>({
            name: "OaCourseSeats",
            type: "database-projected",
            key: "courseId",
            collection: "oa_course_seats",
            canHandle: ["courseWasRegistered"],
            queries: {
                available: { path: "/oa/available-courses", params: { min: { field: "remainingSeats", op: "gte", type: "number" } } },
                some: { path: "/oa/some/:courseId", params: { courseId: { field: "courseId", type: "string" }, ids: { field: "courseId", op: "in", type: "string", optional: true } } },
                noPath: { params: {} }
            },
            evolve: doc => doc
        })
        registerReadModel(seats, "/oa/course-seats/:courseId", { schema: Schema, wait: true })
        const paths = doc().paths

        const keyed = paths["/oa/course-seats/{courseId}"].get
        expect(keyed.responses["200"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/OaCourseSeats" })
        expect(Object.keys(keyed.responses).sort()).toEqual(["200", "404", "504"])
        expect(keyed.parameters.map((p: any) => p.name)).toEqual(expect.arrayContaining(["courseId", "If-None-Match", "Prefer"]))

        const available = paths["/oa/available-courses"].get
        const params = Object.fromEntries(available.parameters.map((p: any) => [p.name, p]))
        expect(params.min).toMatchObject({ in: "query", required: true, schema: { type: "number" } })
        expect(params.limit).toMatchObject({ in: "query", required: false })
        expect(params.cursor).toMatchObject({ in: "query", required: false })
        expect(available.responses["200"].content["application/json"].schema.properties.data.items).toEqual({
            $ref: "#/components/schemas/OaCourseSeats"
        })

        const some = Object.fromEntries(paths["/oa/some/{courseId}"].get.parameters.map((p: any) => [p.name, p.in]))
        expect(some).toMatchObject({ courseId: "path", ids: "query" })
        expect(Object.keys(paths).some(p => p.includes("noPath"))).toBe(false)
    })
})

describe("configureCors", () => {
    const app = (origins?: string) =>
        supertest(getApplication({ apis: [configureCors(origins), router => router.get("/x", (_req, res) => res.json({ ok: true }))] }))

    test("unset: no CORS headers", async () => {
        const res = await app(undefined).get("/x").set("Origin", "http://localhost:5173")
        expect(res.headers["access-control-allow-origin"]).toBeUndefined()
    })

    test("an allowed origin is echoed, exposes ETag, and preflights get 204", async () => {
        const res = await app("http://localhost:5173, https://app.example.com").get("/x").set("Origin", "https://app.example.com")
        expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com")
        expect(res.headers["access-control-expose-headers"]).toContain("ETag")
        expect(res.headers["vary"]).toContain("Origin")

        const pre = await app("http://localhost:5173")
            .options("/x")
            .set("Origin", "http://localhost:5173")
            .set("Access-Control-Request-Method", "POST")
        expect(pre.status).toBe(204)
        expect(pre.headers["access-control-allow-headers"]).toContain("Idempotency-Key")
        expect(pre.headers["access-control-allow-methods"]).toContain("DELETE")
    })

    test("another origin gets no CORS headers; * allows any", async () => {
        const other = await app("http://localhost:5173").get("/x").set("Origin", "https://evil.example")
        expect(other.headers["access-control-allow-origin"]).toBeUndefined()
        const any = await app("*").get("/x").set("Origin", "https://anywhere.example")
        expect(any.headers["access-control-allow-origin"]).toBe("*")
    })
})
