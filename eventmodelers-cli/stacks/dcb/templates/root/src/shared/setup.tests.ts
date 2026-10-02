import { describe, test, expect, beforeEach, afterEach } from "vitest"
import type { Pool } from "pg"
import { decider, Tags, ValidationError, type Command, type Event, type EventHandlerWithState } from "@dcb-es/event-store"
import { PostgresEventStore } from "@dcb-es/event-store-postgres"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { configInt, configText, defineSetup, runSetup } from "./setup.js"

// A system setting as a fact of ours: how long a parcel is held at the depot
type ConfigureHoldPeriod = Command<"configureHoldPeriod", { settingsId: string; holdDays: number; configuredBy: string }>
type HoldPeriodConfigured = Event<"holdPeriodWasConfigured", ConfigureHoldPeriod["data"]>
const Configured = (settingsId: string): EventHandlerWithState<HoldPeriodConfigured, number> => ({
    tagFilter: Tags.fromObj({ settingsId }),
    init: 0,
    when: { holdPeriodWasConfigured: (_e, n) => n + 1 }
})
const configureHoldPeriod = decider<ConfigureHoldPeriod, { configured: ReturnType<typeof Configured> }>({
    handlers: cmd => ({ configured: Configured(cmd.data.settingsId) }),
    decide: cmd => {
        if (cmd.data.holdDays < 1) throw new ValidationError("The hold period is at least one day")
        return { event: { type: "holdPeriodWasConfigured", data: cmd.data }, tags: Tags.fromObj({ settingsId: cmd.data.settingsId }) }
    }
})
const holdPeriodSetup = defineSetup<ConfigureHoldPeriod>({
    name: "configureHoldPeriod",
    decider: configureHoldPeriod,
    command: env => ({
        type: "configureHoldPeriod",
        data: { settingsId: "depot", holdDays: configInt(env, "HOLD_DAYS", 5), configuredBy: "setup" }
    })
})

describe("setup commands (ADR-043)", () => {
    let pool: Pool
    let eventStore: PostgresEventStore
    const quiet = { info: () => undefined }
    beforeEach(async () => {
        pool = await getTestPgDatabasePool()
        eventStore = new PostgresEventStore({ pool })
        await eventStore.ensureInstalled()
    })
    afterEach(async () => pool?.end())

    const configured = async () => {
        const r = await pool.query<{ payload: string }>("SELECT payload FROM events WHERE type = 'holdPeriodWasConfigured' ORDER BY sequence_position")
        return r.rows.map(row => (JSON.parse(row.payload) as { data: { holdDays: number; configuredBy: string } }).data.holdDays)
    }

    test("the first start issues the command with the model's default", async () => {
        expect(await runSetup({ eventStore, pool }, [holdPeriodSetup], { env: {}, logger: quiet })).toEqual([{ name: "configureHoldPeriod", outcome: "issued" }])
        expect(await configured()).toEqual([5])
    })

    test("the deployment's configuration overrides the default", async () => {
        await runSetup({ eventStore, pool }, [holdPeriodSetup], { env: { HOLD_DAYS: "9" }, logger: quiet })
        expect(await configured()).toEqual([9])
    })

    test("a later start issues nothing, even with a different configured value: the event is the truth", async () => {
        await runSetup({ eventStore, pool }, [holdPeriodSetup], { env: {}, logger: quiet })
        const again = await runSetup({ eventStore, pool }, [holdPeriodSetup], { env: { HOLD_DAYS: "9" }, logger: quiet })
        expect(again).toEqual([{ name: "configureHoldPeriod", outcome: "already issued" }])
        expect(await configured()).toEqual([5])
    })

    test("two instances starting together record it once", async () => {
        await Promise.all([
            runSetup({ eventStore, pool }, [holdPeriodSetup], { env: {}, logger: quiet }),
            runSetup({ eventStore, pool }, [holdPeriodSetup], { env: {}, logger: quiet })
        ])
        expect(await configured()).toEqual([5])
    })

    test("a value the command's rules refuse stops the start, saying which setup and why; nothing is recorded", async () => {
        await expect(runSetup({ eventStore, pool }, [holdPeriodSetup], { env: { HOLD_DAYS: "0" }, logger: quiet })).rejects.toThrow(
            /Setup: configureHoldPeriod failed \(The hold period is at least one day\)/
        )
        expect(await configured()).toEqual([])
    })

    test("a configured value that isn't a whole number stops the start", async () => {
        await expect(runSetup({ eventStore, pool }, [holdPeriodSetup], { env: { HOLD_DAYS: "five" }, logger: quiet })).rejects.toThrow(
            /HOLD_DAYS must be a whole number, got "five"/
        )
    })

    test("a changed setting isn't put back by a restart", async () => {
        await runSetup({ eventStore, pool }, [holdPeriodSetup], { env: {}, logger: quiet })
        // A person changes the setting: the same command, issued through its route
        await eventStore.append({
            events: [{ event: { type: "holdPeriodWasConfigured", data: { settingsId: "depot", holdDays: 12, configuredBy: "admin-1" } }, tags: Tags.fromObj({ settingsId: "depot" }) }]
        })
        await runSetup({ eventStore, pool }, [holdPeriodSetup], { env: {}, logger: quiet })
        expect(await configured()).toEqual([5, 12])
    })

    test("configuration helpers fall back to the default when unset or empty", () => {
        expect(configInt({}, "X", 7)).toBe(7)
        expect(configInt({ X: "" }, "X", 7)).toBe(7)
        expect(configText({ X: "weekly" }, "X", "daily")).toBe("weekly")
        expect(configText({}, "X", "daily")).toBe("daily")
    })
})
