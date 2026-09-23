import { Pool } from "pg"
import { waitUntilProcessed } from "@dcb-es/event-store-postgres"
import { getApplication, startAPI } from "@dcb-es/event-store-express"
import type { SequencePosition } from "@dcb-es/event-store"

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

// Creates the event store with the inline projections, brings stored projections up to date
// (rebuilds on a changed fingerprint, backfills new inline ones) and starts the async consumer.
const readModelRuntime = await startReadModels(pool, readModels, imperative)
const eventStore = readModelRuntime.eventStore

const courseWaitFn = (position: SequencePosition, timeoutMs: number) =>
    waitUntilProcessed(pool, COURSE_PROJECTION_NAME, position, { timeoutMs })

const studentWaitFn = (position: SequencePosition, timeoutMs: number) =>
    waitUntilProcessed(pool, STUDENT_PROJECTION_NAME, position, { timeoutMs })

const deps = { store: eventStore, pool, readModels: readModelRuntime }

const app = getApplication({
    apis: [
        configureCors(),
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
    console.log(`  GET  http://localhost:${addr.port}/courses`)
    console.log(`  GET  http://localhost:${addr.port}/openapi.json`)
    console.log(`  GET  http://localhost:${addr.port}/events   (SSE)`)
})

const shutdown = async () => {
    console.log("Shutting down…")
    await readModelRuntime.stop()
    await pool.end()
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
