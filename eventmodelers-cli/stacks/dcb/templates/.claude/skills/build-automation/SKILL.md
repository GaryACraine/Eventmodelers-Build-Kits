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

```typescript
import { handle } from "@dcb-es/event-store"
import type { EventStore } from "@dcb-es/event-store"
import type { Pool } from "pg"
import { {targetDecider} } from "../{target-slice}/decider.js"

export function create{SliceName}Processor(store: EventStore, pool: Pool) {
    return {
        // Events that trigger this processor
        canHandle: ["{triggerEventType}"],

        handle: async (event: { type: string; data: Record<string, unknown> }) => {
            if (event.type !== "{triggerEventType}") return

            const data = event.data

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
                // Log but do not rethrow — processor errors should not crash the consumer
                console.error(`[{SliceName}Processor] failed:`, err)
            }
        }
    }
}
```

---

## Step 4 — Register in `src/index.ts`

```typescript
import { create{SliceName}Processor } from "./contexts/{context}/slices/{slicename}/processor.js"

// Add to consumer processors array:
{
    // Inline event handler for automation — no projection needed
    ...create{SliceName}Processor(eventStore, pool),
    batchSize: 1,
    startFrom: "BEGINNING"
}
```

Note: unlike projections, automations do not use `pongoProjection` or `ensureHandlersInstalled`.

---

## Step 5 — Create `processor.tests.ts`

File: `src/contexts/{context}/slices/{slicename}/processor.tests.ts`

```typescript
import { describe, test } from "vitest"
import { MemoryEventStore } from "@dcb-es/event-store"
import { create{SliceName}Processor } from "./processor.js"
import type { Pool } from "pg"

describe("{SliceName} processor", () => {
    test("issues {targetCommand} when {triggerEvent} received", async () => {
        const store = new MemoryEventStore()
        const processor = create{SliceName}Processor(store, {} as Pool)

        await processor.handle({
            type: "{triggerEventType}",
            data: { {sourceId}: "test-id", /* trigger event fields */ }
        })

        // Verify the command was handled — check the event store for emitted events
        const events = store.readAll()
        expect(events).toContainEqual(
            expect.objectContaining({
                event: expect.objectContaining({ type: "{emittedEventType}" })
            })
        )
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

- [ ] `canHandle` lists all trigger event types
- [ ] Processor maps trigger event data → command data exactly per slice.json
- [ ] Errors are caught and logged — processor never crashes the consumer
- [ ] Processor registered in `src/index.ts` consumer
- [ ] One `test(...)` block per specification in slice.json
- [ ] No invented fields — if it's not in slice.json it's not in the code
