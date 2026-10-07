import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest"
import { fileURLToPath } from "node:url"
import type { Pool } from "pg"
import supertest from "supertest"
import {
    decider,
    IllegalStateError,
    SequencePosition,
    Tags,
    type Command,
    type Event,
    type EventHandlerWithState,
    type TaggedEvent
} from "@dcb-es/event-store"
import { PostgresEventStore } from "@dcb-es/event-store-postgres"
import { getApplication } from "@dcb-es/event-store-express"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { automationTestApp, recordingWorkflowStarter } from "@test/automationHarness"
import { startTemporalTestServer, withWorker, type TemporalTestServer } from "@test/temporalHarness"
import { defineReadModel, startReadModels, withType, type ReadModelRuntime } from "./readModels.js"
import { automationProcessors, defineAutomation, issueOnce, NonRetryableError, workKey, type Automation } from "./automations.js"
import { temporalWorkflowStarter } from "./temporal.js"
import { configureProcessorStatusRoute } from "./health.js"

// ─── A small domain: a booked parcel goes on the "parcels to ship" list until it's shipped ──────────────────────

type ParcelBooked = Event<"parcelBooked", { parcelId: string; address: string }>
type ParcelShipped = Event<"parcelShipped", { parcelId: string }>

const parcelBooked = (parcelId: string, address = "1 Main St"): TaggedEvent<ParcelBooked> => ({
    event: { type: "parcelBooked", data: { parcelId, address } },
    tags: Tags.fromObj({ parcelId })
})
const parcelShipped = (parcelId: string): TaggedEvent<ParcelShipped> => ({
    event: { type: "parcelShipped", data: { parcelId } },
    tags: Tags.fromObj({ parcelId })
})

interface ParcelToShip {
    [key: string]: unknown
    parcelId: string
    address: string
}

const parcelsToShip = (version = 1) =>
    defineReadModel<ParcelToShip>({
        name: "ParcelsToShip",
        type: "database-projected",
        key: "parcelId",
        collection: "parcels_to_ship",
        version,
        canHandle: ["parcelBooked", "parcelShipped"],
        evolve: (_doc, { event }) => {
            const data = event.data as { parcelId: string; address: string }
            return event.type === "parcelBooked" ? { parcelId: data.parcelId, address: data.address } : null
        }
    })
const ParcelsToShip = parcelsToShip()

type ShipParcel = Command<"shipParcel", { parcelId: string }>
const IsShipped = (parcelId: string): EventHandlerWithState<ParcelShipped, boolean> => ({
    tagFilter: Tags.fromObj({ parcelId }),
    init: false,
    when: { parcelShipped: () => true }
})
const shipParcel = decider<ShipParcel, { shipped: ReturnType<typeof IsShipped> }>({
    handlers: cmd => ({ shipped: IsShipped(cmd.data.parcelId) }),
    decide: (cmd, state) => {
        if (state.shipped) throw new IllegalStateError(`Parcel ${cmd.data.parcelId} already shipped`)
        return parcelShipped(cmd.data.parcelId)
    }
})

// Internal: our event → our command
const shipper = defineAutomation<ParcelToShip>({
    name: "shipper",
    todoList: ParcelsToShip,
    triggers: ["parcelBooked"],
    act: async ({ item, issue }) => issue(shipParcel, { type: "shipParcel", data: { parcelId: item.parcelId } })
})

// External: our event → a workflow
const labeller = (todoList = ParcelsToShip) =>
    defineAutomation<ParcelToShip>({
        name: "label-printer",
        todoList,
        triggers: ["parcelBooked"],
        act: async ({ item, start }) => start("printParcelLabel", [item.parcelId])
    })

