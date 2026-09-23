import { describe, test, expect, afterEach } from "vitest"
import type { Pool } from "pg"
import { Tags, SequencePosition, type TaggedEvent } from "@dcb-es/event-store"
import { getApplication } from "@dcb-es/event-store-express"
import supertest from "supertest"
import { z } from "zod"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { defineReadModel, queryTypes, readModelRoute, readQueryRoute, startReadModels, withType, type ReadModel, type ReadModelRuntime, type ReadModelType } from "./readModels.js"
import {
    buildQuerySql,
    matchesQuery,
    pageOf,
    sortTuple,
    type QueryDefinition,
    type SortTuple,
    type QueryPage,
    type QueryParams
} from "./readModelQueries.js"

// ─── A course read model with every kind of query (ADR-023) ──────────────────

interface CourseDoc {
    [key: string]: unknown
    courseId: string
    title: string
    capacity: number
    remainingSeats: number
    level?: unknown
    tags: string[]
    subscribedStudents: { studentId: string }[]
}

const CourseDocSchema = z.object({
    courseId: z.string(),
    title: z.string(),
    capacity: z.number(),
    remainingSeats: z.number(),
    level: z.unknown().optional(),
    tags: z.array(z.string()),
    subscribedStudents: z.array(z.object({ studentId: z.string() }))
})

const queries: Record<string, QueryDefinition> = {
    // stored-only: state predicates, no tag
    withSeats: { params: { min: { field: "remainingSeats", op: "gte", type: "number" } } },
    byTitle: {
        params: {
            title: { field: "title", type: "string" },
            maxCapacity: { field: "capacity", op: "lte", type: "number", optional: true }
        },
        sort: { field: "capacity", direction: "desc" }
    },
    taggedWith: { params: { tag: { field: "tags", op: "contains", type: "string" } } },
    // live-capable: a required tagged parameter narrows the candidates
    forStudent: {
        params: { studentId: { field: "subscribedStudents.studentId", op: "contains", type: "string", tag: "studentId" } },
        sort: { field: "title" }
    },
    inCourses: {
        params: {
            ids: { field: "courseId", op: "in", type: "string", tag: "courseId" },
            level: { field: "level", op: "ne", type: "number", optional: true }
        }
    }
}
const LIVE_QUERIES = ["forStudent", "inCourses"]

const courses = defineReadModel<CourseDoc>({
    name: "TestQueryCourses",
    type: "database-projected",
    key: "courseId",
    collection: "test_query_courses",
    canHandle: ["courseWasRegistered", "studentWasSubscribed", "studentWasUnsubscribed"],
    queries,
    evolve: (doc, { event }) => {
        const d = event.data as Record<string, any>
        switch (event.type) {
            case "courseWasRegistered":
                return {
                    courseId: d.courseId, title: d.title, capacity: d.capacity, remainingSeats: d.capacity,
                    ...(d.level !== undefined ? { level: d.level } : {}), tags: d.tags, subscribedStudents: []
                }
            case "studentWasSubscribed":
                return doc && { ...doc, remainingSeats: doc.remainingSeats - 1, subscribedStudents: [...doc.subscribedStudents, { studentId: d.studentId }] }
            case "studentWasUnsubscribed":
                return doc && {
                    ...doc, remainingSeats: doc.remainingSeats + 1,
                    subscribedStudents: doc.subscribedStudents.filter(s => s.studentId !== d.studentId)
                }
        }
        return doc
    }
})

const e = (type: string, data: Record<string, unknown>, tags: Record<string, string>): TaggedEvent => ({ event: { type, data } as any, tags: Tags.fromObj(tags) })
const register = (courseId: string, title: string, capacity: number, tags: string[], level?: unknown) =>
    e("courseWasRegistered", { courseId, title, capacity, tags, ...(level !== undefined ? { level } : {}) }, { courseId })
const subscribe = (courseId: string, studentId: string) => e("studentWasSubscribed", { courseId, studentId }, { courseId, studentId })
const unsubscribe = (courseId: string, studentId: string) => e("studentWasUnsubscribed", { courseId, studentId }, { courseId, studentId })

