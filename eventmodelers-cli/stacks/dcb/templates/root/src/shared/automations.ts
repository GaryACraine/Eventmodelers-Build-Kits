/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Pool, PoolClient } from "pg"
import { handle, Query, type Command, type Decider, type EventHandler, type EventStore, type SequencedEvent } from "@dcb-es/event-store"
import {
    projectionToProcessor,
    type ConsumerProcessorConfig,
    type Projection,
    type ProjectionProcessorOptions
} from "@dcb-es/event-store-postgres"
import { readLive, tagValues, type ReadModel, type ReadModelDoc, type StartReadModelsOptions } from "./readModels.js"
import { findExistingPosition, idempotencyKeyFor } from "./idempotency.js"
import { alert as defaultAlert, type Alert } from "./alerts.js"

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
 *
 * **A list of one** (ADR-040) has no stored to-do list: the trigger event is the item, e.g. another system's
 * notification recorded at a webhook, which a translation turns into our command. It has a processor and a checkpoint
 * of its own, named after the automation, and works every trigger event, old history included: `issue`'s key
 * `<automation>:<item key>` makes a repeat do nothing. The stored event and the checkpoint make it crash safe.
 *
 * **Giving up** (either kind): an item that keeps failing can be given up on after a number of attempts (`giveUp`),
 * so it doesn't block the ones behind it. The automation records that (an event of ours; a to-do list keeps the item,
 * marked failed) and the administrator is alerted.
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
    /**
     * Read a **data input**: another read model the command needs, linked to the automation in the model (ADR-039),
     * e.g. the organisation's owner. Read live from the event store, as the item is, so it's current; null if none.
     */
    read<TDoc extends ReadModelDoc>(readModel: ReadModel<TDoc, any>, key: string): Promise<TDoc | null>
}

export interface AttemptOptions {
    /** The attempt the trigger belongs to, for work that can be done again on the same item (e.g. a payment's attempt) */
    attempt?: number
}

/** The key an item's work is done once under: `<automation>:<item key>`, plus `:<attempt>` when given. */
export function workKey(automation: string, key: string, options?: AttemptOptions): string {
    return options?.attempt === undefined ? `${automation}:${key}` : `${automation}:${key}:${options.attempt}`
}

interface AutomationBase<TItem extends ReadModelDoc> {
    /** The name its keys are built from, e.g. "stock-returner" (from the model's description) */
    name: string
    /** The event types the automation reacts to (the model's `reacts-to`). A to-do list handles each of them. */
    triggers: string[]
    act(context: AutomationContext<TItem>): Promise<void>
    /**
     * Absent: an item that fails blocks the processor until it succeeds. Given: after `after` failed attempts the
     * automation records that it gave up on the item, the administrator is alerted, and the items behind it are
     * worked. For work where one bad item mustn't hold up the rest (another system's notifications, ADR-040).
     */
    giveUp?: GiveUp<TItem>
}

/** An automation with a to-do list (ADR-031) */
export interface ListAutomation<TItem extends ReadModelDoc = any> extends AutomationBase<TItem> {
    /** The to-do list. Registered in `readModels` as database-projected; the automation's processor runs it. */
    todoList: ReadModel<TItem, any>
}

/** A list of one (ADR-040): no stored to-do list, the trigger event is the item (`item` is its data) */
export interface ListOfOneAutomation<TItem extends ReadModelDoc = any> extends AutomationBase<TItem> {
    /** The tag of the trigger events whose value is the item's key, e.g. "paddleEventId" */
    key: string
}

export interface GiveUp<TItem extends ReadModelDoc> {
    /** The number of failed attempts on one item before giving up on it (counted since the app started) */
    after: number
    /**
     * Record that the item was given up on, as an event of ours (through `issue`), so it's seen and can be worked
     * again by hand: a to-do list keeps the item, marked failed. If this throws, the processor stays blocked on the
     * item and tries again.
     */
    record(context: AutomationContext<TItem>, error: unknown): Promise<void>
}

export type Automation<TItem extends ReadModelDoc = any> = ListAutomation<TItem> | ListOfOneAutomation<TItem>

const hasList = <TItem extends ReadModelDoc>(automation: Automation<TItem>): automation is ListAutomation<TItem> =>
    "todoList" in automation && automation.todoList !== undefined