// A data input (ADR-039): the courier assigned to a parcel, a read model of its own the command needs
type CourierAssigned = Event<"courierAssigned", { parcelId: string; courier: string }>
type ParcelDispatched = Event<"parcelDispatched", { parcelId: string; courier: string }>
const courierAssigned = (parcelId: string, courier: string): TaggedEvent<CourierAssigned> => ({
    event: { type: "courierAssigned", data: { parcelId, courier } },
    tags: Tags.fromObj({ parcelId })
})
interface ParcelCourier {
    [key: string]: unknown
    parcelId: string
    courier: string
}
const ParcelCouriers = defineReadModel<ParcelCourier>({
    name: "ParcelCouriers",
    type: "live-report",
    key: "parcelId",
    collection: "parcel_couriers",
    version: 1,
    canHandle: ["courierAssigned"],
    evolve: (_doc, { event }) => event.data as ParcelCourier
})
type DispatchParcel = Command<"dispatchParcel", { parcelId: string; courier: string }>
const dispatchParcel = decider<DispatchParcel, { shipped: ReturnType<typeof IsShipped> }>({
    handlers: cmd => ({ shipped: IsShipped(cmd.data.parcelId) }),
    decide: cmd => ({
        event: { type: "parcelDispatched", data: { parcelId: cmd.data.parcelId, courier: cmd.data.courier } } as ParcelDispatched,
        tags: Tags.fromObj({ parcelId: cmd.data.parcelId })
    })
})
const dispatcher = defineAutomation<ParcelToShip>({
    name: "dispatcher",
    todoList: ParcelsToShip,
    triggers: ["parcelBooked"],
    act: async ({ item, read, issue }) => {
        const assigned = await read(ParcelCouriers, item.parcelId)
        if (!assigned) throw new Error(`no courier assigned to ${item.parcelId} yet`)
        await issue(dispatchParcel, { type: "dispatchParcel", data: { parcelId: item.parcelId, courier: assigned.courier } })
    }
})

// ─── Internal work ───────────────────────────────────────────────────────────

describe("an internal automation", () => {
    const app = automationTestApp({ readModels: [ParcelsToShip], automations: [shipper] })

    test("issues its command for an open item, which closes it", async () => {
        await app.given(parcelBooked("p1"))
        expect(await app.appended()).toEqual([{ type: "parcelShipped", data: { parcelId: "p1" } }])
        expect(await app.runtime().reader(ParcelsToShip)("p1")).toBeNull()
    })

    test("does nothing for an item the history already closed", async () => {
        await app.given(parcelBooked("p1"), parcelShipped("p1"))
        expect(await app.appended()).toEqual([])
    })
})

describe("an automation with a data input (ADR-039)", () => {
    const app = automationTestApp({ readModels: [ParcelsToShip, ParcelCouriers], automations: [dispatcher] })

    test("reads the data input as it stands now and passes it into the command", async () => {
        await app.given(courierAssigned("p1", "DPD"), parcelBooked("p1"))
        expect(await app.appended()).toEqual([{ type: "parcelDispatched", data: { parcelId: "p1", courier: "DPD" } }])
    })
})

describe("issueOnce", () => {
    let pool: Pool | undefined
    afterEach(async () => {
        await pool?.end()
        pool = undefined
    })

    test("issues a command once under a key, however often it's asked", async () => {
        const db = (pool = await getTestPgDatabasePool())
        const eventStore = new PostgresEventStore({ pool: db })
        await eventStore.ensureInstalled()
        await issueOnce({ eventStore, pool: db }, "shipper:p1", shipParcel, { type: "shipParcel", data: { parcelId: "p1" } })
        await issueOnce({ eventStore, pool: db }, "shipper:p1", shipParcel, { type: "shipParcel", data: { parcelId: "p1" } })
        const r = await db.query("SELECT type FROM events")
        expect(r.rows).toEqual([{ type: "parcelShipped" }])
    })
})

// ─── A list of one (ADR-040): no stored to-do list, the trigger event is the item ─────────────────────────────