// remainingSeats: c1 8, c2 8, c3 10, c4 2 · titles sort by bytes: "Banana" < "apple" < "cherry"
// c3's level is the *string* "2" — a number parameter never equals it
const history: TaggedEvent[] = [
    register("c1", "apple", 10, ["math", "intro"], 1),
    register("c2", "Banana", 9, ["history"]),
    register("c3", "cherry", 10, [], "2"),
    register("c4", "apple", 3, ["math"], 2),
    subscribe("c1", "s1"),
    subscribe("c2", "s1"),
    subscribe("c3", "s1"),
    subscribe("c4", "s2"),
    subscribe("c1", "s2"),
    unsubscribe("c3", "s1")
]

// ─── Harness ─────────────────────────────────────────────────────────────────

const pools: Pool[] = []
const runtimes: ReadModelRuntime[] = []
afterEach(async () => {
    for (const r of runtimes.splice(0)) await r.stop()
    for (const p of pools.splice(0)) await p.end()
})

async function started(type: ReadModelType, events = history): Promise<{ pool: Pool; runtime: ReadModelRuntime; readModel: ReadModel<CourseDoc> }> {
    const pool = await getTestPgDatabasePool({ max: 10 })
    pools.push(pool)
    const readModel = withType(courses, type)
    const runtime = await startReadModels(pool, [readModel])
    runtimes.push(runtime)
    for (const event of events) await runtime.eventStore.append({ events: event })
    const waitFn = runtime.waitFn(readModel)
    const head = await pool.query<{ head: string | null }>("SELECT max(sequence_position)::text AS head FROM events")
    if (waitFn && head.rows[0]?.head) await waitFn(SequencePosition.fromString(head.rows[0].head), 5000)
    return { pool, runtime, readModel }
}

const ids = (page: QueryPage) => page.data.map(d => d["courseId"])
const all = { limit: 200 }

// ─── Every type serves the same pages ────────────────────────────────────────

const cases: { query: string; params: QueryParams; expected: string[] }[] = [
    { query: "withSeats", params: { min: 8 }, expected: ["c1", "c2", "c3"] },
    { query: "withSeats", params: { min: 9 }, expected: ["c3"] }, // numeric, not text: 10 >= 9
    { query: "withSeats", params: { min: 11 }, expected: [] },
    { query: "byTitle", params: { title: "apple" }, expected: ["c1", "c4"] }, // capacity desc
    { query: "byTitle", params: { title: "apple", maxCapacity: 5 }, expected: ["c4"] },
    { query: "byTitle", params: { title: "APPLE" }, expected: [] },
    { query: "taggedWith", params: { tag: "math" }, expected: ["c1", "c4"] },
    { query: "taggedWith", params: { tag: "intro" }, expected: ["c1"] },
    { query: "forStudent", params: { studentId: "s1" }, expected: ["c2", "c1"] }, // "Banana" < "apple"; c3 unsubscribed
    { query: "forStudent", params: { studentId: "s2" }, expected: ["c1", "c4"] }, // same title: key breaks the tie
    { query: "forStudent", params: { studentId: "s9" }, expected: [] },
    { query: "inCourses", params: { ids: ["c1", "c3", "c4"] }, expected: ["c1", "c3", "c4"] },
    { query: "inCourses", params: { ids: ["c1", "c3", "c4"], level: 2 }, expected: ["c1", "c3"] } // ne matches the string "2"
]

describe.each(["database-projected", "inline-projected", "live-report"] as ReadModelType[])("queries (%s)", type => {
    const supported = cases.filter(c => queryTypes(courses, c.query).includes(type))

    test("each query returns the expected documents, in order", async () => {
        const { runtime, readModel } = await started(type)
        for (const c of supported) {
            const page = await runtime.querier(readModel, c.query)(c.params, all)
            expect({ ...c, got: ids(page) }).toEqual({ ...c, got: c.expected })
            expect(page.cursor).toBeUndefined()
        }
    })

    test("paging with the cursor walks the same order, one row at a time", async () => {
        const { runtime, readModel } = await started(type)
        for (const c of supported.filter(c => c.expected.length > 1)) {
            const walked: unknown[] = []
            let after: string | undefined
            do {
                const route = supertest(getApplication({ apis: [readQueryRoute(readModel, runtime, c.query, "/q")] }))
                const qs: Record<string, string> = { limit: "1", ...(after ? { cursor: after } : {}) }
                for (const [k, v] of Object.entries(c.params)) qs[k] = Array.isArray(v) ? v.join(",") : String(v)
                const res = await route.get("/q").query(qs)
                expect(res.status).toBe(200)
                walked.push(...res.body.data.map((d: CourseDoc) => d.courseId))
                after = res.body.cursor
            } while (after)
            expect({ query: c.query, walked }).toEqual({ query: c.query, walked: c.expected })
        }
    })
})

