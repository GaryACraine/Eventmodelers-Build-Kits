import { Pool } from "pg"
import { getApplication, startAPI } from "@dcb-es/event-store-express"

import { startReadModels, type ReadModel, type StoredProjectionRegistration } from "./shared/readModels.js"
import type { SliceDependencies } from "./shared/dependencies.js"
import { configureCors } from "./shared/cors.js"
import { configureEventFeedRoute } from "./contexts/enrollment/slices/event-feed/route.js"
import { configureOpenApiRoute } from "./contexts/enrollment/slices/openapi/route.js"

const connectionString = process.env["PG_CONNECTION_STRING"]
if (!connectionString) {
    console.error("PG_CONNECTION_STRING environment variable is required")
    process.exit(1)
}

const port = parseInt(process.env["PORT"] ?? "3000", 10)

const pool = new Pool({ connectionString, max: 20 })

// Every read model, in one place. Each definition's `type` decides how it runs (ADR-022):
//   database-projected → async consumer · inline-projected → inside the append transaction
//   live-report        → folded from the event store on each read
// Inline read models slow every append of their events — keep them few.
const readModels: ReadModel[] = []

// Imperative projections that can't be keyed folds (stored only: async or inline).
const imperative: StoredProjectionRegistration[] = []

// Creates the event store with the inline projections, brings stored projections up to date
// (rebuilds on a changed fingerprint, backfills new inline ones) and starts the async consumer.
const readModelRuntime = await startReadModels(pool, readModels, imperative)
const eventStore = readModelRuntime.eventStore

// Read-your-writes for an async imperative projection, by name: current as of a position (PLAN 14.10b).
export const waitFor = (projectionName: string) => readModelRuntime.waitFor(projectionName)

const deps: SliceDependencies = { store: eventStore, pool, readModels: readModelRuntime }

const app = getApplication({
    apis: [
        configureCors(),
        configureEventFeedRoute(eventStore),
        configureOpenApiRoute()
    ]
})

const server = startAPI(app, { port })

server.on("listening", () => {
    const addr = server.address() as { port: number }
    console.log(`enrollment listening on http://localhost:${addr.port}`)
    console.log(`  GET  http://localhost:${addr.port}/openapi.json`)
})

void deps

const shutdown = async () => {
    console.log("Shutting down…")
    await readModelRuntime.stop()
    await pool.end()
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
