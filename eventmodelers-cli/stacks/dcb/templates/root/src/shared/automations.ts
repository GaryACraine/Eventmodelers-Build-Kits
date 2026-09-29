/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Pool, PoolClient } from "pg"
import { handle, type Command, type Decider, type EventHandler, type EventStore, type SequencedEvent } from "@dcb-es/event-store"
import {
    projectionToProcessor,
    type ConsumerProcessorConfig,
    type Projection,
    type ProjectionProcessorOptions
} from "@dcb-es/event-store-postgres"
import { readLive, tagValues, type ReadModel, type ReadModelDoc } from "./readModels.js"
import { findExistingPosition, idempotencyKeyFor } from "./idempotency.js"

/**
 * Automations are to-do lists worked by one processor (ADR-031, ADR-033).
 *
 * The model reads: an opening event → the to-do list (a read model) → the automation → its command → the closing
 * event, which ticks the item off. The automation's processor runs two steps for each event, in this order:
 *
 *   1. the list step: the to-do list's own projection opens or closes the item;
 *   2. the automation step, for a trigger event (the model's `reacts-to`) and unless the processor is rebuilding:
 *      the item as it stands now (a live fold of its key's events, `readLive`) and, if it's open, `act`.
 *
 * "As it stands now", not as the stored row stood at this event: while the processor catches up on old history,
 * an item a later event closed (an order paid long ago) mustn't be worked again.
 *
 * `act` does the work: `issue` for our own command (internal work, with the idempotency key
 * `<automation>:<item key>`), `start` for a Temporal workflow (external work, the workflow id `<automation>:<item
 * key>`). Neither catches an error: a failure blocks the processor, which retries the same event (the library's
 * fail fast) and shows it on `GET /health/processors`.
 *
 * An item whose work can be done again (a payment tried again after a decline or a stall, ADR-032) passes the
 * **attempt** its trigger belongs to: the key becomes `<automation>:<item key>:<attempt>`, so each attempt is worked
 * once and a later attempt isn't mistaken for a repeat of the first.
 */

export interface AutomationContext<TItem extends ReadModelDoc> {
    /** The open item, as it stands now */
    item: TItem
    /** The item's key: the to-do list's key value, e.g. the orderId */
    key: string
    /** The trigger event being handled */
    event: SequencedEvent
    /** Issue one of our commands, once: the idempotency key is `<automation>:<item key>[:<attempt>]` */
    issue<C extends Command>(decider: Decider<C, any>, command: C, options?: AttemptOptions): Promise<void>
    /** Start a Temporal workflow, once: its id is `<automation>:<item key>[:<attempt>]` */
    start(workflowType: string, args: unknown[], options?: AttemptOptions): Promise<void>
}

export interface AttemptOptions {
    /** The attempt the trigger belongs to, for work that can be done again on the same item (e.g. a payment's attempt) */
    attempt?: number
}

/** The key an item's work is done once under: `<automation>:<item key>`, plus `:<attempt>` when given. */
export function workKey(automation: string, key: string, options?: AttemptOptions): string {
    return options?.attempt === undefined ? `${automation}:${key}` : `${automation}:${key}:${options.attempt}`
}

export interface Automation<TItem extends ReadModelDoc = any> {
    /** The name its keys are built from, e.g. "stock-returner" (from the model's description) */
    name: string
    /** The to-do list. Registered in `readModels` as database-projected; the automation's processor runs it. */
    todoList: ReadModel<TItem, any>
    /** The event types the automation reacts to (the model's `reacts-to`). The to-do list handles each of them. */
    triggers: string[]
    act(context: AutomationContext<TItem>): Promise<void>
}

export function defineAutomation<TItem extends ReadModelDoc>(automation: Automation<TItem>): Automation<TItem> {
    const unhandled = automation.triggers.filter(type => !automation.todoList.canHandle.includes(type))
    if (unhandled.length > 0) {
        throw new Error(
            `${automation.name}: its to-do list ${automation.todoList.name} doesn't handle ${unhandled.join(", ")}. ` +
                "An automation reacts to events its list folds, keyed by the list's key."
        )
    }
    return automation
}