// The carrier's notification, recorded as it arrived at a webhook; a translation turns it into our command
type CarrierNotification = { notificationId: string; parcelId: string; status: string }
const carrierNotified = (notificationId: string, parcelId: string, status = "delivered"): TaggedEvent<Event<"carrierNotificationReceived", CarrierNotification>> => ({
    event: { type: "carrierNotificationReceived", data: { notificationId, parcelId, status } },
    tags: Tags.fromObj({ notificationId, parcelId })
})
type RecordDelivery = Command<"recordDelivery", { parcelId: string }>
type SkipNotification = Command<"skipNotification", { notificationId: string; reason: string; error?: string }>
const IsDelivered = (parcelId: string): EventHandlerWithState<Event<"parcelDelivered", { parcelId: string }>, boolean> => ({
    tagFilter: Tags.fromObj({ parcelId }),
    init: false,
    when: { parcelDelivered: () => true }
})
// One outcome per notification, decided under the append condition: our event, or the notification skipped
const recordDelivery = decider<RecordDelivery & { data: { notificationId: string } }, { delivered: ReturnType<typeof IsDelivered> }>({
    handlers: cmd => ({ delivered: IsDelivered(cmd.data.parcelId) }),
    decide: (cmd, state) =>
        state.delivered
            ? {
                  event: { type: "carrierNotificationSkipped", data: { notificationId: cmd.data.notificationId, reason: "already done" } },
                  tags: Tags.fromObj({ notificationId: cmd.data.notificationId, parcelId: cmd.data.parcelId })
              }
            : {
                  event: { type: "parcelDelivered", data: { parcelId: cmd.data.parcelId } },
                  tags: Tags.fromObj({ notificationId: cmd.data.notificationId, parcelId: cmd.data.parcelId })
              }
})
const IsSkipped = (notificationId: string): EventHandlerWithState<Event<"carrierNotificationSkipped", { notificationId: string }>, boolean> => ({
    tagFilter: Tags.fromObj({ notificationId }),
    init: false,
    when: { carrierNotificationSkipped: () => true }
})
const skipNotification = decider<SkipNotification, { skipped: ReturnType<typeof IsSkipped> }>({
    handlers: cmd => ({ skipped: IsSkipped(cmd.data.notificationId) }),
    decide: cmd => ({ event: { type: "carrierNotificationSkipped", data: cmd.data }, tags: Tags.fromObj({ notificationId: cmd.data.notificationId }) })
})
const carrierTranslation = (giveUpAfter?: number) =>
    defineAutomation<CarrierNotification>({
        name: "carrier-translation",
        key: "notificationId",
        triggers: ["carrierNotificationReceived"],
        act: async ({ item, issue }) => {
            if (item.status === "returned") throw new NonRetryableError(`carrier status ${item.status} has no translation`)
            if (item.status !== "delivered") throw new Error(`unknown status ${item.status}`)
            await issue(recordDelivery, { type: "recordDelivery", data: { parcelId: item.parcelId, notificationId: item.notificationId } })
        },
        giveUp:
            giveUpAfter === undefined
                ? undefined
                : {
                      after: giveUpAfter,
                      record: ({ key, issue }, error) =>
                          issue(skipNotification, {
                              type: "skipNotification",
                              data: { notificationId: key, reason: "failed", error: (error as Error).message }
                          })
                  }
    })

describe("a list of one (ADR-040)", () => {
    const app = automationTestApp({ readModels: [], automations: [carrierTranslation(2)], backoff: { initialMs: 10 } })

    test("works each trigger event as its own item, with no to-do list", async () => {
        await app.given(carrierNotified("n1", "p1"), carrierNotified("n2", "p2"))
        expect(await app.appended()).toEqual([
            { type: "parcelDelivered", data: { parcelId: "p1" } },
            { type: "parcelDelivered", data: { parcelId: "p2" } }
        ])
    })

    test("issues its command under <automation>:<key>: one outcome per item", async () => {
        await app.given(carrierNotified("n1", "p1"))
        // The same item worked again (a replay after a crash) is recognised by its key
        await issueOnce({ eventStore: app.runtime().eventStore, pool: app.pool() }, workKey("carrier-translation", "n1"), recordDelivery, {
            type: "recordDelivery",
            data: { parcelId: "p1", notificationId: "n1" }
        })
        expect(await app.appended()).toEqual([{ type: "parcelDelivered", data: { parcelId: "p1" } }])
    })

    test("a second notification of the same fact is an outcome too: skipped, already done", async () => {
        await app.given(carrierNotified("n1", "p1"), carrierNotified("n2", "p1"))
        expect(await app.appended()).toEqual([
            { type: "parcelDelivered", data: { parcelId: "p1" } },
            { type: "carrierNotificationSkipped", data: { notificationId: "n2", reason: "already done" } }
        ])
    })

    test("gives up on an item that keeps failing: records it, alerts, and works the ones behind it", async () => {
        const log = { error: console.error }
        console.error = () => undefined
        try {
            await app.given(carrierNotified("n1", "p1", "mangled"), carrierNotified("n2", "p2"))
        } finally {
            Object.assign(console, log)
        }
        expect(await app.appended()).toEqual([
            { type: "carrierNotificationSkipped", data: { notificationId: "n1", reason: "failed", error: "unknown status mangled" } },
            { type: "parcelDelivered", data: { parcelId: "p2" } }
        ])
        expect(app.alerts()).toMatchObject([
            { code: "automation-gave-up", severity: "critical", details: { automation: "carrier-translation", key: "n1", attempts: 2 } }
        ])
    })

    test("gives up at once on a failure a retry can't change (NonRetryableError): not retried, so nothing waits behind it", async () => {
        const log = { error: console.error }
        console.error = () => undefined
        try {
            await app.given(carrierNotified("n1", "p1", "returned"), carrierNotified("n2", "p2"))
        } finally {
            Object.assign(console, log)
        }
        expect(await app.appended()).toEqual([
            { type: "carrierNotificationSkipped", data: { notificationId: "n1", reason: "failed", error: "carrier status returned has no translation" } },
            { type: "parcelDelivered", data: { parcelId: "p2" } }
        ])
        expect(app.alerts()).toMatchObject([{ code: "automation-gave-up", details: { key: "n1", attempts: 1 } }])
    })
})

