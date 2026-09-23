import { describe, test, expect, afterEach } from "vitest"
import type { Pool } from "pg"
import { Tags, type EventStore, type Query, type ReadOptions, type SequencedEvent, type TaggedEvent } from "@dcb-es/event-store"
import { getApplication } from "@dcb-es/event-store-express"
import supertest from "supertest"
import { z } from "zod"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { readModelTestApp } from "@test/readModelHarness"
import {
    READ_MODEL_TYPES,
    defineReadModel,
    readLive,
    readModelRoute,
    startReadModels,
    withType,
    type ReadModel,
    type ReadModelRuntime,
    type ReadModelType
} from "./readModels.js"

// ─── A course read model with a cross-entity lookup (student names) ──────────

interface CourseDoc {
    [key: string]: unknown
    courseId: string
    title: string
    capacity: number
    subscribedStudents: { studentId: string; name: string | null }[]
}

const CourseDocSchema = z.object({
    courseId: z.string(),
    title: z.string(),
    capacity: z.number(),
    subscribedStudents: z.array(z.object({ studentId: z.string(), name: z.string().nullable() }))
})

const courseDetails = defineReadModel<CourseDoc, { students: { name: string } }>({
    name: "TestCourseDetails",
    type: "database-projected",
    key: "courseId",
    collection: "test_course_details",
    canHandle: ["courseWasRegistered", "studentWasSubscribed", "studentWasUnsubscribed", "courseTitleWasChanged"],
    lookups: {
        students: {
            key: "studentId",
            canHandle: ["studentWasRegistered"],
            evolve: (_, { event }) => ({ name: (event.data as { name: string }).name })
        }
    },
    evolve: (doc, { event }, { students }) => {
        const data = event.data as Record<string, any>
        switch (event.type) {
            case "courseWasRegistered":
                return { courseId: data.courseId, title: data.title, capacity: data.capacity, subscribedStudents: [] }
            case "studentWasSubscribed":
                return doc && {
                    ...doc,
                    subscribedStudents: [
                        ...doc.subscribedStudents,
                        { studentId: data.studentId, name: students.get(data.studentId)?.name ?? null }
                    ]
                }
            case "studentWasUnsubscribed":
                return doc && { ...doc, subscribedStudents: doc.subscribedStudents.filter(s => s.studentId !== data.studentId) }
            case "courseTitleWasChanged":
                return doc && { ...doc, title: data.newTitle }
        }
        return doc
    }
})

// A read model without lookups — and the scaffold's `ReadModel[]` must hold both kinds (tsc checks this).
const courseCounter = defineReadModel<{ [key: string]: unknown; courseId: string; subscriptions: number }>({
    name: "TestCourseCounter",
    type: "live-report",
    key: "courseId",
    collection: "test_course_counter",
    canHandle: ["courseWasRegistered", "studentWasSubscribed"],
    evolve: (doc, { event }) =>
        event.type === "courseWasRegistered"
            ? { courseId: (event.data as { courseId: string }).courseId, subscriptions: 0 }
            : doc && { ...doc, subscriptions: doc.subscriptions + 1 }
})
export const registry: ReadModel[] = [courseDetails, courseCounter]

const e = (type: string, data: Record<string, string | number>, tags: Record<string, string>): TaggedEvent => ({
    event: { type, data },
    tags: Tags.fromObj(tags)
})
const registerCourse = (courseId: string, title: string, capacity: number) =>
    e("courseWasRegistered", { courseId, title, capacity }, { courseId })
const registerStudent = (studentId: string, name: string) => e("studentWasRegistered", { studentId, name }, { studentId })
const subscribe = (courseId: string, studentId: string) =>
    e("studentWasSubscribed", { courseId, studentId }, { courseId, studentId })
const unsubscribe = (courseId: string, studentId: string) =>
    e("studentWasUnsubscribed", { courseId, studentId }, { courseId, studentId })

/** A history that interleaves two courses and three students */
const history: TaggedEvent[] = [
    registerCourse("c1", "Math", 30),
    registerStudent("s1", "Ada"),
    registerCourse("c2", "History", 20),
    registerStudent("s2", "Grace"),
    subscribe("c1", "s1"),
    subscribe("c1", "s2"),
    subscribe("c2", "s2"),
    registerStudent("s3", "Linus"),
    unsubscribe("c1", "s2"),
    subscribe("c1", "s3"),
    e("courseTitleWasChanged", { courseId: "c1", newTitle: "Mathematics" }, { courseId: "c1" })
]

const expectedC1: CourseDoc = {
    courseId: "c1",
    title: "Mathematics",
    capacity: 30,
    subscribedStudents: [
        { studentId: "s1", name: "Ada" },
        { studentId: "s3", name: "Linus" }
    ]
}

// ─── Harness ─────────────────────────────────────────────────────────────────

const pools: Pool[] = []
const runtimes: ReadModelRuntime[] = []

afterEach(async () => {
    for (const r of runtimes.splice(0)) await r.stop()
    for (const p of pools.splice(0)) await p.end()
})

async function freshPool(): Promise<Pool> {
    const pool = await getTestPgDatabasePool({ max: 10 })
    pools.push(pool)
    return pool
}

