---
name: build-state-change
description: Implements a DCB state-change slice (command, decision models, decider, schema, route, tests) from a slice.json definition
---

# Build State Change Slice (DCB)

> Before doing anything else, read the slice definition from `.build-kit/.slices/{Context}/{slicename}/slice.json`. This file is the **source of truth** for all fields, events, and metadata. Never invent fields not defined there.

---

## What a State Change Slice is

A DCB state-change slice processes a command using tag-scoped event sourcing. It:
1. Loads relevant decision state by replaying past events filtered by **tags** (not stream IDs)
2. Applies business rules against that state (`decide`)
3. Returns a `TaggedEvent` if valid, throws if not

There is no aggregate root or stream key — scoping is entirely through `Tags.fromObj({ ... })` on each `EventHandlerWithState`.

---

## Step 1 — Read the slice.json

From the slice definition, extract:
- **sliceName** — the slice title (used for directory name and type aliases)
- **context** — the bounded context (used to find `Events.ts`)
- **commands[]** — list of commands with their data fields
- **events[]** — list of events emitted with their fields
- **specifications[]** — test scenarios (given/when/then)
- **storylines[]** (optional) — board walkthroughs; see "Storyline-derived tests" under Step 5

> **Comments & description**: Each element carries a `comments: string[]` array and a `description` field. Use these as implementation hints. When done, resolve each used comment via the board API.

---

## Step 2 — Ensure the shared Events.ts exists

Each context has one `Events.ts` at `src/contexts/{context}/Events.ts` that exports tagged event factories.

### Event shape

```typescript
import { Tags, Event, TaggedEvent } from "@dcb-es/event-store"

export type {EventName}Event = Event<
    "{eventName}",
    { /* data fields from slice.json */ }
>

export const {eventName} = ({
    {field1},
    {field2},
}: {
    {field1}: string
    {field2}: string
}): TaggedEvent<{EventName}Event> => ({
    event: { type: "{eventName}", data: { {field1}, {field2} } },
    tags: Tags.fromObj({ {tagKey}: {tagValue} })
})
```

Tag key selection:
- Use the primary entity ID as the tag key (e.g. `courseId`, `studentId`)
- When global uniqueness matters (e.g. auto-increment), add an index tag: `Tags.fromObj({ studentId, studentNumberIndex: "global" })`
- When events concern two entities, tag both: `Tags.fromObj({ courseId, studentId })`

Add each new event type and factory. Do NOT remove existing ones.

---

## Step 3 — Create `command.ts`

File: `src/contexts/{context}/slices/{slicename}/command.ts`

```typescript
import { Command } from "@dcb-es/event-store"

export type {CommandName} = Command<"{commandName}", {
    id: string
    // ... other data fields from slice.json commands[]
}>
```

Field types from slice.json → TypeScript:

| slice.json type | TypeScript |
|----------------|------------|
| `String` / `UUID` | `string` |
| `Int` / `Long` | `number` |
| `Double` / `Decimal` | `number` |
| `Boolean` | `boolean` |
| `Date` / `DateTime` | `string` |
| `Custom` | `Record<string, unknown>` |

Optional fields (`optional: true`): append `?` to the field name.

---

## Step 4 — Create `decisionModels.ts`

File: `src/contexts/{context}/slices/{slicename}/decisionModels.ts`

Each decision model is an `EventHandlerWithState` factory. It defines:
- `tagFilter` — which events to replay (by tag)
- `init` — initial state value
- `when` — pure reducers updating state from event data

### Patterns

**Existence check:**
```typescript
export const {EntityExists} = (entityId: string): EventHandlerWithState<{CreatedEvent}, boolean> => ({
    tagFilter: Tags.fromObj({ {tagKey}: entityId }),
    init: false,
    when: {
        {createdEventName}: () => true
    }
})
```

**Count + capacity:**
```typescript
export const {EntityCount} = (entityId: string): EventHandlerWithState<
    {CreatedEvent} | {AddedEvent} | {RemovedEvent},
    { count: number; capacity: number }
> => ({
    tagFilter: Tags.fromObj({ {tagKey}: entityId }),
    init: { count: 0, capacity: 0 },
    when: {
        {createdEventName}: ({ event }) => ({ capacity: event.data.capacity, count: 0 }),
        {addedEventName}: (_ev, state) => ({ ...state, count: state.count + 1 }),
        {removedEventName}: (_ev, state) => ({ ...state, count: state.count - 1 })
    }
})
```