// The same translation keeping a to-do list: a notification is on it until it has an outcome; a failed one stays, marked
interface NotificationToTranslate extends CarrierNotification {
    [key: string]: unknown
    state: "waiting" | "failed"
    error?: string
}
const NotificationsToTranslate = defineReadModel<NotificationToTranslate>({
    name: "NotificationsToTranslate",
    type: "database-projected",
    key: "notificationId",
    collection: "notifications_to_translate",
    version: 1,
    canHandle: ["carrierNotificationReceived", "parcelDelivered", "carrierNotificationSkipped"],
    evolve: (doc, { event }) => {
        if (event.type === "carrierNotificationReceived") return { ...(event.data as CarrierNotification), state: "waiting" }
        const skipped = event.data as { reason?: string; error?: string }
        return event.type === "carrierNotificationSkipped" && skipped.reason === "failed" && doc
            ? { ...doc, state: "failed", error: skipped.error }
            : null
    }
})
const listedTranslation = defineAutomation<NotificationToTranslate>({
    name: "carrier-translation",
    todoList: NotificationsToTranslate,
    triggers: ["carrierNotificationReceived"],
    act: async ({ item, issue }) => {
        if (item.status !== "delivered") throw new Error(`unknown status ${item.status}`)
        await issue(recordDelivery, { type: "recordDelivery", data: { parcelId: item.parcelId, notificationId: item.notificationId } })
    },
    giveUp: {
        after: 2,
        record: ({ key, issue }, error) =>
            issue(skipNotification, { type: "skipNotification", data: { notificationId: key, reason: "failed", error: (error as Error).message } })
    }
})

describe("an automation with a to-do list that gives up (ADR-040)", () => {
    const app = automationTestApp({ readModels: [NotificationsToTranslate], automations: [listedTranslation], backoff: { initialMs: 10 } })

    test("checks an item off with its outcome", async () => {
        await app.given(carrierNotified("n1", "p1"))
        expect(await app.appended()).toEqual([{ type: "parcelDelivered", data: { parcelId: "p1" } }])
        expect(await app.runtime().reader(NotificationsToTranslate)("n1")).toBeNull()
    })

    test("gives up on an item that keeps failing: records it, alerts, keeps it listed as failed, and works the ones behind it", async () => {
        const log = { error: console.error }
        console.error = () => undefined
        try {
            await app.given(carrierNotified("n1", "p1", "mangled"), carrierNotified("n2", "p2"))
        } finally {
            Object.assign(console, log)
        }
        expect(await app.appended()).toEqual([
            { type: "carrierNotificationSkipped", data: { notificationId: "n1", reason: "failed", error: "unknown status mangled" } },
            { type: "parcelDelivered", data: { parcelId: "p2" } }
        ])
        expect(app.alerts()).toMatchObject([{ code: "automation-gave-up", details: { automation: "carrier-translation", key: "n1", attempts: 2 } }])
        expect(await app.runtime().reader(NotificationsToTranslate)("n1")).toMatchObject({ state: "failed", error: "unknown status mangled" })
        expect(await app.runtime().reader(NotificationsToTranslate)("n2")).toBeNull()
    })
})

