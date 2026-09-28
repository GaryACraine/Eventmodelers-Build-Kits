import { TestWorkflowEnvironment } from "@temporalio/testing"
import { Worker } from "@temporalio/worker"
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers"

/**
 * Temporal for tests: its dev server in a container (ADR-030, ADR-033), reached through `@temporalio/testing`.
 * One per test file (`beforeAll`), since starting it takes a few seconds. It outlives each test's database, and a
 * workflow id that has run can't run again (`REJECT_DUPLICATE`), so give each test its own item keys (o1, o2, …).
 *
 *   let temporal: TemporalTestServer
 *   beforeAll(async () => { temporal = await startTemporalTestServer() })
 *   afterAll(async () => temporal?.stop())
 */
export interface TemporalTestServer {
    env: TestWorkflowEnvironment
    address: string
    stop(): Promise<void>
}

export async function startTemporalTestServer(): Promise<TemporalTestServer> {
    const container: StartedTestContainer = await new GenericContainer("temporalio/temporal:1.5.0")
        .withCommand(["server", "start-dev", "--ip", "0.0.0.0"])
        .withExposedPorts(7233)
        .withWaitStrategy(Wait.forLogMessage(/Temporal Server:|Server:\s+localhost|CLI \d/))
        .start()
    const address = `${container.getHost()}:${container.getMappedPort(7233)}`
    const env = await TestWorkflowEnvironment.createFromExistingServer({ address })
    return {
        env,
        address,
        stop: async () => {
            await env.teardown()
            await container.stop()
        }
    }
}

/**
 * Run a worker with these workflows (a file path) and activities on `taskQueue` while `fn` runs, then stop it.
 * `workflowsPath` is the slice's workflow file: `fileURLToPath(new URL("./workflow.ts", import.meta.url))`.
 */
export async function withWorker<T>(
    server: TemporalTestServer,
    options: { taskQueue: string; workflowsPath: string; activities: object },
    fn: () => Promise<T>
): Promise<T> {
    const worker = await Worker.create({
        connection: server.env.nativeConnection,
        namespace: server.env.namespace ?? "default",
        taskQueue: options.taskQueue,
        workflowsPath: options.workflowsPath,
        activities: options.activities
    })
    return worker.runUntil(fn)
}