**Toggle (subscribed/unsubscribed):**
```typescript
export const {IsSubscribed} = ({ entityId, otherId }: { entityId: string; otherId: string }):
    EventHandlerWithState<{SubscribedEvent} | {UnsubscribedEvent}, boolean> => ({
    tagFilter: Tags.fromObj({ entityId, otherId }),
    init: false,
    when: {
        {subscribedEventName}: () => true,
        {unsubscribedEventName}: () => false
    }
})
```

**Global counter (auto-increment):**
```typescript
export const NextNumber = (): EventHandlerWithState<{CreatedEvent}, number> => ({
    tagFilter: Tags.fromObj({ indexTag: "global" }),
    init: 1,
    onlyLastEvent: true,
    when: {
        {createdEventName}: ({ event }) => event.data.number + 1
    }
})
```

---

## Step 5 — Create `decider.ts`

File: `src/contexts/{context}/slices/{slicename}/decider.ts`

```typescript
import { decider, IllegalStateError, NotFoundError, ValidationError } from "@dcb-es/event-store"
import { {eventFactory} } from "../../Events.js"
import { {ModelA}, {ModelB} } from "./decisionModels.js"
import type { {CommandName} } from "./command.js"

export const {commandHandlerFn} = decider<
    {CommandName},
    {
        {modelA}: ReturnType<typeof {ModelA}>
        {modelB}: ReturnType<typeof {ModelB}>
    }
>({
    handlers: cmd => ({
        {modelA}: {ModelA}(cmd.data.{id}),
        {modelB}: {ModelB}(cmd.data.{otherId})
    }),
    decide: (cmd, state) => {
        if (!state.{modelA}) throw new NotFoundError(`{Entity} ${cmd.data.{id}} not found.`)
        if (state.{modelB}) throw new IllegalStateError(`Already in that state.`)

        return {eventFactory}({
            {id}: cmd.data.{id},
            // ... map remaining fields from cmd.data per slice.json
        })
    }
})
```

Error types:
- `NotFoundError` — resource does not exist (→ HTTP 404)
- `IllegalStateError` — business rule violated (→ HTTP 422)
- `ValidationError` — semantically invalid input (→ HTTP 422)

---

## Step 6 — Create `schema.ts`

File: `src/contexts/{context}/slices/{slicename}/schema.ts`

```typescript
import { z } from "zod"
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi"

extendZodWithOpenApi(z)

export const {CommandName}Schema = z
    .object({
        // Fields from slice.json commands[].fields, excluding path params
        {field1}: z.string().min(1).openapi({ example: "{example}", description: "{description}" }),
        {field2}: z.number().int().min(1).openapi({ example: 30, description: "{description}" })
    })
    .openapi("{CommandName}Body")
```

Only include body fields here. Path parameters (`:id` in the route) come from `req.params`, not the body.

---

## Step 7 — Create `route.ts`

File: `src/contexts/{context}/slices/{slicename}/route.ts`

### POST route (create/trigger):
```typescript
import { handle } from "@dcb-es/event-store"
import { on, Created, withETag, getIdempotencyKey, validateBody, type WebApiSetup } from "@dcb-es/event-store-express"
import type { SliceDependencies } from "../../../../shared/dependencies.js"
import { findExistingPosition } from "../../../../shared/idempotency.js"
import { {commandHandlerFn} } from "./decider.js"
import { {CommandName}Schema } from "./schema.js"

export function configure{SliceName}Route(deps: SliceDependencies): WebApiSetup {
    const { store, pool } = deps

    return router => {
        router.post(
            "/{resource}",
            validateBody({CommandName}Schema),
            on(async req => {
                const { {field1}, {field2} } = req.body
                const idempotencyKey = getIdempotencyKey(req)
                const existingPosition = await findExistingPosition(pool, idempotencyKey)
                const position =
                    existingPosition ??
                    (await handle(
                        store,
                        {commandHandlerFn},
                        { type: "{commandName}", data: { {field1}, {field2} } },
                        { idempotencyKey }
                    ))
                return res => {
                    withETag(position)(res)
                    Created({ createdId: {field1} })(res)
                }
            })
        )
    }
}
```

