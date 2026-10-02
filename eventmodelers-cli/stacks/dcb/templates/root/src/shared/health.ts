import type { ProcessorStatus, RunningConsumer } from "@dcb-es/event-store-postgres"
import type { WebApiSetup } from "@dcb-es/event-store-express"
import type { ScheduleStatus, TemporalStatus } from "./temporal.js"

/**
 * `GET /health/processors`: every processor's state, so a blocked one is seen (ADR-033). A processor blocks when its
 * handler keeps failing on one event (our bug, or Temporal unreachable for an automation); it retries that event, with
 * a growing wait, until it succeeds. `blocked` says on which event, since when and why.
 *
 * With `schedules` (a `watchSchedules`), it lists each polling automation's schedule: `pending` until Temporal has it.
 *
 * With `temporal` (a `watchTemporal`), it also says whether Temporal answers and how this process's worker is doing:
 * Temporal down shows within a check interval, not only when an automation next tries to start work, and without
 * waiting on Temporal.
 */
export function configureProcessorStatusRoute(
    consumer: () => RunningConsumer | undefined,
    options: { temporal?: () => TemporalStatus; schedules?: () => ScheduleStatus[] } = {}
): WebApiSetup {
    return router => {
        router.get("/health/processors", (_req, res) => {
            const processors = (consumer()?.status() ?? []).map(toJson)
            res.json({
                processors,
                ...(options.temporal ? { temporal: options.temporal() } : {}),
                ...(options.schedules ? { schedules: options.schedules() } : {})
            })
        })
    }
}

function toJson(status: ProcessorStatus) {
    return {
        processorName: status.processorName,
        state: status.state,
        ...(status.position ? { position: status.position.toString() } : {}),
        ...(status.blocked
            ? {
                  blocked: {
                      error: status.blocked.error,
                      eventPosition: status.blocked.position.toString(),
                      eventType: status.blocked.eventType,
                      attempts: status.blocked.attempts,
                      since: status.blocked.since.toISOString(),
                      nextAttemptAt: status.blocked.nextAttemptAt.toISOString()
                  }
              }
            : {}),
        ...(status.restart
            ? {
                  restart: {
                      error: status.restart.error,
                      attempts: status.restart.attempts,
                      nextAttemptAt: status.restart.nextAttemptAt.toISOString()
                  }
              }
            : {})
    }
}