// ─── The SQL and the in-memory matcher are the same semantics ────────────────

describe("stored SQL mirrors the in-memory semantics", () => {
    const grid: Record<string, Record<string, QueryParams[keyof QueryParams] | undefined>[]> = {
        withSeats: [-1, 0, 2, 7.5, 8, 9, 10, 11].map(min => ({ min })),
        byTitle: ["apple", "Banana", "banana", "cherry", ""].flatMap(title => [{ title }, { title, maxCapacity: 3 }, { title, maxCapacity: 9 }]),
        taggedWith: ["math", "intro", "history", "none"].map(tag => ({ tag })),
        forStudent: ["s1", "s2", "s3"].map(studentId => ({ studentId })),
        inCourses: [["c1"], ["c2", "c3"], ["c1", "c2", "c3", "c4"]].flatMap(i => [{ ids: i }, { ids: i, level: 1 }, { ids: i, level: 2 }])
    }

    test("every query, over a grid of parameters and page sizes", async () => {
        const { pool } = await started("database-projected")
        const stored = await pool.query<{ _id: string; data: CourseDoc }>("SELECT _id, data FROM test_query_courses")
        const rows = stored.rows.map(r => ({ key: r._id, doc: r.data }))
        expect(rows).toHaveLength(4)

        for (const [name, paramSets] of Object.entries(grid)) {
            const query = queries[name]
            for (const params of paramSets) {
                const p = params as QueryParams
                const inMemory = pageOf(rows.filter(r => matchesQuery(r.doc, query, p)), query, all)
                const sql = buildQuerySql("test_query_courses", query, p, all)
                const viaSql = (await pool.query<{ data: CourseDoc }>(sql.text, sql.values)).rows.map(r => r.data.courseId)
                expect({ name, params, ids: viaSql }).toEqual({ name, params, ids: ids(inMemory) })
            }
        }
    })

    test("after every cursor position, and after a cursor no unsorted page would hand out", async () => {
        const { pool } = await started("database-projected")
        const stored = await pool.query<{ _id: string; data: CourseDoc }>("SELECT _id, data FROM test_query_courses")
        const rows = stored.rows.map(r => ({ key: r._id, doc: r.data }))

        for (const [name, query] of Object.entries(queries)) {
            const afters: SortTuple[] = [...rows.map(r => sortTuple(r.doc, r.key, query)), [0, 0, "", ""], [1, 0, "", "c1"], [0, 5, "", "c0"]]
            for (const params of grid[name] as QueryParams[]) {
                for (const after of afters) {
                    const page = { limit: 200, after }
                    const inMemory = pageOf(rows.filter(r => matchesQuery(r.doc, query, params)), query, page)
                    const sql = buildQuerySql("test_query_courses", query, params, page)
                    const viaSql = (await pool.query<{ data: CourseDoc }>(sql.text, sql.values)).rows.map(r => r.data.courseId)
                    expect({ name, params, after, ids: viaSql }).toEqual({ name, params, after, ids: ids(inMemory) })
                }
            }
        }
    })
})

// ─── Contract details ────────────────────────────────────────────────────────