async function start(pool: Pool, readModel: ReadModel<any, any>): Promise<ReadModelRuntime> {
    const runtime = await startReadModels(pool, [readModel])
    runtimes.push(runtime)
    return runtime
}

async function settle(pool: Pool, runtime: ReadModelRuntime, readModel: ReadModel<any, any>): Promise<void> {
    const waitFn = runtime.waitFn(readModel)
    if (!waitFn) return
    const r = await pool.query<{ head: string | null }>("SELECT max(sequence_position)::text AS head FROM events")
    if (r.rows[0]?.head) {
        const { SequencePosition } = await import("@dcb-es/event-store")
        await waitFn(SequencePosition.fromString(r.rows[0].head), 5000)
    }
}

async function readAs(type: ReadModelType, events: TaggedEvent[], id: string) {
    const pool = await freshPool()
    const readModel = withType(courseDetails, type)
    const runtime = await start(pool, readModel)
    for (const event of events) await runtime.eventStore.append({ events: event })
    await settle(pool, runtime, readModel)
    return runtime.reader(readModel)(id)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("the same definition gives the same data, whichever type serves it", () => {
    test.each(READ_MODEL_TYPES)("%s", async type => {
        expect(await readAs(type, history, "c1")).toEqual(expectedC1)
        expect(await readAs(type, history, "nope")).toBeNull()
    })

    test("all three types agree document for document", async () => {
        for (const id of ["c1", "c2"]) {
            const [stored, inline, live] = await Promise.all(READ_MODEL_TYPES.map(t => readAs(t, history, id)))
            expect(inline).toEqual(stored)
            expect(live).toEqual(stored)
        }
    })
})

describe("the route serves the same body and status for every type", () => {
    test.each(READ_MODEL_TYPES)("%s", async type => {
        const pool = await freshPool()
        const readModel = withType(courseDetails, type)
        const runtime = await start(pool, readModel)
        for (const event of history) await runtime.eventStore.append({ events: event })
        await settle(pool, runtime, readModel)

        // The route imports the definition as written; the runtime serves it as the registered type.
        const agent = supertest(getApplication({ apis: [readModelRoute(courseDetails, runtime, "/courses/:courseId", { schema: CourseDocSchema, pool })] }))
        const ok = await agent.get("/courses/c1")
        expect(ok.status).toBe(200)
        expect(ok.body).toEqual(expectedC1)
        const missing = await agent.get("/courses/nope")
        expect(missing.status).toBe(404)
    })
})

describe("live reads", () => {
    test("a related entity committed between the two reads is picked up (fixpoint)", async () => {
        const pool = await freshPool()
        const readModel = withType(courseDetails, "live-report")
        const runtime = await start(pool, readModel)
        for (const event of history.slice(0, 6)) await runtime.eventStore.append({ events: event })

        // After the first read returns, another writer registers s9 and subscribes them to c1.
        let reads = 0
        const racingStore: EventStore = {
            append: cmd => runtime.eventStore.append(cmd),
            subscribe: (q, o) => runtime.eventStore.subscribe(q, o),
            read: async function* (query: Query, options?: ReadOptions): AsyncGenerator<SequencedEvent> {
                const events: SequencedEvent[] = []
                for await (const ev of runtime.eventStore.read(query, options)) events.push(ev)
                if (++reads === 1) {
                    await runtime.eventStore.append({ events: registerStudent("s9", "Barbara") })
                    await runtime.eventStore.append({ events: subscribe("c1", "s9") })
                }
                yield* events
            }
        } as EventStore

        const doc = (await readLive(racingStore, readModel, "c1")) as CourseDoc
        expect(doc.subscribedStudents).toEqual([
            { studentId: "s1", name: "Ada" },
            { studentId: "s2", name: "Grace" },
            { studentId: "s9", name: "Barbara" }
        ])
        expect(reads).toBe(3)
    })

    test("switching live → stored rebuilds, so events recorded while live aren't lost", async () => {
        const pool = await freshPool()
        const stored = withType(courseDetails, "database-projected")
        const first = await start(pool, stored)
        for (const event of history.slice(0, 5)) await first.eventStore.append({ events: event })
        await settle(pool, first, stored)
        await first.stop()

        const live = await start(pool, withType(courseDetails, "live-report"))
        for (const event of history.slice(5)) await live.eventStore.append({ events: event })
        await live.stop()

        const back = await start(pool, stored)
        await settle(pool, back, stored)
        expect(await back.reader(stored)("c1")).toEqual(expectedC1)
    })
})

// The layout generated slice tests use: one describe per type, HTTP only, bodies only.
describe.each(READ_MODEL_TYPES)("readModelTestApp (%s)", type => {
    const app = readModelTestApp({
        readModels: [withType(courseDetails, type)],
        routes: deps => [readModelRoute(courseDetails, deps.readModels!, "/courses/:courseId", { schema: CourseDocSchema, pool: deps.pool })]
    })

    test("serves the folded document after settle()", async () => {
        for (const event of history) await app.deps().store.append({ events: event })
        await app.settle()
        const res = await app.agent().get("/courses/c1")
        expect(res.status).toBe(200)
        expect(res.body).toEqual(expectedC1)
    })
})
