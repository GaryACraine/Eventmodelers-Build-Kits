import { beforeEach, afterEach } from "vitest"
import type { Pool } from "pg"
import { SequencePosition, type TaggedEvent } from "@dcb-es/event-store"
import { waitUntilProcessed } from "@dcb-es/event-store-postgres"
import { getTestPgDatabasePool } from "./testPgDbPool.js"
import { startReadModels, type ReadModel, type ReadModelRuntime } from "../shared/readModels.js"
import { automationProcessors, type Automation, type WorkflowStarter } from "../shared/automations.js"
import type { Alert } from "../shared/alerts.js"
import type { Backoff } from "@dcb-es/event-store-postgres"

/**
 * GIVEN/THEN tests for automations (ADR-031, ADR-033): a fresh database per test, the read models and automations
 * started as the app starts them, and a recorder in place of Temporal (unless `workflows` is given).
 *
 *   const app = automationTestApp({ readModels: [StockToReturn], automations: [stockReturner] })
 *   test("returns the stock of an order whose payment failed", async () => {
 *       await app.given(stockDeducted({ … }), orderPaymentFailed({ … }))
 *       expect(await app.appended()).toEqual([{ type: "stockReturned", data: { … } }])
 *   })
 *
 * THEN is one of: the command's events (`appended()`), nothing (`appended()` is `[]`), or a workflow started
 * (`started()`).
 */
export interface AutomationTestApp {
    /**
     * Append the GIVEN events in one append (so the automation never sees part of the history), then wait until
     * every async read model and automation has handled them, and anything that caused.
     */
    given(...events: TaggedEvent[]): Promise<void>
    /** The events appended after the GIVEN events: what the automation did */
    appended(): Promise<{ type: string; data: unknown }[]>
    /**
     * The same, once at least `count` have been appended: an external automation's workflow records its command after
     * the processor has moved on. Fails after `timeoutMs`.
     */
    waitForAppended(count: number, timeoutMs?: number): Promise<{ type: string; data: unknown }[]>
    /** The workflows started, when the recorder stands in for Temporal */
    started(): StartedWorkflow[]
    /** The alerts raised: a list of one that gave up on an item (ADR-040) */
    alerts(): Alert[]
    /** Wait again: every async read model and automation caught up with the event store */
    settle(): Promise<void>
    runtime(): ReadModelRuntime
    pool(): Pool
}

export interface StartedWorkflow {
    workflowType: string
    workflowId: string
    args: unknown[]
    /** When the work is due, for a start with a delay (ADR-042) */
    dueAt?: Date
}

/** Records starts, and like Temporal's `REJECT_DUPLICATE` ignores a second start of the same id. */
export function recordingWorkflowStarter(): WorkflowStarter & { started: StartedWorkflow[] } {
    const started: StartedWorkflow[] = []
    return {
        started,
        async start(workflowType, workflowId, args, options) {
            if (started.some(s => s.workflowId === workflowId)) return
            started.push({ workflowType, workflowId, args, ...(options?.dueAt ? { dueAt: options.dueAt } : {}) })
        }
    }
}

export function automationTestApp(options: {
    readModels: ReadModel<any, any>[]
    automations: Automation[]
    /** Temporal (a `temporalWorkflowStarter` on the test server); the recorder when absent */
    workflows?: WorkflowStarter
    /** The wait between a list of one's attempts on a failing item. The library's (1 s, doubling) when absent */
    backoff?: Backoff
}): AutomationTestApp {
    let pool: Pool
    let runtime: ReadModelRuntime
    let recorder: ReturnType<typeof recordingWorkflowStarter>
    let givenHead: string | null = null
    let alerts: Alert[] = []
    // What has a checkpoint: each database-projected read model, and each list of one (named after the automation)
    const processorNames = [
        ...options.readModels.filter(r => r.type === "database-projected").map(r => r.projection.name),
        ...options.automations.filter(a => !("todoList" in a)).map(a => a.name)
    ]

    const settle = async () => {
        // Each wait can lead to more events (the automation's command), which the next pass waits for.
        for (let pass = 0; pass < 5; pass++) {
            const head = await headPosition(pool)
            if (!head) return
            for (const name of processorNames) {
                await waitUntilProcessed(pool, name, SequencePosition.fromString(head), { timeoutMs: 10_000 })
            }
            if ((await headPosition(pool)) === head) return
        }
    }

    beforeEach(async () => {
        pool = await getTestPgDatabasePool({ max: 10 })
        recorder = recordingWorkflowStarter()
        givenHead = null
        alerts = []
        runtime = await startReadModels(
            pool,
            options.readModels,
            [],
            automationProcessors(
                options.automations,
                options.readModels,
                { pool, workflows: options.workflows ?? recorder, alert: a => alerts.push(a) },
                options.backoff ? { backoff: options.backoff } : undefined
            )
        )
    })

    afterEach(async () => {
        await runtime?.stop()
        await pool?.end()
    })

    const appended = async () => {
        const r = await pool.query<{ type: string; payload: string }>(
            "SELECT type, payload FROM events WHERE sequence_position > $1::bigint ORDER BY sequence_position",
            [givenHead ?? "0"]
        )
        return r.rows.map(row => ({ type: row.type, data: (JSON.parse(row.payload) as { data: unknown }).data }))
    }

    return {
        given: async (...events) => {
            await runtime.eventStore.append({ events })
            givenHead = await headPosition(pool)
            await settle()
        },
        appended,
        waitForAppended: async (count, timeoutMs = 15_000) => {
            const deadline = Date.now() + timeoutMs
            for (;;) {
                const events = await appended()
                if (events.length >= count) return events
                if (Date.now() > deadline) throw new Error(`expected ${count} event(s) after the GIVEN events within ${timeoutMs} ms, got ${events.length}`)
                await new Promise(resolve => setTimeout(resolve, 100))
            }
        },
        started: () => recorder.started,
        alerts: () => alerts,
        settle,
        runtime: () => runtime,
        pool: () => pool
    }
}

async function headPosition(pool: Pool): Promise<string | null> {
    const r = await pool.query<{ head: string | null }>("SELECT max(sequence_position)::text AS head FROM events")
    return r.rows[0]?.head ?? null
}