describe("the query route", () => {
    test("serves { data, cursor? } with path parameters, and 400s bad input", async () => {
        const { runtime, readModel } = await started("database-projected")
        const agent = supertest(getApplication({
            apis: [
                readQueryRoute(readModel, runtime, "forStudent", "/students/:studentId/courses"),
                readQueryRoute(readModel, runtime, "withSeats", "/available-courses"),
                readQueryRoute(readModel, runtime, "inCourses", "/course-list")
            ]
        }))

        const ok = await agent.get("/students/s1/courses")
        expect(ok.status).toBe(200)
        expect(Object.keys(ok.body)).toEqual(["data"])
        expect(ok.body.data[0]).toEqual({
            courseId: "c2", title: "Banana", capacity: 9, remainingSeats: 8, tags: ["history"], subscribedStudents: [{ studentId: "s1" }]
        })

        const paged = await agent.get("/available-courses").query({ min: "0", limit: "3" })
        expect(paged.body.data).toHaveLength(3)
        expect(typeof paged.body.cursor).toBe("string")

        expect((await agent.get("/available-courses")).body).toMatchObject({ status: 400, detail: 'Missing required parameter "min"' })
        expect((await agent.get("/available-courses?min=lots")).body.detail).toBe('Parameter "min" must be a number')
        expect((await agent.get("/available-courses?min=1&min=2")).body.detail).toBe('Parameter "min" was given more than once')
        expect((await agent.get("/available-courses?min=1&limit=0")).body.detail).toBe("limit must be a positive integer")
        expect((await agent.get("/available-courses?min=1&cursor=nope")).body.detail).toBe("cursor is not valid")
        expect((await agent.get("/course-list?ids=c1,c2&level=x")).status).toBe(400)
        expect((await agent.get("/course-list?ids=c1,c2")).body.data.map((d: CourseDoc) => d.courseId)).toEqual(["c1", "c2"])
    })

    test("an empty result is a 200 with no data, never a 404", async () => {
        const { runtime, readModel } = await started("live-report")
        const res = await supertest(getApplication({ apis: [readQueryRoute(readModel, runtime, "forStudent", "/s/:studentId")] })).get("/s/nobody")
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ data: [] })
    })
})

