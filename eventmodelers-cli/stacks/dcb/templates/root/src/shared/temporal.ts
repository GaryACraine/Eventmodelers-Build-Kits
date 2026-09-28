import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client"
import { NativeConnection, Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from "@temporalio/worker"
import type { WorkflowStarter } from "./automations.js"

/**
 * Temporal runs the external automations' workflows (ADR-031, ADR-033). It's in `docker compose` on our Postgres
 * (UI on http://localhost:8080). The worker runs in the API's process; nothing here stops the API from serving when
 * Temporal is down.
 */

export interface TemporalConfig {
    address: string
    namespace: string
    taskQueue: string
    /**
     * How long any one call to Temporal (starting a workflow, the health check) may take before it fails. Ours to set,
     * not the client's: its own retries of an unreachable server would otherwise take about 21 s (10 attempts,
     * backing off ×1.7) before a start fails and the processor shows `blocked`.
     */
    callTimeoutMs: number
    /** How often the app checks Temporal for `/health/processors`, in the background (`watchTemporal`) */
    healthIntervalMs: number
}

export function temporalConfig(env: NodeJS.ProcessEnv = process.env): TemporalConfig {
    return {
        address: env["TEMPORAL_ADDRESS"] ?? "localhost:7233",
        namespace: env["TEMPORAL_NAMESPACE"] ?? "default",
        taskQueue: env["TEMPORAL_TASK_QUEUE"] ?? "automations",
        callTimeoutMs: positiveInt(env["TEMPORAL_CALL_TIMEOUT_MS"], "TEMPORAL_CALL_TIMEOUT_MS") ?? 5000,
        healthIntervalMs: positiveInt(env["TEMPORAL_HEALTH_INTERVAL_MS"], "TEMPORAL_HEALTH_INTERVAL_MS") ?? 5000
    }
}

function positiveInt(value: string | undefined, name: string): number | undefined {
    if (value === undefined || value === "") return undefined
    const n = Number(value)
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a whole number of milliseconds, got "${value}"`)
    return n
}

/** `fn` with a deadline of `timeoutMs` on its calls to Temporal; past it, an error that says so. */
async function withinDeadline<T>(client: Client, timeoutMs: number, what: string, fn: () => Promise<T>): Promise<T> {
    try {
        return await client.withDeadline(Date.now() + timeoutMs, fn)
    } catch (error) {
        if (error instanceof WorkflowExecutionAlreadyStartedError) throw error
        const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)
        throw new Error(`Temporal didn't answer ${what} within ${timeoutMs} ms (${reason})`, { cause: error })
    }
}

/** A client that connects on first use, so the app starts without Temporal. */
export function temporalClient(config: TemporalConfig): Client {
    return new Client({ connection: Connection.lazy({ address: config.address }), namespace: config.namespace })
}

/**
 * Starts each workflow once. The id is the to-do item's (`<automation>:<item key>`): a start while it runs joins it
 * (`USE_EXISTING`), and a start after it has closed is refused (`REJECT_DUPLICATE`) and counts as done. Starting
 * again after a failure is redrive, PLAN 15.4 (ADR-032).
 *
 * A start that Temporal doesn't answer within `callTimeoutMs` fails, so the processor shows `blocked` then, naming the
 * deadline, and retries the item.
 */
export function temporalWorkflowStarter(
    client: Client,
    taskQueue: string,
    options: { callTimeoutMs?: number } = {}
): WorkflowStarter {
    const timeoutMs = options.callTimeoutMs ?? 5000
    return {
        async start(workflowType, workflowId, args) {
            try {
                await withinDeadline(client, timeoutMs, `starting workflow ${workflowId}`, () =>
                    client.workflow.start(workflowType, {
                        taskQueue,
                        workflowId,
                        args,
                        workflowIdConflictPolicy: "USE_EXISTING",
                        workflowIdReusePolicy: "REJECT_DUPLICATE"
                    })
                )
            } catch (error) {
                if (error instanceof WorkflowExecutionAlreadyStartedError) return
                throw error
            }
        }
    }
}

/** Whether Temporal answers, and how this process's worker is doing: for `/health/processors`. */
export interface TemporalStatus {
    address: string
    /** `null` until the first check has answered */
    reachable: boolean | null
    /** Why it isn't, when it isn't */
    error?: string
    /** When this was found out (a watched status is at most `healthIntervalMs` plus `callTimeoutMs` old) */
    checkedAt: string
    /**
     * This process's worker, as the SDK sees it. It keeps polling through an outage, so it can say `running` while
     * Temporal is down: `reachable` is the answer about Temporal itself.
     */
    worker?: WorkerStatus
}

