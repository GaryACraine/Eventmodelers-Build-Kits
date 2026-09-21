---
name: build-automation
description: Implements a DCB automation slice (event-triggered processor that issues a command) from a slice.json definition
---

# Build Automation Slice (DCB)

> Before doing anything else, read the slice definition from `.build-kit/.slices/{Context}/{slicename}/slice.json`. This file is the **source of truth** for all fields, events, and metadata. Never invent fields not defined there.

---

## What an Automation Slice is

A DCB automation slice is an **event-driven processor**. It listens to one or more trigger events from the event store and, for each matching event, constructs and issues a command via `handle()`. There is no HTTP route — automations run as background processors.

---

## Step 1 — Read the slice.json

From the slice definition, extract:
- **processors[]** — the trigger events and the command to issue
- **commands[]** — the command(s) the automation issues
- **events[]** — the trigger event(s) that start the automation
- **specifications[]** — test scenarios

---

## Step 2 — Ensure the target command slice exists

The automation issues a command that must already exist as a state-change slice. If it does not exist:
1. Build the target command slice first using `build-state-change`
2. Then return to build this automation

---

## Step 3 — Create `processor.ts`

File: `src/contexts/{context}/slices/{slicename}/processor.ts`

The processor must return a `ConsumerProcessorConfig` with a `handlerFactory` — not a `canHandle/handle` object.

**Side-effect processor** (notification, logging — no command issued):
```typescript
import type { ConsumerProcessorConfig } from "@dcb-es/event-store-postgres"
import type { PoolClient } from "pg"

export function create{SliceName}Processor(): ConsumerProcessorConfig {
    return {
        processorName: "{ProcessorName}",
        handlerFactory: (_client: PoolClient) => ({
            when: {
                {triggerEventType}: async ({ event }) => {
                    const data = event.data as { /* fields from trigger event */ }
                    console.log(`[{SliceName}] processing ${data.{someId}}`)
                }
            }
        }),
        batchSize: 1,
        startFrom: "BEGINNING"
    }
}
```

**Command-issuing processor** (reacts to event by issuing a command):
```typescript
import type { ConsumerProcessorConfig } from "@dcb-es/event-store-postgres"
import type { PoolClient } from "pg"
import { handle } from "@dcb-es/event-store"
import type { EventStore } from "@dcb-es/event-store"
import { {targetDecider} } from "../{target-slice}/decider.js"

export function create{SliceName}Processor(store: EventStore): ConsumerProcessorConfig {
    return {
        processorName: "{ProcessorName}",
        handlerFactory: (_client: PoolClient) => ({
            when: {
                {triggerEventType}: async ({ event }) => {
                    const data = event.data as { /* fields from trigger event */ }
                    try {
                        await handle(
                            store,
                            {targetDecider},
                            {
                                type: "{commandType}",
                                data: {
                                    // Map from trigger event data per slice.json
                                    id: data.{sourceId} as string,
                                    // ... other fields
                                }
                            }
                        )
                    } catch (err) {
                        console.error(`[{SliceName}Processor] failed:`, err)
                    }
                }
            }
        }),
        batchSize: 1,
        startFrom: "BEGINNING"
    }
}
```

---

## Step 4 — Register in `src/index.ts`

```typescript
import { create{SliceName}Processor } from "./contexts/{context}/slices/{slicename}/processor.js"

// Add to consumer processors array:
create{SliceName}Processor()  // side-effect processor (no store needed)
// OR:
create{SliceName}Processor(eventStore)  // command-issuing processor (needs store)
```

The factory returns a complete `ConsumerProcessorConfig` (including `batchSize` and `startFrom`), so do not spread or wrap it — call it directly.

Note: unlike projections, automations do not use `pongoProjection` or `ensureHandlersInstalled`.

---

## Step 5 — Create `processor.tests.ts`

File: `src/contexts/{context}/slices/{slicename}/processor.tests.ts`

Test the processor by calling its `handlerFactory` directly — do not try to use `store.readAll()` (it does not exist on the public API).

**Side-effect processor test:**
```typescript
import { describe, test, expect, vi } from "vitest"
import type { PoolClient } from "pg"
import { create{SliceName}Processor } from "./processor.js"

describe("{SliceName} processor", () => {
    test("handles {triggerEvent}", async () => {
        const config = create{SliceName}Processor()
        const handler = config.handlerFactory({} as PoolClient)

        const spy = vi.spyOn(console, "log").mockImplementation(() => {})

        await handler.when.{triggerEventType}!({
            event: { type: "{triggerEventType}", data: { /* trigger event fields */ } },
            metadata: {}
        } as any)

        expect(spy).toHaveBeenCalledWith(expect.stringContaining("{expected substring}"))
        spy.mockRestore()
    })
})
```

**Command-issuing processor test:**
```typescript
import { describe, test, expect, vi } from "vitest"
import type { PoolClient } from "pg"
import { MemoryEventStore } from "@dcb-es/event-store"
import { create{SliceName}Processor } from "./processor.js"
import { {existingEventFactory} } from "../../Events.js"

describe("{SliceName} processor", () => {
    test("issues {targetCommand} when {triggerEvent} received", async () => {
        const store = new MemoryEventStore()

        // Seed any prerequisite events the target decider needs
        await store.append({existingEventFactory}({ /* fields */ }))

        const config = create{SliceName}Processor(store)
        const handler = config.handlerFactory({} as PoolClient)

        await handler.when.{triggerEventType}!({
            event: { type: "{triggerEventType}", data: { /* trigger event fields */ } },
            metadata: {}
        } as any)

        // Verify via the store's appendSpy or by reading state
    })
})
```

---

## Files to create

```
src/contexts/{context}/slices/{slicename}/
├── processor.ts         ← event-triggered command issuer
└── processor.tests.ts   ← unit tests with MemoryEventStore

src/
└── index.ts             ← register processor in consumer
```

---

## Checklist

- [ ] Processor returns a `ConsumerProcessorConfig` with `processorName` and `handlerFactory`
- [ ] `handlerFactory` returns `{ when: { ... } }` — handler keys match trigger event type strings
- [ ] Processor maps trigger event data → command data (or side-effect) exactly per slice.json
- [ ] Errors are caught and logged — processor never crashes the consumer
- [ ] Processor registered in `src/index.ts` consumer via direct factory call (no spread)
- [ ] Tests invoke `handlerFactory` directly and call `handler.when.{eventType}!(...)` — not `store.readAll()`
- [ ] One `test(...)` block per specification in slice.json
- [ ] No invented fields — if it's not in slice.json it's not in the code
