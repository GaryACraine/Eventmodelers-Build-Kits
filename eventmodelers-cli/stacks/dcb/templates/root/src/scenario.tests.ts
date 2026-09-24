import { describe, test, expect, beforeAll, afterAll } from "vitest"
import http from "node:http"
import supertest from "supertest"
import type { Pool } from "pg"
import { getApplication } from "@dcb-es/event-store-express"
import {
    PostgresEventStore,
    createConsumer,
    projectionToProcessor,
    ensureHandlersInstalled,
    waitUntilProcessed,
    type RunningConsumer
} from "@dcb-es/event-store-postgres"
import { SequencePosition } from "@dcb-es/event-store"
import { getTestPgDatabasePool } from "@test/testPgDbPool"

import {
    courseDetailsProjection,
    COURSE_PROJECTION_NAME
} from "./contexts/enrollment/slices/course-details/projection.js"
import {
    studentDetailsProjection,
    STUDENT_PROJECTION_NAME
} from "./contexts/enrollment/slices/student-details/projection.js"

import { configureRegisterCourseRoute } from "./contexts/enrollment/slices/register-course/route.js"
import { configureRegisterStudentRoute } from "./contexts/enrollment/slices/register-student/route.js"
import { configureSubscribeStudentRoute } from "./contexts/enrollment/slices/subscribe-student/route.js"
import { configureUnsubscribeStudentRoute } from "./contexts/enrollment/slices/unsubscribe-student/route.js"
import { configureChangeCourseCapacityRoute } from "./contexts/enrollment/slices/change-course-capacity/route.js"
import { configureCourseDetailsRoute } from "./contexts/enrollment/slices/course-details/route.js"
import { configureCourseListRoute } from "./contexts/enrollment/slices/course-list/route.js"
import { configureStudentDetailsRoute } from "./contexts/enrollment/slices/student-details/route.js"
import { configureEventFeedRoute } from "./contexts/enrollment/slices/event-feed/route.js"
import { configureOpenApiRoute } from "./contexts/enrollment/slices/openapi/route.js"