/**
 * Ask Temporal directly (its `GetSystemInfo` call: the server answering a real request) within `callTimeoutMs`, so health shows it down at once, whether or not
 * any automation has work waiting.
 */
export async function temporalStatus(
    client: Client,
    config: Pick<TemporalConfig, "address" | "callTimeoutMs">,
    worker?: RunningWorker
): Promise<TemporalStatus> {
    const workerStatus = worker ? { worker: worker.status() } : {}
    try {
        await withinDeadline(client, config.callTimeoutMs, "the health check", () => client.workflowService.getSystemInfo({}))
        return { address: config.address, reachable: true, checkedAt: new Date().toISOString(), ...workerStatus }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { address: config.address, reachable: false, error: message, checkedAt: new Date().toISOString(), ...workerStatus }
    }
}

export interface WatchedTemporal {
    /** The latest check, answered at once: a health request never waits on Temporal */
    status(): TemporalStatus
    stop(): void
}

/**
 * Check Temporal every `healthIntervalMs` in the background (each check bounded by `callTimeoutMs`), so health answers
 * at once with the latest result. Asking on each request would make health as slow as the deadline while Temporal is
 * down. Until the first check ends, `reachable` is `null`: not known yet.
 */
export function watchTemporal(
    client: Client,
    config: Pick<TemporalConfig, "address" | "callTimeoutMs" | "healthIntervalMs">,
    worker?: RunningWorker
): WatchedTemporal {
    let latest: TemporalStatus = { address: config.address, reachable: null, checkedAt: new Date().toISOString() }
    let stopped = false
    let timer: NodeJS.Timeout | undefined
    const check = async () => {
        const status = await temporalStatus(client, config)
        if (stopped) return
        latest = status
        timer = setTimeout(check, config.healthIntervalMs)
        timer.unref()
    }
    void check()
    return {
        status: () => ({ ...latest, ...(worker ? { worker: worker.status() } : {}) }),
        stop: () => {
            stopped = true
            clearTimeout(timer)
        }
    }
}

export type WorkerStatus =
    | { state: "starting" }
    | { state: "running"; since: string }
    | { state: "restarting"; error: string; attempts: number; nextAttemptAt: string }
    | { state: "stopped" }

export interface RunningWorker {
    status(): WorkerStatus
    stop(): Promise<void>
}

/**
 * Run a worker for the task queue until `stop()`. Its workflows are bundled once. If Temporal can't be reached, or
 * the worker fails, it waits and starts again (1 s, doubling to 60 s), logging why.
 */
export function startWorker(options: {
    config: TemporalConfig
    workflowsPath: string
    activities: object
    logger?: Pick<Console, "error" | "info">
}): RunningWorker {
    const { config, workflowsPath, activities } = options
    const logger = options.logger ?? console
    const stopping = new AbortController()
    let worker: Worker | undefined
    let bundle: WorkflowBundleWithSourceMap | undefined
    let status: WorkerStatus = { state: "starting" }

    const running = (async () => {
        for (let attempt = 1; !stopping.signal.aborted; attempt++) {
            let connection: NativeConnection | undefined
            try {
                bundle ??= await bundleWorkflowCode({ workflowsPath })
                connection = await NativeConnection.connect({ address: config.address })
                worker = await Worker.create({
                    connection,
                    namespace: config.namespace,
                    taskQueue: config.taskQueue,
                    workflowBundle: bundle,
                    activities
                })
                if (stopping.signal.aborted) break
                logger.info(`Temporal worker running on ${config.address}, task queue ${config.taskQueue}`)
                status = { state: "running", since: new Date().toISOString() }
                attempt = 0
                await worker.run()
            } catch (error) {
                if (stopping.signal.aborted) break
                const delay = Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1))
                const message = error instanceof Error ? error.message : String(error)
                status = { state: "restarting", error: message, attempts: attempt, nextAttemptAt: new Date(Date.now() + delay).toISOString() }
                logger.error(`Temporal worker stopped (${error instanceof Error ? error.message : String(error)}); starting again in ${delay} ms`)
                await wait(delay, stopping.signal)
            } finally {
                worker = undefined
                await connection?.close().catch(() => undefined)
            }
        }
    })()

    return {
        status: () => status,
        stop: async () => {
            stopping.abort()
            if (worker && worker.getState() === "RUNNING") worker.shutdown()
            await running
            status = { state: "stopped" }
        }
    }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms)
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer)
                resolve()
            },
            { once: true }
        )
    })
}