describe("a list of one, deployed", () => {
    let pool: Pool | undefined
    let runtime: ReadModelRuntime | undefined
    afterEach(async () => {
        await runtime?.stop()
        runtime = undefined
        await pool?.end()
        pool = undefined
    })

    test("works the history it finds, and resumes from its checkpoint after a restart", async () => {
        const db = (pool = await getTestPgDatabasePool())
        const store = new PostgresEventStore({ pool: db })
        await store.ensureInstalled()
        await store.append({ events: [carrierNotified("n1", "p1")] })

        const start = () => startReadModels(db, [], [], automationProcessors([carrierTranslation()], [], { pool: db }))
        const settle = async (r: ReadModelRuntime) => {
            const head = await db.query<{ head: string }>("SELECT max(sequence_position)::text AS head FROM events")
            await r.waitFor("carrier-translation")(SequencePosition.fromString(head.rows[0].head), 10_000)
        }
        runtime = await start()
        await settle(runtime)
        await runtime.stop()

        // Received while the app was down: stored, so nothing is lost
        await store.append({ events: [carrierNotified("n2", "p2")] })
        runtime = await start()
        await settle(runtime)
        const r = await db.query("SELECT type FROM events ORDER BY sequence_position")
        expect(r.rows.map(row => row.type)).toEqual([
            "carrierNotificationReceived",
            "parcelDelivered",
            "carrierNotificationReceived",
            "parcelDelivered"
        ])
    })

    test("needs a to-do list or a key, and at least one trigger", () => {
        expect(() => defineAutomation({ name: "x", triggers: ["a"], act: async () => undefined } as never)).toThrow(/a to-do list, or the key/)
        expect(() => defineAutomation({ name: "x", key: "id", triggers: [], act: async () => undefined })).toThrow(/at least one trigger/)
    })
})

// ─── Work done again on the same item: one key per attempt (ADR-032) ─────────

describe("an automation whose item can be worked again", () => {
    const booked = (parcelId: string, attempt: number): TaggedEvent<ParcelBooked> => ({
        event: { type: "parcelBooked", data: { parcelId, address: "1 Main St", attempt } as ParcelBooked["data"] },
        tags: Tags.fromObj({ parcelId })
    })
    const attemptOf = (event: { event: { data: unknown } }) => (event.event.data as { attempt: number }).attempt
    const printer = defineAutomation<ParcelToShip>({
        name: "label-printer",
        todoList: ParcelsToShip,
        triggers: ["parcelBooked"],
        act: async ({ item, event, start }) => start("printParcelLabel", [item.parcelId], { attempt: attemptOf(event) })
    })
    const app = automationTestApp({ readModels: [ParcelsToShip], automations: [printer] })

    test("starts one workflow per attempt, <automation>:<key>:<attempt>", async () => {
        await app.given(booked("p1", 1), booked("p1", 2))
        expect(app.started().map(s => s.workflowId)).toEqual(["label-printer:p1:1", "label-printer:p1:2"])
    })

    test("work due at a known time is started with its date (ADR-042)", async () => {
        const dueAt = new Date("2026-10-08T09:00:00Z")
        const expirer = defineAutomation<ParcelToShip>({
            name: "parcel-expirer",
            todoList: ParcelsToShip,
            triggers: ["parcelBooked"],
            act: async ({ item, start }) => start("expireParcel", [item.parcelId], { dueAt })
        })
        const pool = await getTestPgDatabasePool()
        const workflows = recordingWorkflowStarter()
        const runtime = await startReadModels(pool, [ParcelsToShip], [], automationProcessors([expirer], [ParcelsToShip], { pool, workflows }))
        try {
            const position = await runtime.eventStore.append({ events: [parcelBooked("p1")] })
            await runtime.waitFor(ParcelsToShip.projection.name)(position, 10_000)
            expect(workflows.started).toEqual([{ workflowType: "expireParcel", workflowId: "parcel-expirer:p1", args: ["p1"], dueAt }])
        } finally {
            await runtime.stop()
            await pool.end()
        }
    })

    test("issues one command per attempt: a later attempt isn't taken for a repeat", async () => {
        const db = app.pool()
        const eventStore = app.runtime().eventStore
        // No rule: every command is accepted, so only the key decides whether it's appended
        const note = decider<Command<"noteParcel", { parcelId: string }>, { notes: EventHandlerWithState<any, number> }>({
            handlers: cmd => ({
                notes: { tagFilter: Tags.fromObj({ parcelId: cmd.data.parcelId }), init: 0, when: { parcelNoted: (_e: unknown, n: number) => n + 1 } }
            }),
            decide: cmd => ({ event: { type: "parcelNoted", data: cmd.data }, tags: Tags.fromObj({ parcelId: cmd.data.parcelId }) })
        })
        const command = { type: "noteParcel" as const, data: { parcelId: "p9" } }
        await issueOnce({ eventStore, pool: db }, workKey("noter", "p9", { attempt: 1 }), note, command)
        await issueOnce({ eventStore, pool: db }, workKey("noter", "p9", { attempt: 1 }), note, command)
        await issueOnce({ eventStore, pool: db }, workKey("noter", "p9", { attempt: 2 }), note, command)
        const r = await db.query("SELECT type FROM events WHERE type = 'parcelNoted'")
        expect(r.rows).toHaveLength(2)
        expect(workKey("noter", "p9")).toBe("noter:p9")
    })
})