### PUT/DELETE route (update/remove):
Replace `Created(...)` with `NoContent()` and adjust the HTTP method and path parameters accordingly.

Import `NoContent` from `@dcb-es/event-store-express` for 204 responses.

### Response helpers:
- `Created({ createdId })` → 201 with `{ id }` body
- `Created({ url })` → 201 with `Location` header
- `NoContent()` → 204

---

## Step 8 — Create `route.tests.ts`

File: `src/contexts/{context}/slices/{slicename}/route.tests.ts`

Uses `ApiSpecification` (in-memory store, no Docker needed for unit tests):

```typescript
import { describe, test } from "vitest"
import type { Pool } from "pg"
import { ApiSpecification, ApiE2ESpecification, expectResponse, expectError } from "@dcb-es/event-store-express"
import type { EventStore } from "@dcb-es/event-store"
import { configure{SliceName}Route } from "./route.js"
import { {existingEventFactory}, {emittedEventFactory} } from "../../Events.js"

const spec = ApiSpecification.for({
    configureApi: (store: EventStore) => configure{SliceName}Route({ store, pool: {} as Pool })
})

describe("{HTTP method} /{route} — {slice title}", () => {
    test("happy path returns {expectedStatus}", async () => {
        await spec
            .existingEvents(/* events that must be present for this command to succeed */)
            .when(agent => agent.post("/{route}").send({ {field1}: "value", {field2}: 30 }))
            .then(
                expectResponse({expectedStatus}, { body: { id: "value" }, headers: { etag: '"N"' } }),
                {emittedEventFactory}({ /* expected event data */ })
            )
    })

    test("returns 404 when {entity} not found", async () => {
        await spec
            .when(agent => agent.post("/{route}").send({ {field1}: "nonexistent", {field2}: 30 }))
            .then(expectError(404))
    })

    test("returns 422 when business rule violated", async () => {
        await spec
            .existingEvents(/* events that trigger the rule */)
            .when(agent => agent.post("/{route}").send({ {field1}: "value", {field2}: 30 }))
            .then(expectError(422))
    })

    test("returns 400 when required field missing", async () => {
        await spec
            .when(agent => agent.post("/{route}").send({}))
            .then(expectError(400))
    })
})
```

Add one `test(...)` block per specification in slice.json.

### Storyline-derived tests (optional)

If `storylines[]` is present in slice.json, add tests derived from command beats:
- `given` — cumulative events from start of storyline up to (not including) the command beat
- `when` — the command built from the beat's `fields`
- `then` — the following event beat(s)

Put these in a separate `describe` block named after the storyline.

---

## Step 9 — Wire up the route in `src/index.ts`

```typescript
import { configure{SliceName}Route } from "./contexts/{context}/slices/{slicename}/route.js"

// In the getApplication({ apis: [...] }) array:
configure{SliceName}Route(deps),
```

---

## Files to create

```
src/contexts/{context}/slices/{slicename}/
├── command.ts          ← command type
├── decisionModels.ts   ← EventHandlerWithState factories
├── decider.ts          ← decider() combining models + logic
├── schema.ts           ← Zod schema + openapi extensions
├── route.ts            ← Express route
└── route.tests.ts      ← ApiSpecification unit tests

src/contexts/{context}/
└── Events.ts           ← add new tagged event types here
```

---

## Final Verification

- [ ] Every field in `commands[].fields` has a corresponding field in `command.ts` — no invented fields, none missing
- [ ] Every event in `events[]` has a type + factory in `Events.ts` — names match exactly
- [ ] Every `EventHandlerWithState` uses `Tags.fromObj(...)` matching the entity's tag key, not a stream name
- [ ] Every entry in `specifications[]` maps to a `test(...)` block in `route.tests.ts`
- [ ] `decider()` handlers object keys match the state properties used in `decide()`
- [ ] No business rules, defaults, or constraints were added that do not appear in slice.json `description` or `comments`
- [ ] Route is wired in `src/index.ts`
- [ ] `npm run build` passes (tsc --noEmit)
- [ ] Slice tests pass
