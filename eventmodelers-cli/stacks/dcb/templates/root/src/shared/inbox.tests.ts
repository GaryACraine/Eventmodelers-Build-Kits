import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { createHmac, timingSafeEqual } from "node:crypto"
import type { Pool } from "pg"
import supertest from "supertest"
import { Tags } from "@dcb-es/event-store"
import { PostgresEventStore } from "@dcb-es/event-store-postgres"
import { getApplication } from "@dcb-es/event-store-express"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { configureJsonBody, configureWebhookInbox, type WebhookInbox } from "./inbox.js"
import type { Alert } from "./alerts.js"

// A carrier's webhooks, signed with a shared secret over the body as it was sent
const secret = "carrier-secret"
const sign = (body: string) => createHmac("sha256", secret).update(body).digest("hex")
const carrierInbox: WebhookInbox = {
    system: "carrier",
    path: "/webhooks/carrier",
    verify: (rawBody, headers) => {
        const given = Buffer.from(String(headers["carrier-signature"] ?? ""))
        const expected = Buffer.from(sign(rawBody.toString("utf8")))
        return given.length === expected.length && timingSafeEqual(given, expected)
    },
    toEvent: body => {
        const { notification_id, parcel_id } = body as { notification_id: string; parcel_id: string }
        if (!parcel_id) throw new Error("no parcel_id")
        return {
            id: notification_id,
            event: {
                event: { type: "carrierNotificationReceived", data: body as Record<string, unknown> },
                tags: Tags.fromObj({ notificationId: notification_id, parcelId: parcel_id })
            }
        }
    }
}

describe("a webhook inbox (ADR-040)", () => {
    let pool: Pool
    let alerts: Alert[]
    let agent: ReturnType<typeof supertest>

    beforeEach(async () => {
        pool = await getTestPgDatabasePool()
        const eventStore = new PostgresEventStore({ pool })
        await eventStore.ensureInstalled()
        alerts = []
        agent = supertest(
            getApplication({
                disableJsonMiddleware: true,
                apis: [configureJsonBody(), configureWebhookInbox({ eventStore, alert: a => alerts.push(a) }, carrierInbox)]
            })
        )
    })
    afterEach(async () => pool?.end())

    // Sent as text, so the bytes signed are the bytes received (the spacing is the sender's)
    const deliver = (body: string, signature = sign(body)) =>
        agent.post("/webhooks/carrier").set("Content-Type", "application/json").set("Carrier-Signature", signature).send(body)
    const recorded = async () => {
        const r = await pool.query<{ type: string; payload: string; tags: string[] }>("SELECT type, payload, tags FROM events ORDER BY sequence_position")
        return r.rows.map(row => ({ type: row.type, data: (JSON.parse(row.payload) as { data: unknown }).data }))
    }
    const delivered = '{ "notification_id": "n1",  "parcel_id": "p1", "status": "delivered" }'

    test("records a signed notification as it arrived, and answers 200", async () => {
        const response = await deliver(delivered)
        expect(response.status).toBe(200)
        expect(await recorded()).toEqual([
            { type: "carrierNotificationReceived", data: { notification_id: "n1", parcel_id: "p1", status: "delivered" } }
        ])
        const tags = await pool.query<{ tags: string[] }>("SELECT tags FROM events")
        expect([...tags.rows[0].tags].sort()).toEqual(["notificationId=n1", "parcelId=p1"])
    })

    test("a redelivery answers 200 and records nothing again", async () => {
        await deliver(delivered)
        const again = await deliver(delivered)
        expect(again.status).toBe(200)
        expect(await recorded()).toHaveLength(1)
    })

    test("a bad signature answers 401 and records nothing", async () => {
        expect((await deliver(delivered, sign("something else"))).status).toBe(401)
        expect((await agent.post("/webhooks/carrier").set("Content-Type", "application/json").send(delivered)).status).toBe(401)
        expect(await recorded()).toEqual([])
    })

    test("a signed notification we can't read answers 400, records nothing, and alerts", async () => {
        const response = await deliver('{"notification_id":"n2"}')
        expect(response.status).toBe(400)
        expect(await recorded()).toEqual([])
        expect(alerts).toMatchObject([{ code: "inbox-unreadable", severity: "critical", details: { system: "carrier", error: "no parcel_id" } }])
    })

    test("a failed append answers 5xx, so the other system delivers it again", async () => {
        await pool.end()
        const log = console.error
        console.error = () => undefined
        try {
            expect((await deliver(delivered)).status).toBeGreaterThanOrEqual(500)
        } finally {
            console.error = log
            pool = await getTestPgDatabasePool()
        }
    })

    test("without the kit's JSON parser there's no raw body to check: 5xx, nothing recorded", async () => {
        const eventStore = new PostgresEventStore({ pool })
        const log = console.error
        console.error = () => undefined
        try {
            const unwired = supertest(getApplication({ apis: [configureWebhookInbox({ eventStore }, carrierInbox)] }))
            const response = await unwired.post("/webhooks/carrier").set("Content-Type", "application/json").set("Carrier-Signature", sign(delivered)).send(delivered)
            expect(response.status).toBeGreaterThanOrEqual(500)
        } finally {
            console.error = log
        }
        expect(await recorded()).toEqual([])
    })

    test("other routes still get their JSON body", async () => {
        const app = getApplication({
            disableJsonMiddleware: true,
            apis: [configureJsonBody(), router => router.post("/echo", (req, res) => void res.json({ got: req.body, raw: "rawBody" in req }))]
        })
        const response = await supertest(app).post("/echo").send({ a: 1 })
        expect(response.body).toEqual({ got: { a: 1 }, raw: false })
    })
})