// ─── Catching up, rebuilding, failing ────────────────────────────────────────

describe("the automation step", () => {
    let pool: Pool
    let runtime: ReadModelRuntime | undefined
    afterEach(async () => {
        await runtime?.stop()
        runtime = undefined
        await pool?.end()
        pool = undefined as unknown as Pool
    })

    const start = (automation: Automation, workflows = recordingWorkflowStarter(), todoList = ParcelsToShip) =>
        startReadModels(pool, [todoList], [], automationProcessors([automation], [todoList], { pool, workflows }))

    const settle = async (r: ReadModelRuntime) => {
        const head = await pool.query<{ head: string }>("SELECT max(sequence_position)::text AS head FROM events")
        await r.waitFor(ParcelsToShip.projection.name)(SequencePosition.fromString(head.rows[0].head), 10_000)
    }

    test("deployed onto old history, works only the items still open now", async () => {
        pool = await getTestPgDatabasePool()
        const store = new PostgresEventStore({ pool })
        await store.ensureInstalled()
        await store.append({ events: [parcelBooked("p1")] })
        await store.append({ events: [parcelShipped("p1")] })
        await store.append({ events: [parcelBooked("p2")] })

        const workflows = recordingWorkflowStarter()
        runtime = await start(labeller(), workflows)
        await settle(runtime)
        expect(workflows.started).toEqual([{ workflowType: "printParcelLabel", workflowId: "label-printer:p2", args: ["p2"] }])
    })

    test("a rebuild of the list starts nothing again", async () => {
        pool = await getTestPgDatabasePool()
        const workflows = recordingWorkflowStarter()
        runtime = await start(labeller(), workflows)
        await runtime.eventStore.append({ events: [parcelBooked("p1")] })
        await settle(runtime)
        await runtime.stop()

        // A new version of the list is rebuilt from the start at startup (ensureProjectionsCurrent)
        const rebuilt = parcelsToShip(2)
        runtime = await start(labeller(rebuilt), workflows, rebuilt)
        await settle(runtime)
        expect(workflows.started.map(s => s.workflowId)).toEqual(["label-printer:p1"])
        expect(await runtime.reader(rebuilt)("p1")).toEqual({ parcelId: "p1", address: "1 Main St" })
    })

    test("a failure blocks the processor, which says so, and retries the same event until it succeeds", async () => {
        pool = await getTestPgDatabasePool()
        let failures = 2
        const flaky = defineAutomation<ParcelToShip>({
            name: "flaky",
            todoList: ParcelsToShip,
            triggers: ["parcelBooked"],
            act: async ({ item, issue }) => {
                if (failures-- > 0) throw new Error("carrier unavailable")
                await issue(shipParcel, { type: "shipParcel", data: { parcelId: item.parcelId } })
            }
        })
        const logged: string[] = []
        const log = { error: console.error, warn: console.warn }
        console.error = (message: string) => logged.push(message)
        try {
            runtime = await start(flaky)
            await runtime.eventStore.append({ events: [parcelBooked("p1")] })

            const agent = supertest(getApplication({ apis: [configureProcessorStatusRoute(() => runtime!.consumer)] }))
            let blocked: { error: string; eventType: string } | undefined
            for (let i = 0; i < 50 && !blocked; i++) {
                const body = (await agent.get("/health/processors")).body as { processors: { blocked?: { error: string; eventType: string } }[] }
                blocked = body.processors[0]?.blocked
                if (!blocked) await new Promise(r => setTimeout(r, 100))
            }
            expect(blocked).toMatchObject({ error: "carrier unavailable", eventType: "parcelBooked" })

            await settle(runtime)
            const r = await pool.query("SELECT type FROM events ORDER BY sequence_position")
            expect(r.rows.map(row => row.type)).toEqual(["parcelBooked", "parcelShipped"])
            expect((await agent.get("/health/processors")).body.processors[0]).toMatchObject({ state: "running" })
        } finally {
            Object.assign(console, log)
        }
    }, 30_000)

    test("an automation's to-do list must be database-projected", () => {
        const inline = withType(ParcelsToShip, "inline-projected")
        expect(() => automationProcessors([shipper], [inline], { pool: undefined as unknown as Pool })).toThrow(
            /ParcelsToShip must be registered in readModels as database-projected \(it is inline-projected\)/
        )
    })

    test("an automation reacts only to events its list handles", () => {
        expect(() => defineAutomation({ ...shipper, triggers: ["parcelLost"] })).toThrow(/doesn't handle parcelLost/)
    })
})

// ─── External work, in Temporal ──────────────────────────────────────────────

describe("an external automation, in Temporal", () => {
    let temporal: TemporalTestServer
    beforeAll(async () => {
        temporal = await startTemporalTestServer()
    }, 120_000)
    afterAll(async () => temporal?.stop())

    test("starts one workflow per item, however often it's started; the workflow's retries are configuration", async () => {
        const taskQueue = "automations-test"
        const workflows = temporalWorkflowStarter(temporal.env.client, taskQueue)
        let calls = 0
        const activities = {
            printLabel: async (parcelId: string) => {
                if (++calls < 3) throw new Error("printer jammed")
                return `label for ${parcelId}`
            },
            recordShipped: async () => undefined
        }
        const workflowsPath = fileURLToPath(new URL("../test/fixtures/labelWorkflow.ts", import.meta.url))

        await withWorker(temporal, { taskQueue, workflowsPath, activities }, async () => {
            await workflows.start("printParcelLabel", "label-printer:p1", ["p1"])
            await workflows.start("printParcelLabel", "label-printer:p1", ["p1"])
            expect(await temporal.env.client.workflow.getHandle("label-printer:p1").result()).toBe("label for p1")
            // Closed: a later start (a replayed event) is refused, and counts as done
            await workflows.start("printParcelLabel", "label-printer:p1", ["p1"])
        })
        expect(calls).toBe(3)
        const runs: string[] = []
        for await (const run of temporal.env.client.workflow.list({ query: "WorkflowId = 'label-printer:p1'" })) runs.push(run.runId)
        expect(runs).toHaveLength(1)
    }, 60_000)

    describe("through the harness: the processor starts the workflow, whose activity records our command", () => {
        const taskQueue = "automations-harness-test"
        const app = automationTestApp({
            readModels: [ParcelsToShip],
            automations: [labeller()],
            workflows: { start: (...args) => temporalWorkflowStarter(temporal.env.client, taskQueue).start(...args) }
        })

        // The Temporal server lives for the whole file, beyond each test's database: a workflow id used by another
        // test (label-printer:p1 above) has already run, so this test uses its own item key.
        test("given a booked parcel, then it's shipped", async () => {
            const activities = {
                printLabel: async (parcelId: string) => `label for ${parcelId}`,
                recordShipped: (parcelId: string) =>
                    issueOnce({ eventStore: app.runtime().eventStore, pool: app.pool() }, `label-result:${parcelId}`, shipParcel, {
                        type: "shipParcel",
                        data: { parcelId }
                    })
            }
            const workflowsPath = fileURLToPath(new URL("../test/fixtures/labelWorkflow.ts", import.meta.url))
            await withWorker(temporal, { taskQueue, workflowsPath, activities }, async () => {
                await app.given(parcelBooked("p2"))
                expect(await app.waitForAppended(1)).toEqual([{ type: "parcelShipped", data: { parcelId: "p2" } }])
            })
        }, 60_000)
    })
})
