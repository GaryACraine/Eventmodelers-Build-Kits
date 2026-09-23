import { beforeEach, afterEach } from "vitest"
import supertest from "supertest"
import type { Pool } from "pg"
import { SequencePosition } from "@dcb-es/event-store"
import { waitUntilProcessed } from "@dcb-es/event-store-postgres"
import { getApplication, type WebApiSetup } from "@dcb-es/event-store-express"
import { getTestPgDatabasePool } from "./testPgDbPool.js"
import { startReadModels, type ReadModel, type ReadModelRuntime, type StoredProjectionRegistration } from "../shared/readModels.js"
import type { SliceDependencies } from "../shared/dependencies.js"

export interface ReadModelTestApp {
    /** A supertest agent over the app built from `routes` */
    agent(): supertest.Agent
    /** Wait until every async read model has caught up with the event store (no-op for inline and live) */
    settle(): Promise<void>
    deps(): SliceDependencies
    runtime(): ReadModelRuntime
}

/**
 * Registers beforeEach/afterEach hooks in the calling `describe`: every test gets a fresh database,
 * the read models started by their registered type, and an app from `routes`. Tests talk HTTP and
 * assert bodies only, so the same test passes whichever type serves the read model (ADR-022).
 */
export function readModelTestApp(options: {
    readModels: ReadModel<any, any>[]
    imperative?: StoredProjectionRegistration[]
    routes: (deps: SliceDependencies) => WebApiSetup[]
}): ReadModelTestApp {
    let pool: Pool
    let runtime: ReadModelRuntime
    let deps: SliceDependencies
    let agent: supertest.Agent

    beforeEach(async () => {
        pool = await getTestPgDatabasePool({ max: 10 })
        runtime = await startReadModels(pool, options.readModels, options.imperative)
        deps = { store: runtime.eventStore, pool, readModels: runtime }
        agent = supertest.agent(getApplication({ apis: options.routes(deps) }))
    })

    afterEach(async () => {
        await runtime?.stop()
        await pool?.end()
    })

    return {
        agent: () => agent,
        settle: async () => {
            const r = await pool.query<{ head: string | null }>("SELECT max(sequence_position)::text AS head FROM events")
            const head = r.rows[0]?.head
            if (!head) return
            const position = SequencePosition.fromString(head)
            const asyncNames = [
                ...options.readModels.filter(m => m.type === "database-projected").map(m => m.projection.name),
                ...(options.imperative ?? []).filter(p => p.type === "database-projected").map(p => p.projection.name)
            ]
            for (const name of asyncNames) await waitUntilProcessed(pool, name, position, { timeoutMs: 5000 })
        },
        deps: () => deps,
        runtime: () => runtime
    }
}
