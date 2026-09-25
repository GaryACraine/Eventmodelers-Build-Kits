import { describe, test, expect } from "vitest"
import { compareContract, renderReport } from "./contract.js"

// A contract as emcli writes it, and the document the code serves (zod-to-openapi's shapes), for one command, one
// read model and one query.
const problem = { content: { "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } } } }

function contract(overrides: { body?: object; readModel?: object } = {}) {
    return {
        openapi: "3.1.0",
        paths: {
            "/rate-course": {
                post: {
                    parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } }],
                    requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/RateCourseBody" } } } },
                    responses: { "204": { description: "Done" }, "400": problem, "4XX": problem },
                    "x-rejections": ["Course already rated by this student"]
                }
            },
            "/course-ratings/{courseId}": {
                get: {
                    parameters: [{ name: "courseId", in: "path", required: true, schema: { type: "string" } }],
                    responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/CourseRatings" } } } }, "404": problem }
                }
            },
            "/course-seats/available-courses": {
                get: {
                    parameters: [
                        { name: "minRemainingSeats", in: "query", required: true, schema: { type: "integer" } },
                        { name: "limit", in: "query", required: false, schema: { type: "integer" } },
                        { name: "cursor", in: "query", required: false, schema: { type: "string" } }
                    ],
                    responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/CourseSeats" } }, cursor: { type: "string" } }, required: ["data"] } } } } }
                }
            }
        },
        components: {
            schemas: {
                RateCourseBody: overrides.body ?? {
                    type: "object",
                    properties: { courseId: { type: "string" }, rating: { type: "integer", example: 4 } },
                    required: ["courseId", "rating"]
                },
                CourseRatings: overrides.readModel ?? {
                    type: "object",
                    properties: { courseId: { type: "string" }, averageRating: { type: "number" }, comments: { type: "array", items: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
                    required: ["courseId", "averageRating", "comments"]
                },
                CourseSeats: { type: "object", properties: { courseId: { type: "string" } }, required: ["courseId"] }
            }
        }
    }
}

// What the kit serves for the same model: other descriptions, a 422 instead of 4XX, minLength, a nullable, ETag headers.
function served(overrides: { rateCourseBody?: object; ratingsPath?: string; extra?: object } = {}) {
    return {
        openapi: "3.1.0",
        paths: {
            "/events": { get: { responses: { "200": { description: "the feed" } } } },
            "/rate-course": {
                post: {
                    summary: "Rate a course",
                    parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", format: "uuid" } }],
                    requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/RateCourseBody" } } } },
                    responses: { "204": { description: "Done", headers: { ETag: { schema: { type: "string" } } } }, "400": problem, "422": problem }
                }
            },
            [overrides.ratingsPath ?? "/course-ratings/{courseId}"]: {
                get: {
                    parameters: [{ name: "courseId", in: "path", required: true, schema: { type: "string" } }],
                    responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/CourseRatings" } } } }, "404": problem }
                }
            },
            ...overrides.extra
        },
        components: {
            schemas: {
                RateCourseBody: overrides.rateCourseBody ?? {
                    type: "object",
                    properties: { courseId: { type: "string", minLength: 1 }, rating: { type: "integer" } },
                    required: ["courseId", "rating"]
                },
                CourseRatings: {
                    type: "object",
                    properties: { courseId: { type: "string" }, averageRating: { type: ["number", "null"] }, comments: { type: "array", items: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
                    required: ["courseId", "averageRating", "comments"]
                }
            }
        }
    }
}

describe("the API contract check (PLAN 14.10)", () => {
    test("matches what the typed client sees; ignores descriptions, headers, formats, nullability and the rejection's 4xx", () => {
        const report = compareContract(served(), contract())
        expect(report.match).toEqual(["GET /course-ratings/{courseId}", "POST /rate-course"])
        expect(report.differ).toEqual([])
        // not built yet: pending, not a problem
        expect(report.pending).toEqual(["GET /course-seats/available-courses"])
        // infrastructure isn't the model's
        expect(report.extra).toEqual([])
        expect(renderReport(report).problems).toBe(0)
    })

    test("names each difference: a renamed field, a type, required, the component name", () => {
        const report = compareContract(
            served({
                rateCourseBody: {
                    type: "object",
                    properties: { courseId: { type: "string" }, stars: { type: "integer" } },
                    required: ["courseId"]
                }
            }),
            contract({
                readModel: {
                    type: "object",
                    properties: { courseId: { type: "string" }, averageRating: { type: "string" }, comments: { type: "array", items: { type: "object", properties: { text: { type: "string" } }, required: [] } } },
                    required: ["courseId", "comments"]
                }
            })
        )
        expect(report.differ).toEqual([
            {
                op: "GET /course-ratings/{courseId}",
                what: [
                    "response.averageRating: optional in the contract, required in the code",
                    "response.averageRating: string in the contract, number in the code",
                    "response.comments[].text: optional in the contract, required in the code"
                ]
            },
            {
                op: "POST /rate-course",
                what: ["body.rating: in the contract, missing from the code", "body.stars: in the code, not in the contract"]
            }
        ])
        const { lines, problems } = renderReport(report)
        expect(problems).toBe(2)
        expect(lines[0]).toBe("API contract (api/openapi.json): 0 match, 1 pending (not built yet), 2 differ, 0 not in the contract")
    })

    test("a served route the model doesn't have is an error; `only` limits the comparison", () => {
        const report = compareContract(served({ ratingsPath: "/ratings/{courseId}" }), contract())
        expect(report.extra).toEqual(["GET /ratings/{courseId}"])
        expect(report.pending).toContain("GET /course-ratings/{courseId}")
        const one = compareContract(served({ ratingsPath: "/ratings/{courseId}" }), contract(), { only: ["POST /rate-course"] })
        expect(one).toEqual({ match: ["POST /rate-course"], pending: [], differ: [], extra: [] })
    })

    test("compares the component names the UI imports", () => {
        const doc = served()
        const post = (doc.paths["/rate-course"] as any).post
        post.requestBody.content["application/json"].schema = { $ref: "#/components/schemas/RateCourse" }
        ;(doc.components.schemas as any).RateCourse = doc.components.schemas.RateCourseBody
        const report = compareContract(doc, contract(), { only: ["POST /rate-course"] })
        expect(report.differ[0].what).toEqual(["body: the contract names it RateCourseBody, the code RateCourse"])
    })

    test("a different success status or parameter is a difference", () => {
        const doc = served()
        const post = (doc.paths["/rate-course"] as any).post
        post.responses = { "201": { content: { "application/json": { schema: { type: "object", properties: {} } } } } }
        post.parameters.push({ name: "courseId", in: "query", required: true })
        const report = compareContract(doc, contract(), { only: ["POST /rate-course"] })
        expect(report.differ[0].what).toEqual([
            "answers 201 in the code, 204 in the contract",
            "query parameter courseId: in the code, not in the contract",
            "response: the code has object, the contract has none"
        ])
    })
})
