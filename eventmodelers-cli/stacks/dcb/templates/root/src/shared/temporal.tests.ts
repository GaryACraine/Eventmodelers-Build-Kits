import { describe, test, expect, beforeAll, afterAll } from "vitest"
import { fileURLToPath } from "node:url"
import { startTemporalTestServer, type TemporalTestServer } from "@test/temporalHarness"
import { startWorker, temporalClient, temporalConfig, temporalStatus, temporalWorkflowStarter, watchTemporal } from "./temporal.js"

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
