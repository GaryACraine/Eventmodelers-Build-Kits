import { describe, test, expect, beforeAll, afterAll } from "vitest"
import { fileURLToPath } from "node:url"
import { startTemporalTestServer, withWorker, type TemporalTestServer } from "@test/temporalHarness"
import {
    ensureSchedule,
    startWorker,
    temporalClient,
    temporalConfig,
    temporalStatus,
    temporalWorkflowStarter,
    triggerSchedule,
    watchSchedules,
    watchTemporal
} from "./temporal.js"
import { defineSchedule } from "./automations.js"

// Nothing listens here: Temporal "down"
const UNREACHABLE = "127.0.0.1:1"

describe("temporalConfig", () => {
    test("gives every call to Temporal a deadline of 5 s, unless TEMPORAL_CALL_TIMEOUT_MS says otherwise", () => {
        expect(temporalConfig({}).callTimeoutMs).toBe(5000)
        expect(temporalConfig({ TEMPORAL_CALL_TIMEOUT_MS: "750" }).callTimeoutMs).toBe(750)
    })

    test("checks Temporal for health every 5 s, unless TEMPORAL_HEALTH_INTERVAL_MS says otherwise", () => {
        expect(temporalConfig({}).healthIntervalMs).toBe(5000)
        expect(temporalConfig({ TEMPORAL_HEALTH_INTERVAL_MS: "1000" }).healthIntervalMs).toBe(1000)
    })

    test("refuses a deadline that isn't a whole number of milliseconds", () => {
        expect(() => temporalConfig({ TEMPORAL_CALL_TIMEOUT_MS: "5s" })).toThrow(/TEMPORAL_CALL_TIMEOUT_MS/)
        expect(() => temporalConfig({ TEMPORAL_CALL_TIMEOUT_MS: "0" })).toThrow(/TEMPORAL_CALL_TIMEOUT_MS/)
    })
})

describe("with Temporal unreachable", () => {
    const config = { ...temporalConfig({ TEMPORAL_ADDRESS: UNREACHABLE }), callTimeoutMs: 300 }

    test("a workflow start fails at our deadline, saying so, not after the client's own retries", async () => {
        const starter = temporalWorkflowStarter(temporalClient(config), config.taskQueue, { callTimeoutMs: config.callTimeoutMs })
        const started = Date.now()
        await expect(starter.start("anything", "probe:1", [])).rejects.toThrow(
            /Temporal didn't answer starting workflow probe:1 within 300 ms/
        )
        expect(Date.now() - started).toBeLessThan(3000)
    })

    test("health says it's unreachable, within the deadline", async () => {
        const started = Date.now()
        const status = await temporalStatus(temporalClient(config), config)
        expect(status).toMatchObject({ address: UNREACHABLE, reachable: false, error: expect.stringMatching(/within 300 ms/) })
        expect(Date.now() - started).toBeLessThan(3000)
    })

    test("the watched status answers at once: unknown, then unreachable after the first check", async () => {
        const watch = watchTemporal(temporalClient(config), { ...config, healthIntervalMs: 100 })
        try {
            const asked = Date.now()
            expect(watch.status()).toMatchObject({ reachable: null })
            expect(Date.now() - asked).toBeLessThan(50)
            await expect.poll(() => watch.status().error, { timeout: 5000 }).toMatch(/within 300 ms/)
        } finally {
            watch.stop()
        }
    })

    test("the worker says it's restarting, and why", async () => {
        const worker = startWorker({
            config,
            workflowsPath: fileURLToPath(new URL("../test/fixtures/labelWorkflow.ts", import.meta.url)),
            activities: {},
            logger: { error: () => undefined, info: () => undefined }
        })
        try {
            await expect.poll(() => worker.status().state, { timeout: 15_000 }).toBe("restarting")
            expect(worker.status()).toMatchObject({ attempts: 1, error: expect.any(String) })
        } finally {
            await worker.stop()
        }
        expect(worker.status()).toEqual({ state: "stopped" })
    })
})

