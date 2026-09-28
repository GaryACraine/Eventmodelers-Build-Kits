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
}

export function temporalConfig(env: NodeJS.ProcessEnv = process.env): TemporalConfig {
    return {
        address: env["TEMPORAL_ADDRESS"] ?? "localhost:7233",
        namespace: env["TEMPORAL_NAMESPACE"] ?? "default",
        taskQueue: env["TEMPORAL_TASK_QUEUE"] ?? "automations"
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
 */
export function temporalWorkflowStarter(client: Client, taskQueue: string): WorkflowStarter {
    return {
        async start(workflowType, workflowId, args) {
            try {
                await client.workflow.start(workflowType, {
                    taskQueue,
                    workflowId,
                    args,
                    workflowIdConflictPolicy: "USE_EXISTING",
                    workflowIdReusePolicy: "REJECT_DUPLICATE"
                })
            } catch (error) {
                if (error instanceof WorkflowExecutionAlreadyStartedError) return
                throw error
            }
        }
    }
}

export interface RunningWorker {
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
                attempt = 0
                await worker.run()
            } catch (error) {
                if (stopping.signal.aborted) break
                const delay = Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1))
                logger.error(`Temporal worker stopped (${error instanceof Error ? error.message : String(error)}); starting again in ${delay} ms`)
                await wait(delay, stopping.signal)
            } finally {
                worker = undefined
                await connection?.close().catch(() => undefined)
            }
        }
    })()

    return {
        stop: async () => {
            stopping.abort()
            if (worker && worker.getState() === "RUNNING") worker.shutdown()
            await running
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
