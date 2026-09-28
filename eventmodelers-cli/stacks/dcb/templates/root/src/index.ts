import { Pool } from "pg"
import { fileURLToPath } from "node:url"
import { getApplication, onShutdown, startAPI, stopAPI } from "@dcb-es/event-store-express"

import {
    courseDetailsProjection,
    COURSE_PROJECTION_NAME
} from "./contexts/enrollment/slices/course-details/projection.js"
import {
    studentDetailsProjection,
    STUDENT_PROJECTION_NAME
} from "./contexts/enrollment/slices/student-details/projection.js"

import { configureCors } from "./shared/cors.js"
import { startReadModels, type ReadModel, type StoredProjectionRegistration } from "./shared/readModels.js"
import { automationProcessors, type Automation } from "./shared/automations.js"
import { startWorker, temporalClient, temporalConfig, temporalWorkflowStarter, watchTemporal } from "./shared/temporal.js"
import { configureProcessorStatusRoute } from "./shared/health.js"

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

const connectionString = process.env["PG_CONNECTION_STRING"]
if (!connectionString) {
    console.error("PG_CONNECTION_STRING environment variable is required")
    process.exit(1)
}

const port = parseInt(process.env["PORT"] ?? "3000", 10)

const pool = new Pool({ connectionString, max: 20 })

// Every read model, in one place. Keyed-fold read models (`defineReadModel`) go in `readModels`, and
// each one's `type` decides how it runs (ADR-022). Imperative projections that can't be keyed folds are
// stored only: async or inline. Inline read models slow every append of their events — keep them few.
const readModels: ReadModel[] = []
const imperative: StoredProjectionRegistration[] = [
    { projection: courseDetailsProjection, type: "database-projected" },
    { projection: studentDetailsProjection, type: "database-projected" }
]

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

// Read-your-writes waits for the imperative projections (current as of a position, PLAN 14.10b).
const courseWaitFn = readModelRuntime.waitFor(COURSE_PROJECTION_NAME)
const studentWaitFn = readModelRuntime.waitFor(STUDENT_PROJECTION_NAME)

const deps = { store: eventStore, pool, readModels: readModelRuntime }

const app = getApplication({
    apis: [
        configureCors(),
        configureProcessorStatusRoute(() => readModelRuntime.consumer, {
            // With external automations, health also asks Temporal directly and reports this process's worker
            ...(temporalWatch ? { temporal: () => temporalWatch.status() } : {})
        }),
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

const server = startAPI(app, { port })

server.on("listening", () => {
    const addr = server.address() as { port: number }
    console.log(`course-manager listening on http://localhost:${addr.port}`)
    console.log(`  GET  http://localhost:${addr.port}/health/live`)
    console.log(`  GET  http://localhost:${addr.port}/health/processors`)
    console.log(`  GET  http://localhost:${addr.port}/course-list`)
    console.log(`  GET  http://localhost:${addr.port}/openapi.json`)
    console.log(`  GET  http://localhost:${addr.port}/events   (SSE)`)
})

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