export function defineAutomation<TItem extends ReadModelDoc>(automation: ListAutomation<TItem>): ListAutomation<TItem>
export function defineAutomation<TItem extends ReadModelDoc>(automation: ListOfOneAutomation<TItem>): ListOfOneAutomation<TItem>
export function defineAutomation<TItem extends ReadModelDoc>(automation: Automation<TItem>): Automation<TItem> {
    if (!hasList(automation)) {
        if (!automation.key) throw new Error(`${automation.name}: an automation has a to-do list, or the key (a tag) of its trigger events.`)
        if (automation.triggers.length === 0) throw new Error(`${automation.name}: a list of one needs at least one trigger.`)
    }
    if (automation.giveUp && automation.giveUp.after < 1) throw new Error(`${automation.name}: giveUp.after is at least 1.`)
    if (!hasList(automation)) return automation
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
    /** Told when a list of one gives up on an item. The app's alert (a JSON line on stderr) when absent */
    alert?: (alert: Alert) => void
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

function contextFor<TItem extends ReadModelDoc>(
    automation: Automation<TItem>,
    deps: AutomationDependencies,
    item: TItem,
    key: string,
    event: SequencedEvent
): AutomationContext<TItem> {
    return {
        item,
        key,
        event,
        issue: (decider, command, options) => issueOnce(deps, workKey(automation.name, key, options), decider, command),
        read: async (readModel, dataKey) => (await readLive(deps.eventStore, readModel, dataKey)) as any,
        start: async (workflowType, args, options) => {
            if (!deps.workflows) {
                throw new Error(`${automation.name}: no workflow starter (is TEMPORAL_ADDRESS set?)`)
            }
            await deps.workflows.start(workflowType, workKey(automation.name, key, options), args)
        }
    }
}

/**
 * `act` on one item, giving up when the automation says so: a failure is thrown (the processor blocks on the event and
 * retries it, shown on `GET /health/processors`) until `giveUp.after` attempts; then the automation records that it
 * gave up, the administrator is alerted, and the processor moves on. Attempts are counted per item since the app
 * started: a restart counts again, which only means more attempts before giving up.
 */
function worker(automation: Automation, deps: AutomationDependencies) {
    const alert = deps.alert ?? defaultAlert
    const failed = new Map<string, number>()
    return async (context: AutomationContext<any>): Promise<void> => {
        const item = `${context.key}@${context.event.position.toString()}`
        try {
            await automation.act(context)
        } catch (error) {
            const attempts = (failed.get(item) ?? 0) + 1
            if (!automation.giveUp || attempts < automation.giveUp.after) {
                failed.set(item, attempts)
                throw error
            }
            await automation.giveUp.record(context, error)
            const message = error instanceof Error ? error.message : String(error)
            alert({
                code: "automation-gave-up",
                severity: "critical",
                message: `${automation.name} gave up on ${context.key} (${context.event.event.type}) after ${attempts} attempt(s): ${message}`,
                details: {
                    automation: automation.name,
                    key: context.key,
                    eventType: context.event.event.type,
                    position: context.event.position.toString(),
                    attempts,
                    error: message
                }
            })
        }
        failed.delete(item)
    }
}

/** The automation's processor: the to-do list's projection (its name and bookmark), plus the automation step. */
export function automationProcessor(
    automation: ListAutomation,
    deps: AutomationDependencies,
    options?: ProjectionProcessorOptions
): ConsumerProcessorConfig {
    const list = projectionToProcessor(automation.todoList.projection, options)
    const work = worker(automation, deps)
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
                            await work(contextFor(automation, deps, item, key, event))
                        }
                    }
                ])
            )
            return { when } as EventHandler<any, any>
        }
    }
}

/**
 * A list of one's processor (ADR-040): its own name and checkpoint, the trigger event as the item.
 */
export function listOfOneProcessor(
    automation: ListOfOneAutomation,
    deps: AutomationDependencies,
    options?: ProjectionProcessorOptions
): ConsumerProcessorConfig {
    const workItem = worker(automation, deps)
    const work = async (event: SequencedEvent) => {
        for (const key of tagValues(event, automation.key)) {
            await workItem(contextFor(automation, deps, event.event.data as ReadModelDoc, key, event))
        }
    }
    return {
        processorName: automation.name,
        query: Query.fromItems([{ types: automation.triggers }]),
        handlerFactory: () => ({ when: Object.fromEntries(automation.triggers.map(type => [type, work])) }) as EventHandler<any, any>,
        pollIntervalMs: options?.pollIntervalMs,
        startFrom: options?.startFrom,
        stopAfter: options?.stopAfter,
        batchSize: options?.batchSize,
        onError: options?.onError,
        backoff: options?.backoff
    }
}

/**
 * What `startReadModels` takes to run the automations: each to-do list's automation processor replaces the list's
 * plain processor (`processorFor`), and each list of one gets a processor of its own (`processors`). Refuses to start
 * when a to-do list isn't registered as database-projected: an inline or live list has no processor to run the
 * automation step in.
 */
export function automationProcessors(
    automations: Automation[],
    readModels: ReadModel<any, any>[],
    deps: Omit<AutomationDependencies, "eventStore">,
    options?: ProjectionProcessorOptions
): Required<Pick<StartReadModelsOptions, "processorFor" | "processors">> {
    const withList = automations.filter(hasList)
    const listsOfOne = automations.filter((a): a is ListOfOneAutomation => !hasList(a))
    for (const automation of withList) {
        const registered = readModels.find(r => r.name === automation.todoList.name)
        if (registered?.type !== "database-projected") {
            throw new Error(
                `${automation.name}: its to-do list ${automation.todoList.name} must be registered in readModels as ` +
                    `database-projected (it is ${registered ? registered.type : "not registered"}). ADR-031.`
            )
        }
    }
    return {
        processorFor: (projection, eventStore, projectionOptions) => {
            const automation = withList.find(a => a.todoList.projection.name === projection.name)
            return automation ? automationProcessor(automation, { ...deps, eventStore }, { ...projectionOptions, ...options }) : undefined
        },
        processors: eventStore =>
            listsOfOne.map(a => listOfOneProcessor(a, { ...deps, eventStore }, { batchSize: 100, startFrom: "BEGINNING", ...options }))
    }
}
