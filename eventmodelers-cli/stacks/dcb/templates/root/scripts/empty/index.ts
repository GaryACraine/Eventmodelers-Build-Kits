import { Pool } from "pg"
import { fileURLToPath } from "node:url"
import { getApplication, onShutdown, startAPI, stopAPI } from "@dcb-es/event-store-express"

import { startReadModels, type ReadModel, type StoredProjectionRegistration } from "./shared/readModels.js"
import { automationProcessors, type Automation } from "./shared/automations.js"
import { startWorker, temporalClient, temporalConfig, temporalWorkflowStarter, watchTemporal } from "./shared/temporal.js"
import { configureProcessorStatusRoute } from "./shared/health.js"
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

// Every automation (ADR-031, ADR-033): a to-do list worked by one processor. Its list is also in `readModels`, as
// database-projected; its automation's processor runs it. Internal ones issue our commands; external ones start a
// Temporal workflow (TEMPORAL_ADDRESS, default localhost:7233; `npm run infra:start`). Every call to Temporal has a
// deadline, TEMPORAL_CALL_TIMEOUT_MS (default 5000): past it a start fails and the processor shows `blocked`.
const automations: Automation[] = []
const temporal = temporalConfig()
const temporalApi = temporalClient(temporal)
const workflows = temporalWorkflowStarter(temporalApi, temporal.taskQueue, { callTimeoutMs: temporal.callTimeoutMs })

// Creates the event store with the inline projections, brings stored projections up to date
// (rebuilds on a changed fingerprint, backfills new inline ones) and starts the async consumer.
const readModelRuntime = await startReadModels(pool, readModels, imperative, {
    processorFor: automationProcessors(automations, readModels, { pool, workflows })
})
const eventStore = readModelRuntime.eventStore

// The external automations' activities (each slice's `activities.ts`), run by the Temporal worker in this process
// with the workflows in `workflows.ts`. No activities, no worker.
const activities = {}
const worker =
    Object.keys(activities).length > 0
        ? startWorker({ config: temporal, workflowsPath: fileURLToPath(new URL("./workflows.js", import.meta.url)), activities })
        : undefined
// Health asks Temporal in the background (TEMPORAL_HEALTH_INTERVAL_MS, default 5000), so it never waits on it
const temporalWatch = worker ? watchTemporal(temporalApi, temporal, worker) : undefined

// Read-your-writes for an async imperative projection, by name: current as of a position (PLAN 14.10b).
export const waitFor = (projectionName: string) => readModelRuntime.waitFor(projectionName)

const deps: SliceDependencies = { store: eventStore, pool, readModels: readModelRuntime }

const app = getApplication({
    apis: [
        configureCors(),
        configureProcessorStatusRoute(() => readModelRuntime.consumer, {
            // With external automations, health also asks Temporal directly and reports this process's worker
            ...(temporalWatch ? { temporal: () => temporalWatch.status() } : {})
        }),
        configureEventFeedRoute(eventStore),
        configureOpenApiRoute()
    ]
})

const server = startAPI(app, { port })

server.on("listening", () => {
    const addr = server.address() as { port: number }
    console.log(`enrollment listening on http://localhost:${addr.port}`)
    console.log(`  GET  http://localhost:${addr.port}/openapi.json`)
    console.log(`  GET  http://localhost:${addr.port}/health/processors`)
})

void deps

// Once, whatever signals arrive: stop taking requests (ending the SSE feed), stop the projections, end the pool.
// A second Ctrl-C during it exits at once.
onShutdown(async () => {
    console.log("Shutting down…")
    await stopAPI(server)
    temporalWatch?.stop()
    await worker?.stop()
    await readModelRuntime.stop()
    await pool.end()
})
