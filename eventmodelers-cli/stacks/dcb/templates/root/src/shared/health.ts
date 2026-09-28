import type { ProcessorStatus, RunningConsumer } from "@dcb-es/event-store-postgres"
import type { WebApiSetup } from "@dcb-es/event-store-express"

/**
 * `GET /health/processors`: every processor's state, so a blocked one is seen (ADR-033). A processor blocks when its
 * handler keeps failing on one event (our bug, or Temporal unreachable for an automation); it retries that event, with
 * a growing wait, until it succeeds. `blocked` says on which event, since when and why.
 */
export function configureProcessorStatusRoute(consumer: () => RunningConsumer | undefined): WebApiSetup {
    return router => {
        router.get("/health/processors", (_req, res) => {
            res.json({ processors: (consumer()?.status() ?? []).map(toJson) })
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
