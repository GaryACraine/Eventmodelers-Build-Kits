import { describe, test, expect, beforeEach, afterEach } from "vitest"
import type { Pool } from "pg"
import { SequencedEvent, Tags, type TaggedEvent } from "@dcb-es/event-store"
import {
    PostgresEventStore,
    pongoProjection,
    ensureHandlersInstalled,
    type PongoProjectionContext,
    type Projection
} from "@dcb-es/event-store-postgres"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { ensureProjectionsCurrent } from "./ensureProjectionsCurrent.js"

// A seat counter per course: the smallest read model that shows whether history was projected.
interface SeatsDoc {
    [key: string]: unknown
    _id?: string
    capacity: number
    subscribed: number
}

function seatsProjection(canHandle: string[], options: { failOn?: string } = {}): Projection {
    return pongoProjection({
        name: "SeatsProjection",
        canHandle,
        init: async pongo => {
            await pongo.db().collection<SeatsDoc>("seats").createCollection()
        },
        handle: async (events: SequencedEvent[], context: PongoProjectionContext) => {
            const seats = context.pongo.db().collection<SeatsDoc>("seats")
            for (const { event } of events) {
                const data = event.data as { courseId: string; capacity?: number }
                if (event.type === options.failOn) throw new Error(`projection failed on ${event.type}`)
                switch (event.type) {
                    case "courseWasRegistered":
                        await seats.insertOne({ _id: data.courseId, capacity: data.capacity!, subscribed: 0 })
                        break
                    case "studentWasSubscribed":
                        await seats.updateOne({ _id: data.courseId }, { $inc: { subscribed: 1 } })
                        break
                    case "courseCapacityWasChanged":
                        await seats.updateOne({ _id: data.courseId }, { $set: { capacity: data.capacity! } })
                        break
                }
            }
        },
        truncate: async pongo => {
            await pongo.db().collection<SeatsDoc>("seats").deleteMany()
        }
    })
}

const event = (type: string, data: Record<string, unknown>): TaggedEvent => ({
    event: { type, data },
    tags: Tags.fromObj({ courseId: data.courseId as string })
})

let pool: Pool

async function seats(courseId: string): Promise<SeatsDoc | undefined> {
    const r = await pool.query<{ data: SeatsDoc }>("SELECT data FROM seats WHERE _id = $1", [courseId])
    return r.rows[0]?.data
}

/** Start the app the way src/index.ts does, with one inline projection. */
async function startInline(projection: Projection): Promise<{ store: PostgresEventStore; rebuilt: string[] }> {
    const store = new PostgresEventStore({ pool, inlineProjections: [projection] })
    await store.ensureInstalled()
    const rebuilt = await ensureProjectionsCurrent(pool, store, [], { inline: [projection] })
    return { store, rebuilt }
}

beforeEach(async () => {
    pool = await getTestPgDatabasePool({ max: 10 })
    await new PostgresEventStore({ pool }).ensureInstalled()
})

afterEach(async () => {
    await pool.end()
})

describe("inline projections", () => {
    test("a new inline projection is backfilled from history recorded before it existed", async () => {
        const before = new PostgresEventStore({ pool })
        await before.append({ events: event("courseWasRegistered", { courseId: "c1", capacity: 10 }) })
        await before.append({ events: event("studentWasSubscribed", { courseId: "c1" }) })

        const { rebuilt } = await startInline(seatsProjection(["courseWasRegistered", "studentWasSubscribed"]))

        expect(rebuilt).toEqual(["SeatsProjection"])
        expect(await seats("c1")).toMatchObject({ capacity: 10, subscribed: 1 })
    })

    test("the read model is current the moment append returns — no consumer, no wait", async () => {
        const { store } = await startInline(seatsProjection(["courseWasRegistered", "studentWasSubscribed"]))

        await store.append({ events: event("courseWasRegistered", { courseId: "c1", capacity: 10 }) })
        await store.append({ events: event("studentWasSubscribed", { courseId: "c1" }) })

        expect(await seats("c1")).toMatchObject({ capacity: 10, subscribed: 1 })
    })

    test("a restart with nothing changed doesn't rebuild", async () => {
        const projection = seatsProjection(["courseWasRegistered"])
        await startInline(projection)
        const { rebuilt } = await startInline(projection)
        expect(rebuilt).toEqual([])
    })

    test("an extension rebuilds, projecting events of the new type recorded before it", async () => {
        const { store } = await startInline(seatsProjection(["courseWasRegistered", "studentWasSubscribed"]))
        await store.append({ events: event("courseWasRegistered", { courseId: "c1", capacity: 10 }) })
        await store.append({ events: event("courseCapacityWasChanged", { courseId: "c1", capacity: 45 }) })
        await store.append({ events: event("studentWasSubscribed", { courseId: "c1" }) })
        expect(await seats("c1")).toMatchObject({ capacity: 10, subscribed: 1 })

        const extended = seatsProjection(["courseWasRegistered", "studentWasSubscribed", "courseCapacityWasChanged"])
        const { store: upgraded, rebuilt } = await startInline(extended)

        expect(rebuilt).toEqual(["SeatsProjection"])
        expect(await seats("c1")).toMatchObject({ capacity: 45, subscribed: 1 })

        // Still inline after the rebuild reactivated it
        await upgraded.append({ events: event("studentWasSubscribed", { courseId: "c1" }) })
        expect(await seats("c1")).toMatchObject({ subscribed: 2 })
    })

    test("a throw in an inline projection rolls back the append", async () => {
        const { store } = await startInline(
            seatsProjection(["courseWasRegistered", "studentWasSubscribed"], { failOn: "studentWasSubscribed" })
        )
        await store.append({ events: event("courseWasRegistered", { courseId: "c1", capacity: 10 }) })

        await expect(store.append({ events: event("studentWasSubscribed", { courseId: "c1" }) })).rejects.toThrow(
            "projection failed on studentWasSubscribed"
        )

        const count = await pool.query("SELECT count(*)::int AS n FROM events WHERE type = 'studentWasSubscribed'")
        expect(count.rows[0].n).toBe(0)
    })
})

describe("async projections", () => {
    test("a new async projection is only recorded — its consumer starts from the beginning", async () => {
        const projection = seatsProjection(["courseWasRegistered"])
        const client = await pool.connect()
        try {
            await projection.init!(client)
        } finally {
            client.release()
        }
        await ensureHandlersInstalled(pool, [projection.name], "_handler_bookmarks")

        const rebuilt = await ensureProjectionsCurrent(pool, new PostgresEventStore({ pool }), [projection])
        expect(rebuilt).toEqual([])
    })

    test("switching a projection from async to inline rebuilds it", async () => {
        const projection = seatsProjection(["courseWasRegistered"])
        const client = await pool.connect()
        try {
            await projection.init!(client)
        } finally {
            client.release()
        }
        await ensureHandlersInstalled(pool, [projection.name], "_handler_bookmarks")
        await ensureProjectionsCurrent(pool, new PostgresEventStore({ pool }), [projection])

        const { rebuilt } = await startInline(projection)
        expect(rebuilt).toEqual(["SeatsProjection"])
    })
})