describe("with Temporal up", () => {
    let temporal: TemporalTestServer
    beforeAll(async () => {
        temporal = await startTemporalTestServer()
    })
    afterAll(async () => temporal?.stop())

    test("health says it's reachable", async () => {
        const config = temporalConfig({ TEMPORAL_ADDRESS: temporal.address })
        const status = await temporalStatus(temporalClient(config), config)
        expect(status).toEqual({ address: temporal.address, reachable: true, checkedAt: expect.any(String) })
    })
})

// ─── Timed work (ADR-042): a schedule, a start with a delay, timers in a workflow ───────────────────────────────

describe("timed work, with Temporal up", () => {
    let temporal: TemporalTestServer
    beforeAll(async () => {
        temporal = await startTemporalTestServer()
    }, 120_000)
    afterAll(async () => temporal?.stop())

    const workflowsPath = fileURLToPath(new URL("../test/fixtures/timedWorkflows.ts", import.meta.url))
    const client = () => temporal.env.client
    // Far apart, so the timetable itself never fires during a test: only triggers do
    const sweepEvery = (name: string, every = "30 days") => defineSchedule({ name, every, workflowType: "sweep" })
    const noActivities = { sweepOnce: async () => undefined, isOpen: async () => false, fetchFor: async () => undefined }
    const gate = () => {
        let release: () => void = () => undefined
        const held = new Promise<void>(resolve => (release = resolve))
        return { held, release }
    }

    test("a schedule is created, and created again it's updated: the same id, the new interval", async () => {
        const taskQueue = "timed-create"
        expect(await ensureSchedule(client(), taskQueue, sweepEvery("sweep-create"))).toBe("created")
        expect(await ensureSchedule(client(), taskQueue, sweepEvery("sweep-create", "45 minutes"))).toBe("updated")

        const described = await client().schedule.getHandle("sweep-create").describe()
        expect(described.spec.intervals?.map(i => i.every)).toEqual([45 * 60_000])
        expect(described.policies).toMatchObject({ overlap: "SKIP", catchupWindow: 60_000, pauseOnFailure: false })
        expect(described.action).toMatchObject({ workflowType: "sweep", taskQueue, workflowId: "sweep-create" })
    })

    test("an update keeps a schedule a person paused, paused", async () => {
        const taskQueue = "timed-paused"
        await ensureSchedule(client(), taskQueue, sweepEvery("sweep-paused"))
        await client().schedule.getHandle("sweep-paused").pause("Paddle is down")
        await ensureSchedule(client(), taskQueue, sweepEvery("sweep-paused", "1 hour"))
        expect((await client().schedule.getHandle("sweep-paused").describe()).state).toMatchObject({ paused: true, note: "Paddle is down" })
    })

    test("a trigger runs the schedule now", async () => {
        const taskQueue = "timed-trigger"
        let runs = 0
        await ensureSchedule(client(), taskQueue, sweepEvery("sweep-trigger"))
        await withWorker(temporal, { taskQueue, workflowsPath, activities: { ...noActivities, sweepOnce: async () => void runs++ } }, async () => {
            await triggerSchedule(client(), "sweep-trigger")
            await expect.poll(() => runs, { timeout: 20_000 }).toBe(1)
        })
    }, 60_000)

    test("triggers during a run queue one more run, however many there are", async () => {
        const taskQueue = "timed-buffer"
        let runs = 0
        const gates = [gate(), gate()]
        // Each of the first two runs holds until released, so the test sees the schedule's state while they run
        const activities = { ...noActivities, sweepOnce: async () => gates[runs++]?.held }
        await ensureSchedule(client(), taskQueue, sweepEvery("sweep-buffer"))
        const handle = client().schedule.getHandle("sweep-buffer")
        const queued = async () => {
            const { info, raw } = await handle.describe()
            return { taken: info.numActionsTaken, queued: Number(String(raw.info?.bufferSize ?? 0)) }
        }
        await withWorker(temporal, { taskQueue, workflowsPath, activities }, async () => {
            await triggerSchedule(client(), "sweep-buffer")
            await expect.poll(() => runs, { timeout: 20_000 }).toBe(1)
            await triggerSchedule(client(), "sweep-buffer")
            await triggerSchedule(client(), "sweep-buffer")
            await triggerSchedule(client(), "sweep-buffer")
            gates[0].release()
            // One more run starts: the three triggers queued one
            await expect.poll(() => runs, { timeout: 20_000 }).toBe(2)
            // And while it runs, nothing else is queued behind it
            await expect.poll(queued, { timeout: 20_000 }).toEqual({ taken: 2, queued: 0 })
            gates[1].release()
            await expect.poll(async () => (await handle.describe()).info.runningActions.length, { timeout: 20_000 }).toBe(0)
            expect(runs).toBe(2)
        })
    }, 90_000)

    test("the app's schedules are set up in the background, and one marked runAtStart runs at once", async () => {
        const taskQueue = "timed-watch"
        let runs = 0
        const config = { ...temporalConfig({ TEMPORAL_ADDRESS: temporal.address }), taskQueue, healthIntervalMs: 200 }
        const quiet = { error: () => undefined, info: () => undefined }
        const watch = watchSchedules(client(), config, [{ ...sweepEvery("sweep-watch"), runAtStart: true }], quiet)
        try {
            expect(watch.status()).toEqual([{ name: "sweep-watch", every: "30 days", state: "pending" }])
            await withWorker(temporal, { taskQueue, workflowsPath, activities: { ...noActivities, sweepOnce: async () => void runs++ } }, async () => {
                await expect.poll(() => watch.status()[0].state, { timeout: 20_000 }).toBe("ready")
                await expect.poll(() => runs, { timeout: 20_000 }).toBe(1)
            })
        } finally {
            watch.stop()
        }
    }, 60_000)

    test("with Temporal unreachable, a schedule stays pending and says why", async () => {
        const config = { ...temporalConfig({ TEMPORAL_ADDRESS: UNREACHABLE }), callTimeoutMs: 300, healthIntervalMs: 100 }
        const watch = watchSchedules(temporalClient(config), config, [sweepEvery("sweep-down")], { error: () => undefined, info: () => undefined })
        try {
            await expect.poll(() => watch.status()[0], { timeout: 5000 }).toMatchObject({ state: "pending", error: expect.stringMatching(/within 300 ms/) })
        } finally {
            watch.stop()
        }
    })

    test("work due at a known time is started now and runs when it's due, not before", async () => {
        const taskQueue = "timed-delay"
        let ranAt = 0
        const starter = temporalWorkflowStarter(client(), taskQueue)
        const activities = { ...noActivities, sweepOnce: async () => void (ranAt = Date.now()) }
        await withWorker(temporal, { taskQueue, workflowsPath, activities }, async () => {
            const dueAt = new Date(Date.now() + 2000)
            await starter.start("sweep", "expiry:i1", [], { dueAt })
            await client().workflow.getHandle("expiry:i1").result()
            expect(ranAt).toBeGreaterThanOrEqual(dueAt.getTime() - 50)
            // Started again for the same item: one workflow, as for any item
            await starter.start("sweep", "expiry:i1", [], { dueAt })
        })
    }, 60_000)

    test("a watch tries on its timers and stops as soon as its item is closed", async () => {
        const taskQueue = "timed-watching"
        const fetched: string[] = []
        const activities = {
            ...noActivities,
            // Closed once the second fetch has brought the fact
            isOpen: async () => fetched.length < 2,
            fetchFor: async (key: string) => void fetched.push(key)
        }
        await withWorker(temporal, { taskQueue, workflowsPath, activities }, async () => {
            const handle = await client().workflow.start("watch", { taskQueue, workflowId: "watch:c1", args: ["c1", [20, 50, 100, 200, 400]] })
            expect(await handle.result()).toBe(2)
        })
        expect(fetched).toEqual(["c1", "c1"])
    }, 60_000)

    test("a schedule's interval is a number and a unit", () => {
        expect(() => defineSchedule({ name: "x", every: "*/15 * * * *", workflowType: "sweep" })).toThrow(/a number and a unit/)
    })
})