/** Starts workflows: Temporal in the app (`temporalWorkflowStarter`), a recorder in tests. */
export interface WorkflowStarter {
    /** Start `workflowType` under `workflowId` unless a workflow of that id has already run. A repeat does nothing. */
    start(workflowType: string, workflowId: string, args: unknown[]): Promise<void>
}

export interface AutomationDependencies {
    eventStore: EventStore
    pool: Pool
    /** Absent when no automation starts workflows */
    workflows?: WorkflowStarter
}

/**
 * Issue a command once under `key` (e.g. `"payment-result:o1"`). A command already appended under the same key is
 * not decided again, so a retry after a crash, or a second delivery, changes nothing. Used by `act` (`issue`) and by
 * workflow activities that record the answer of an outside system.
 */
export async function issueOnce<C extends Command>(
    deps: { eventStore: EventStore; pool: Pool | PoolClient },
    key: string,
    decider: Decider<C, any>,
    command: C
): Promise<void> {
    const idempotencyKey = idempotencyKeyFor(key)
    if (await findExistingPosition(deps.pool, idempotencyKey)) return
    await handle(deps.eventStore, decider, command, { idempotencyKey })
}

/** The automation's processor: the to-do list's projection (its name and bookmark), plus the automation step. */
export function automationProcessor(
    automation: Automation,
    deps: AutomationDependencies,
    options?: ProjectionProcessorOptions
): ConsumerProcessorConfig {
    const list = projectionToProcessor(automation.todoList.projection, options)
    return {
        ...list,
        handlerFactory: (client, context) => {
            const listStep = list.handlerFactory(client, context)
            const when = Object.fromEntries(
                Object.entries(listStep.when).map(([type, step]) => [
                    type,
                    async (event: SequencedEvent) => {
                        await (step as (event: SequencedEvent) => Promise<void>)(event)
                        if (context.rebuilding || !automation.triggers.includes(type)) return
                        for (const key of tagValues(event, automation.todoList.key)) {
                            const item = await readLive(deps.eventStore, automation.todoList, key)
                            if (!item) continue
                            await automation.act({
                                item,
                                key,
                                event,
                                issue: (decider, command, options) =>
                                    issueOnce(deps, workKey(automation.name, key, options), decider, command),
                                start: async (workflowType, args, options) => {
                                    if (!deps.workflows) {
                                        throw new Error(`${automation.name}: no workflow starter (is TEMPORAL_ADDRESS set?)`)
                                    }
                                    await deps.workflows.start(workflowType, workKey(automation.name, key, options), args)
                                }
                            })
                        }
                    }
                ])
            )
            return { when } as EventHandler<any, any>
        }
    }
}

/**
 * The hook `startReadModels` takes: each automation's processor replaces its to-do list's plain processor. Refuses to
 * start when a to-do list isn't registered as database-projected: an inline or live list has no processor to run the
 * automation step in.
 */
export function automationProcessors(
    automations: Automation[],
    readModels: ReadModel<any, any>[],
    deps: Omit<AutomationDependencies, "eventStore">
): (projection: Projection, eventStore: EventStore, options: ProjectionProcessorOptions) => ConsumerProcessorConfig | undefined {
    for (const automation of automations) {
        const registered = readModels.find(r => r.name === automation.todoList.name)
        if (registered?.type !== "database-projected") {
            throw new Error(
                `${automation.name}: its to-do list ${automation.todoList.name} must be registered in readModels as ` +
                    `database-projected (it is ${registered ? registered.type : "not registered"}). ADR-031.`
            )
        }
    }
    return (projection, eventStore, options) => {
        const automation = automations.find(a => a.todoList.projection.name === projection.name)
        return automation ? automationProcessor(automation, { ...deps, eventStore }, options) : undefined
    }
}
