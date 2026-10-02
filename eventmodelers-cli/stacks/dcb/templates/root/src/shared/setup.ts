/* eslint-disable @typescript-eslint/no-explicit-any */
import { handle, type Command, type Decider, type EventStore } from "@dcb-es/event-store"
import type { Pool } from "pg"
import { findExistingPosition, idempotencyKeyFor } from "./idempotency.js"

/**
 * Setup commands (ADR-043): commands the system issues itself, once, when it's set up. A system setting (a grace
 * period's length) is a fact of ours: an event, projected to a settings read model that a processor reads. So it must
 * be recorded before anything needs it, and nobody is at a screen to do that.
 *
 * The app issues each setup command when it starts, under the key `setup:<name>`, so it's issued once, ever: the
 * first start records the deployment's configured value, and every later start does nothing. After that the event is
 * the truth. To change the setting, issue the command again (its route, or the screen that submits it): a changed
 * environment variable changes nothing.
 *
 * A value the command's rules refuse (a grace period of 0 days) stops the app from starting, saying which.
 */
export interface SetupCommand {
    /** The key it's issued once under, `setup:<name>`: the command's name, e.g. "configureGracePeriod" */
    name: string
    issue(deps: SetupDependencies, env: NodeJS.ProcessEnv): Promise<"issued" | "already issued">
}

export interface SetupDependencies {
    eventStore: EventStore
    pool: Pool
}

export function defineSetup<C extends Command>(setup: {
    name: string
    decider: Decider<C, any>
    /** The command, from the deployment's configuration (`configInt(env, "GRACE_PERIOD_DAYS", 14)`) */
    command: (env: NodeJS.ProcessEnv) => C
}): SetupCommand {
    return {
        name: setup.name,
        issue: async (deps, env) => {
            const idempotencyKey = idempotencyKeyFor(`setup:${setup.name}`)
            if (await findExistingPosition(deps.pool, idempotencyKey)) return "already issued"
            await handle(deps.eventStore, setup.decider, setup.command(env), { idempotencyKey })
            return "issued"
        }
    }
}

/**
 * Issue every setup command that hasn't been issued, before the app serves. Throws on the first that fails, naming
 * it: the app doesn't start half set up.
 */
export async function runSetup(
    deps: SetupDependencies,
    setups: SetupCommand[],
    options: { env?: NodeJS.ProcessEnv; logger?: Pick<Console, "info"> } = {}
): Promise<{ name: string; outcome: "issued" | "already issued" }[]> {
    const env = options.env ?? process.env
    const logger = options.logger ?? console
    const outcomes: { name: string; outcome: "issued" | "already issued" }[] = []
    for (const setup of setups) {
        try {
            const outcome = await setup.issue(deps, env)
            if (outcome === "issued") logger.info(`Setup: ${setup.name} issued`)
            outcomes.push({ name: setup.name, outcome })
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`Setup: ${setup.name} failed (${reason}). The app didn't start.`, { cause: error })
        }
    }
    return outcomes
}

/** A whole number from the deployment's configuration, or its default (the model's example). */
export function configInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
    const value = env[name]
    if (value === undefined || value === "") return fallback
    const n = Number(value)
    if (!Number.isInteger(n)) throw new Error(`${name} must be a whole number, got "${value}"`)
    return n
}

/** Text from the deployment's configuration, or its default (the model's example). */
export function configText(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
    const value = env[name]
    return value === undefined || value === "" ? fallback : value
}