describe("runtime guards", () => {
    test("a live read model with a query no tag narrows refuses to start", async () => {
        const pool = await getTestPgDatabasePool({ max: 5 })
        pools.push(pool)
        // A definition typed live-report with every query (withType would drop the stored-only ones)
        await expect(startReadModels(pool, [{ ...courses, type: "live-report" } as ReadModel<CourseDoc>])).rejects.toThrow(
            /live-report can't serve TestQueryCourses.withSeats, TestQueryCourses.byTitle, TestQueryCourses.taggedWith/
        )
    })

    test("stored-only queries: queryTypes leaves out live, and withType(live) drops them but the routes still mount", async () => {
        const stored = ["database-projected", "inline-projected"]
        for (const name of Object.keys(queries)) {
            expect(queryTypes(courses, name)).toEqual(LIVE_QUERIES.includes(name) ? [...stored, "live-report"] : stored)
        }
        expect(Object.keys(withType(courses, "live-report").queries!)).toEqual(LIVE_QUERIES)
        expect(Object.keys(withType(courses, "inline-projected").queries!)).toEqual(Object.keys(queries))

        const { runtime } = await started("live-report")
        // A slice's route module passes the definition with every query; the live runtime has only some.
        const agent = supertest(
            getApplication({
                apis: [readQueryRoute(courses, runtime, "withSeats", "/available-courses"), readQueryRoute(courses, runtime, "forStudent", "/s/:studentId")]
            })
        )
        expect((await agent.get("/s/s1")).status).toBe(200)
        expect((await agent.get("/available-courses?min=1")).status).toBe(500)
    })

    test("readModelRoute serves every query that declares a path, next to the keyed GET", async () => {
        const withPaths = defineReadModel<CourseDoc>({
            ...courses,
            queries: {
                ...queries,
                withSeats: { ...queries.withSeats, path: "/available-courses" },
                forStudent: { ...queries.forStudent, path: "/students/:studentId/courses" }
            }
        })
        const { runtime } = await started("inline-projected")
        const agent = supertest(getApplication({ apis: [readModelRoute(withPaths, runtime, "/courses/:courseId", { schema: CourseDocSchema })] }))
        expect((await agent.get("/courses/c1")).body).toMatchObject({ courseId: "c1" })
        expect(ids((await agent.get("/available-courses?min=9")).body)).toEqual(["c3"])
        expect(ids((await agent.get("/students/s1/courses")).body)).toEqual(ids(await runtime.querier(courses, "forStudent")({ studentId: "s1" }, { limit: 50 })))
    })

    test("invalid query definitions are rejected when the read model is defined", () => {
        const bad = (q: QueryDefinition) => () => defineReadModel({ ...courses, queries: { q } })
        expect(bad({ params: { limit: { field: "x", type: "number" } } })).toThrow(/reserved/)
        expect(bad({ params: { x: { field: "a b", type: "string" } } })).toThrow(/dot path/)
        expect(bad({ params: { x: { field: "x", op: "gte", type: "number", tag: "x" } } })).toThrow(/tag needs/)
        expect(bad({ params: { x: { field: "x", type: "string", optional: true, tag: "x" } } })).toThrow(/tag needs/)
        expect(bad({ path: "/s/:studentId", params: { x: { field: "x", type: "string" } } })).toThrow(/path parameter ":studentId"/)
        expect(bad({ path: "/s/:x", params: { x: { field: "x", op: "gte", type: "string" } } })).toThrow(/path parameter ":x"/)
        expect(bad({ path: "/s/:x", params: { x: { field: "x", type: "string", optional: true } } })).toThrow(/path parameter ":x"/)
        expect(bad({ path: "/s/:x", params: { x: { field: "x.y", op: "contains", type: "string" } } })).not.toThrow()
    })

    test("stored read models get indexes the queries use", async () => {
        const { pool } = await started("inline-projected")
        const indexes = await pool.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE tablename = 'test_query_courses'")
        const defs = indexes.rows.map(r => r.indexdef)
        expect(defs.some(d => d.includes("USING gin (data jsonb_path_ops)"))).toBe(true)
        expect(defs.filter(d => d.includes("_q_")).length).toBeGreaterThanOrEqual(6)

        const client = await pool.connect()
        try {
            await client.query("SET enable_seqscan = off")
            for (const [name, params] of [["withSeats", { min: 9 }], ["taggedWith", { tag: "math" }]] as const) {
                const sql = buildQuerySql("test_query_courses", queries[name], params, all)
                const plan = await client.query(`EXPLAIN (FORMAT JSON) ${sql.text}`, sql.values)
                expect({ name, plan: JSON.stringify(plan.rows[0]) }).toEqual({ name, plan: expect.stringMatching(/Index/) })
            }
        } finally {
            client.release()
        }
    })

    test("unsorted queries get a key-order index, and their cursor seeks it", async () => {
        const { pool } = await started("database-projected")
        const indexes = await pool.query<{ indexname: string; indexdef: string }>("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'test_query_courses'")
        const keyOrder = indexes.rows.find(r => /USING btree \(\(?\(?_id COLLATE "C"\)?\)?\)$/.test(r.indexdef))
        expect(keyOrder, indexes.rows.map(r => r.indexdef).join("\n")).toBeDefined()

        const unsorted = buildQuerySql("test_query_courses", queries["withSeats"], { min: 0 }, { limit: 2, after: [0, 0, "", "c2"] })
        expect(unsorted.text).toContain(`(_id COLLATE "C") > $2::text`)
        expect(unsorted.text).not.toMatch(/\) > \(/)
        const sorted = buildQuerySql("test_query_courses", queries["forStudent"], { studentId: "s1" }, { limit: 2, after: [2, 0, "apple", "c1"] })
        expect(sorted.text).toMatch(/\) > \(\$2::int, \$3::numeric, \$4::text, \$5::text\)/)

        // On four rows the planner would rather sort; take its other options away to show the index serves the seek
        const client = await pool.connect()
        try {
            await client.query("SET enable_seqscan = off; SET enable_bitmapscan = off; SET enable_sort = off")
            const plan = JSON.stringify((await client.query(`EXPLAIN (FORMAT JSON) ${unsorted.text}`, unsorted.values)).rows[0])
            expect(plan).toContain(`"Index Name":"${keyOrder!.indexname}"`)
            expect(plan).toMatch(/"Index Cond":"\(\(_id\)::text > /)
        } finally {
            client.release()
        }
    })
})
