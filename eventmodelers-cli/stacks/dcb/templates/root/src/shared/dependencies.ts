import type { EventStore } from "@dcb-es/event-store"
import type { Pool } from "pg"
import type { ReadModelRuntime } from "./readModels.js"

export interface SliceDependencies {
    store: EventStore
    pool: Pool
    /** Serves read models defined with `defineReadModel`, whichever type each is (ADR-022) */
    readModels?: Pick<ReadModelRuntime, "reader" | "querier" | "waitFn">
}
