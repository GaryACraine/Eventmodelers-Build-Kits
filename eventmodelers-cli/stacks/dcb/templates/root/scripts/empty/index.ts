import { Pool } from "pg"
import {
    PostgresEventStore,
    createConsumer,
    projectionToProcessor,
    ensureHandlersInstalled,
    waitUntilProcessed,
    type Projection
} from "@dcb-es/event-store-postgres"
import { getApplication, startAPI } from "@dcb-es/event-store-express"
import type { SequencePosition } from "@dcb-es/event-store"

import { ensureProjectionsCurrent } from "./shared/ensureProjectionsCurrent.js"
import { configureEventFeedRoute } from "./contexts/enrollment/slices/event-feed/route.js"

const connectionString = process.env["PG_CONNECTION_STRING"]
if (!connectionString) {
    console.error("PG_CONNECTION_STRING environment variable is required")
    process.exit(1)
}

const port = parseInt(process.env["PORT"] ?? "3000", 10)

const pool = new Pool({ connectionString, max: 20 })

// Inline projections run inside the append transaction: their read models are current the moment a
// command returns. Every append of one of their events waits for them — keep this list short.
// `ensureInstalled()` registers and inits them; they need no consumer and no waitFn.
const inlineProjections: Projection[] = []

const eventStore = new PostgresEventStore({ pool, inlineProjections })

await eventStore.ensureInstalled()

// Every async projection, in one place: init, bookmarks, fingerprint check, consumer.
const projections: Projection[] = []

const initClient = await pool.connect()
try {
    for (const projection of projections) await projection.init!(initClient)
} finally {
    initClient.release()
}

await ensureHandlersInstalled(pool, projections.map(p => p.name), "_handler_bookmarks")

// Rebuild any projection whose handled events (or version) changed since the last start —
// events of a newly handled type recorded before this deploy would otherwise be skipped — and
// backfill any inline projection seen for the first time.
await ensureProjectionsCurrent(pool, eventStore, projections, { inline: inlineProjections })

const consumer = createConsumer({
    pool,
    eventStore,
    processors: projections.map(p => projectionToProcessor(p, { batchSize: 100, startFrom: "BEGINNING" }))
})

export const waitFor = (projectionName: string) => (position: SequencePosition, timeoutMs: number) =>
    waitUntilProcessed(pool, projectionName, position, { timeoutMs })

const deps = { store: eventStore, pool }

const app = getApplication({
    apis: [
        configureEventFeedRoute(eventStore)
    ]
})

const server = startAPI(app, { port })

server.on("listening", () => {
    const addr = server.address() as { port: number }
    console.log(`enrollment listening on http://localhost:${addr.port}`)
})

void deps

const shutdown = async () => {
    console.log("Shutting down…")
    await consumer.stop()
    await pool.end()
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