describe("Scenario: course enrollment lifecycle", () => {
    let pool: Pool
    let eventStore: PostgresEventStore
    let consumer: RunningConsumer
    let app: ReturnType<typeof getApplication>

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 20 })
        eventStore = new PostgresEventStore({ pool })
        await eventStore.ensureInstalled()

        const initClient = await pool.connect()
        try {
            await courseDetailsProjection.init!(initClient)
            await studentDetailsProjection.init!(initClient)
        } finally {
            initClient.release()
        }

        await ensureHandlersInstalled(pool, [COURSE_PROJECTION_NAME, STUDENT_PROJECTION_NAME], "_handler_bookmarks")

        consumer = createConsumer({
            pool,
            eventStore,
            processors: [
                projectionToProcessor(courseDetailsProjection, { batchSize: 100, startFrom: "BEGINNING" }),
                projectionToProcessor(studentDetailsProjection, { batchSize: 100, startFrom: "BEGINNING" })
            ]
        })

        const courseWaitFn = (position: SequencePosition, timeoutMs: number) =>
            waitUntilProcessed(pool, COURSE_PROJECTION_NAME, position, { timeoutMs })
        const studentWaitFn = (position: SequencePosition, timeoutMs: number) =>
            waitUntilProcessed(pool, STUDENT_PROJECTION_NAME, position, { timeoutMs })

        const deps = { store: eventStore, pool }

        app = getApplication({
            apis: [
                configureRegisterCourseRoute(deps),
                configureRegisterStudentRoute(deps),
                configureSubscribeStudentRoute(deps),
                configureUnsubscribeStudentRoute(deps),
                configureChangeCourseCapacityRoute(deps),
                configureCourseDetailsRoute({ ...deps, waitFn: courseWaitFn }),
                configureCourseListRoute({ ...deps, waitFn: courseWaitFn }),
                configureStudentDetailsRoute({ ...deps, waitFn: studentWaitFn }),
                configureEventFeedRoute(eventStore),
                configureOpenApiRoute()
            ]
        })
    })

    afterAll(async () => {
        await consumer.stop()
        if (pool) await pool.end()
    })

    test("full course enrollment lifecycle with read-your-writes", async () => {
        const agent = supertest(app)

        // Register course
        const step1 = await agent.post("/register-course").send({ id: "ts101", title: "TypeScript 101", capacity: 2 })
        expect(step1.status).toBe(204)
        const courseETag = step1.headers["etag"] as string

        // Register students
        const step2 = await agent.post("/register-student").send({ id: "alice", name: "Alice" })
        expect(step2.status).toBe(204)
        const step3 = await agent.post("/register-student").send({ id: "bob", name: "Bob" })
        expect(step3.status).toBe(204)
        const step4 = await agent.post("/register-student").send({ id: "charlie", name: "Charlie" })
        expect(step4.status).toBe(204)

        // Read course with Prefer: wait
        const step5 = await agent.get("/course-details/ts101").set("Prefer", "wait=5").set("If-None-Match", courseETag)
        expect(step5.status).toBe(200)
        expect(step5.body.subscribedStudents).toHaveLength(0)

        // Subscribe Alice
        const step6 = await agent.post("/subscribe-student-to-course").send({ courseId: "ts101", studentId: "alice" })
        expect(step6.status).toBe(204)
        const subETag = step6.headers["etag"] as string

        // Read-your-writes: verify Alice is enrolled
        const step7 = await agent.get("/course-details/ts101").set("Prefer", "wait=5").set("If-None-Match", subETag)
        expect(step7.status).toBe(200)
        expect(step7.body.subscribedStudents).toHaveLength(1)
        expect(step7.body.subscribedStudents[0].studentId).toBe("alice")

        // Subscribe Bob (fills the course)
        const step8 = await agent.post("/subscribe-student-to-course").send({ courseId: "ts101", studentId: "bob" })
        expect(step8.status).toBe(204)

        // Charlie can't subscribe — course is full
        const step9 = await agent.post("/subscribe-student-to-course").send({ courseId: "ts101", studentId: "charlie" })
        expect(step9.status).toBe(422)
        expect(step9.body.detail).toBe("Course ts101 is full.")

        // Unsubscribe Alice
        const step10 = await agent.post("/unsubscribe-student-from-course").send({ courseId: "ts101", studentId: "alice" })
        expect(step10.status).toBe(204)

        // Charlie can now subscribe
        const step11 = await agent.post("/subscribe-student-to-course").send({ courseId: "ts101", studentId: "charlie" })
        expect(step11.status).toBe(204)
        const charlieETag = step11.headers["etag"] as string

        // Verify Charlie's student details include ts101
        const step12 = await agent.get("/student-details/charlie").set("Prefer", "wait=5").set("If-None-Match", charlieETag)
        expect(step12.status).toBe(200)
        const courseIds = step12.body.subscribedCourses.map((c: { courseId: string }) => c.courseId)
        expect(courseIds).toContain("ts101")

        // SSE event feed
        const server = await new Promise<http.Server>(resolve => {
            const srv = http.createServer(app).listen(0, "127.0.0.1", () => resolve(srv))
        })

        try {
            const addr = server.address() as { port: number }
            const messagePromise = new Promise<{ id: string; data: unknown }>((resolve, reject) => {
                let buffer = ""
                const req = http.get({ host: "127.0.0.1", port: addr.port, path: "/events" }, res => {
                    const timer = setTimeout(() => {
                        req.destroy()
                        reject(new Error("SSE timeout"))
                    }, 8000)
                    res.on("data", (chunk: Buffer) => {
                        buffer += chunk.toString()
                        const parts = buffer.split("\n\n")
                        buffer = parts.pop() ?? ""
                        for (const part of parts) {
                            if (!part.trim() || part.startsWith(":")) continue
                            const lines = part.split("\n")
                            let id = ""
                            let dataStr = ""
                            for (const line of lines) {
                                if (line.startsWith("id: ")) id = line.slice(4)
                                else if (line.startsWith("data: ")) dataStr = line.slice(6)
                            }
                            if (dataStr) {
                                clearTimeout(timer)
                                req.destroy()
                                try { resolve({ id, data: JSON.parse(dataStr) }) }
                                catch { resolve({ id, data: dataStr }) }
                            }
                        }
                    })
                    res.on("error", () => resolve({ id: "", data: null }))
                })
                req.on("error", err => {
                    if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err)
                })
            })

            await new Promise<void>(resolve => setTimeout(resolve, 100))
            const postRes = await agent.post("/register-course").send({ id: "go101", title: "Go 101", capacity: 20 })
            expect(postRes.status).toBe(204)

            const message = await messagePromise
            const data = message.data as { event: { type: string } }
            expect(data.event.type).toBe("courseWasRegistered")
        } finally {
            await new Promise<void>(resolve => {
                server.closeAllConnections?.()
                server.close(() => resolve())
            })
        }

        // Pagination
        const step14 = await agent.post("/register-course").send({ id: "rust101", title: "Rust 101", capacity: 10 })
        expect(step14.status).toBe(204)
        const rustETag = step14.headers["etag"] as string

        const step15 = await agent.get("/course-list?limit=2").set("Prefer", "wait=5").set("If-None-Match", rustETag)
        expect(step15.status).toBe(200)
        expect(step15.body.data).toHaveLength(2)
        expect(step15.body.cursor).toBeDefined()

        const pageCursor = step15.body.cursor as string
        const step16 = await agent.get(`/course-list?cursor=${pageCursor}&limit=2`)
        expect(step16.status).toBe(200)
        expect(step16.body.data.length).toBeGreaterThan(0)
        // Paging on reaches a last page that has rows and no cursor
        let lastPage = step16
        while (lastPage.body.cursor) lastPage = await agent.get(`/course-list?cursor=${lastPage.body.cursor}&limit=2`)
        expect(lastPage.body.data.length).toBeGreaterThan(0)

        // Idempotency key
        const idempotencyKey = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
        const step17 = await agent
            .post("/register-course")
            .set("Idempotency-Key", idempotencyKey)
            .send({ id: "idem101", title: "Idempotent Course", capacity: 10 })
        expect(step17.status).toBe(204)
        const idemETag = step17.headers["etag"] as string

        const step18 = await agent
            .post("/register-course")
            .set("Idempotency-Key", idempotencyKey)
            .send({ id: "idem101", title: "Idempotent Course", capacity: 10 })
        expect(step18.status).toBe(204)
        expect(step18.headers["etag"]).toBe(idemETag)

        // OpenAPI document
        const openapiRes = await agent.get("/openapi.json")
        expect(openapiRes.status).toBe(200)
        expect(openapiRes.body.openapi).toBe("3.1.0")
    })
})
