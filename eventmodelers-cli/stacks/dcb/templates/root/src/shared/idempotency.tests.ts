import { describe, test, expect, afterEach } from "vitest"
import { randomUUID } from "node:crypto"
import type { Pool } from "pg"
import { decider, handle, Tags, type Command, type Event, type EventHandlerWithState } from "@dcb-es/event-store"
import { PostgresEventStore } from "@dcb-es/event-store-postgres"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { findExistingPosition, idempotencyKeyFor } from "./idempotency.js"

// A command that records two events, like placeOrder (the order and its payment), and one that records one.
type Book = Command<"book", { id: string }>
const Booked = (id: string): EventHandlerWithState<Event<"booked", { id: string }>, boolean> => ({
    tagFilter: Tags.fromObj({ id }),
    init: false,
    when: { booked: () => true }
})
type Handlers = { booked: ReturnType<typeof Booked> }
const bookTwo = decider<Book, Handlers>({
    handlers: cmd => ({ booked: Booked(cmd.data.id) }),
    decide: cmd => [
        { event: { type: "booked", data: { id: cmd.data.id } }, tags: Tags.fromObj({ id: cmd.data.id }) },
        { event: { type: "charged", data: { id: cmd.data.id } }, tags: Tags.fromObj({ id: cmd.data.id }) }
    ]
})
const bookOne = decider<Book, Handlers>({
    handlers: cmd => ({ booked: Booked(cmd.data.id) }),
    decide: cmd => ({ event: { type: "booked", data: { id: cmd.data.id } }, tags: Tags.fromObj({ id: cmd.data.id }) })
})

describe("findExistingPosition", () => {
    let pool: Pool | undefined
    afterEach(async () => {
        await pool?.end()
        pool = undefined
    })

    const store = async () => {
        pool = await getTestPgDatabasePool()
        const eventStore = new PostgresEventStore({ pool })
        await eventStore.ensureInstalled()
        return { eventStore, db: pool }
    }

    test("finds a command of several events by its key", async () => {
        const { eventStore, db } = await store()
        const key = randomUUID()
        const position = await handle(eventStore, bookTwo, { type: "book", data: { id: "b1" } }, { idempotencyKey: key })
        expect((await findExistingPosition(db, key))?.toString()).toBe((BigInt(position.toString()) - 1n).toString())
    })

    test("finds a command of one event by its key", async () => {
        const { eventStore, db } = await store()
        const key = randomUUID()
        const position = await handle(eventStore, bookOne, { type: "book", data: { id: "b1" } }, { idempotencyKey: key })
        expect((await findExistingPosition(db, key))?.toString()).toBe(position.toString())
    })

    test("finds nothing for a new key, or none", async () => {
        const { db } = await store()
        expect(await findExistingPosition(db, randomUUID())).toBeUndefined()
        expect(await findExistingPosition(db, undefined)).toBeUndefined()
    })

    test("a name gives the same key every time", () => {
        expect(idempotencyKeyFor("stock-returner:o1")).toBe(idempotencyKeyFor("stock-returner:o1"))
        expect(idempotencyKeyFor("stock-returner:o1")).not.toBe(idempotencyKeyFor("stock-returner:o2"))
    })
})
