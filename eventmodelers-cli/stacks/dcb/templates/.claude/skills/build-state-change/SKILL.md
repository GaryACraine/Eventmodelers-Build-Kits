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
- **events[]** — list of events this slice interacts with. Entries whose `id` ends with `-ref` are cross-slice references (events defined by another slice); the slice consumes them in decision models but does not emit them. Only non-ref events are emitted by this slice.
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

Tags are free-form `Record<string, string>` key-value pairs — not a type system. The convention
for choosing tag keys:

- **`idAttribute` fields are tag keys.** In slice.json, fields marked `idAttribute: true` on an
  event are the entity identity fields. Use these as tag keys. Example: `courseId`, `studentId`.
- **Single-entity events** tag with the entity's ID:
  `Tags.fromObj({ courseId })` — all course events are scoped to one course.
- **Multi-entity events** tag with ALL participating entity IDs:
  `Tags.fromObj({ courseId, studentId })` — subscription events correlate a student and a course.
- **Global index tags** use a fixed sentinel value when you need a global counter across all
  entities: `Tags.fromObj({ studentNumberIndex: "global" })`.

If the project has a `src/shared/Tags.ts` with tag key constants (e.g. `TAG_COURSE_ID = "courseId"`),
prefer importing and using those constants over inline strings for consistency across slices.

**Generated fields**: If an event field has `generated: true` in slice.json, it means the field is NOT supplied by the upstream command — the component emitting the event produces it. Default to generating a GUID (`crypto.randomUUID()`) for these fields unless the event model explicitly shows a specific generation pattern (e.g., via a dependency to an information model or an explicit slice comment describing the sequence). Do NOT add auto-increment patterns unless they are explicitly modeled.

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

> **Generated fields**: Fields marked `generated: true` in events[] must NOT appear in the command type — they are produced by the decider, not supplied by the caller.

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

### Cross-slice event consumption

In DCB, tags are globally scoped — every event with a matching tag is replayed regardless of which
slice originally emitted it. Decision models therefore commonly reference event types produced by
**other** write slices within the same context:

- `subscribe-student`'s capacity model handles `courseWasRegistered` (from register-course) and
  `courseCapacityWasChanged` (from change-course-capacity)
- `change-course-capacity` handles `studentWasSubscribed`/`studentWasUnsubscribed`
  (from subscribe/unsubscribe slices)

When building decision models:

1. **Import from `../../Events.js`** — all event types for the context live there, regardless of
   which slice produced them.
2. **`-ref` events in slice.json** are cross-slice references. Use their type and fields in
   decision models but do NOT add a new factory to Events.ts — the factory already exists from the
   producing slice.
3. **The commit scope guard already allows this** — `Events.ts` and `src/index.ts` are documented
   exceptions in `10-slice-scope.cjs`.

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

The body schema, and the route's entry in `/openapi.json` (the contract a frontend generates its client from).

```typescript
import { z } from "zod"
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi"
import { registerCommand } from "../../../../shared/openapi.js"

extendZodWithOpenApi(z)

export const {CommandName}Schema = z
    .object({
        // Fields from slice.json commands[].fields, excluding path params
        {field1}: z.string().min(1).openapi({ example: "{example}", description: "{description}" }),
        {field2}: z.number().int().min(1).openapi({ example: 30, description: "{description}" })
    })
    .openapi("{CommandName}Body")

registerCommand({
    method: "{post|put|patch|delete}",
    path: "{the route's path, exactly as route.ts writes it, e.g. /courses/:courseId/capacity}",
    summary: "{the command's title from slice.json}",
    body: {CommandName}Schema,
    success: "{createdId|createdUrl|noContent}",
    errors: { {404|409|422}: "{the error text of the specifications that reject}" }
})
```

Only include body fields here. Path parameters (`:id` in the route) come from `req.params`, not the body;
`registerCommand` documents them from the path.

- `success` names what the route answers with (Step 7): `Created({ createdId })` → `"createdId"`,
  `Created({ url })` → `"createdUrl"`, `NoContent()` → `"noContent"`.
- `errors`: one entry per status the specifications' rejections produce (`NotFoundError` → 404,
  `IllegalStateError` / `ValidationError` → 422), described by their error text. Leave it out when no
  specification rejects. 400 for a bad body is added for you.
- **No body** (a DELETE, or a command whose fields are all path parameters): leave out the Zod object and
  `body`; `schema.ts` holds only `registerCommand`, and `route.ts` imports it with `import "./schema.js"`.

The `openapi-registered` commit check rejects a route whose method and path aren't registered here, or a
`route.ts` that doesn't import `./schema.js`.

> **Generated fields**: Fields marked `generated: true` in events[] must NOT appear in the Zod schema — they are not user-supplied input.

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
Without a body there's no `validateBody` and no schema import to use, so import the registration for its
effect: `import "./schema.js"`.

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

> **Cross-slice events in tests**: `existingEvents(...)` often requires event factories from other
> slices (e.g. `courseWasRegistered` in a subscribe-student test). All factories live in the shared
> `Events.ts` — import them from `../../Events.js`.

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

---

## Step 8b — Create `route.integration.tests.ts`

File: `src/contexts/{context}/slices/{slicename}/route.integration.tests.ts`

This file mirrors every unit test scenario from Step 8 but executes against a real Postgres database via testcontainers. It verifies that events are actually persisted correctly — fields that unit tests never see (id, position, recordedAt, schemaVersion, tags round-tripped through TEXT[]).

```typescript
import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest"
import supertest from "supertest"
import type { Pool } from "pg"
import { getApplication } from "@dcb-es/event-store-express"
import { PostgresEventStore } from "@dcb-es/event-store-postgres"
import { Query, SequencePosition, streamAllEventsToArray } from "@dcb-es/event-store"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { configure{SliceName}Route } from "./route.js"
import { {existingEventFactory}, {emittedEventFactory} } from "../../Events.js"

describe("{HTTP method} /{route} — {slice title} (Postgres integration)", () => {
    let pool: Pool
    let eventStore: PostgresEventStore

    beforeAll(async () => {
        pool = await getTestPgDatabasePool({ max: 20 })
        eventStore = new PostgresEventStore({ pool })
        await eventStore.ensureInstalled()
    })

    afterEach(async () => {
        await pool.query("TRUNCATE TABLE events")
        await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
        eventStore = new PostgresEventStore({ pool })
    })

    afterAll(async () => {
        if (pool) await pool.end()
    })

    function createApp() {
        return getApplication({
            apis: [configure{SliceName}Route({ store: eventStore, pool })]
        })
    }

    // --- Happy path: verify event persisted with all SequencedEvent fields ---
    test("happy path persists event with correct SequencedEvent fields", async () => {
        // Seed prerequisite events if needed:
        // const seedPosition = await eventStore.append({
        //     events: [{existingEventFactory}({ /* ... */ })]
        // })

        const app = createApp()
        const agent = supertest(app)

        const res = await agent.post("/{route}").send({ /* command body */ })
        expect(res.status).toBe({expectedStatus})

        const newEvents = await streamAllEventsToArray(eventStore.read(Query.all()))
        // If prerequisite events were seeded, use { after: seedPosition } to skip them

        expect(newEvents).toHaveLength(1)
        const persisted = newEvents[0]

        // Event envelope
        expect(persisted.event.type).toBe("{eventType}")
        expect(persisted.event.data).toEqual({ /* expected event data */ })

        // Tags — round-tripped through TEXT[] in Postgres
        expect(persisted.tags.values).toEqual(["{tagKey}={tagValue}"])

        // Persistence metadata (unit tests never verify these)
        expect(persisted.id).toMatch(/^[0-9a-f-]{36}$/)
        expect(persisted.position.isAfter(SequencePosition.initial())).toBe(true)
        expect(persisted.recordedAt).toBeInstanceOf(Date)
        expect(persisted.recordedAt.getTime()).toBeLessThanOrEqual(Date.now())
        expect(persisted.schemaVersion).toBe("1")
    })

    // --- Error scenarios: verify NO events persisted ---
    test("returns {errorCode} when {condition}, persists no new events", async () => {
        // Seed events that trigger the error:
        const positionAfterSeed = await eventStore.append({
            events: [{existingEventFactory}({ /* ... */ })]
        })

        const app = createApp()
        const agent = supertest(app)

        const res = await agent.post("/{route}").send({ /* command body */ })
        expect(res.status).toBe({errorCode})

        const newEvents = await streamAllEventsToArray(
            eventStore.read(Query.all(), { after: positionAfterSeed })
        )
        expect(newEvents).toHaveLength(0)
    })

    // --- Validation errors (400): no seed needed, just verify no events ---
    test("returns 400 when {validation fails}, persists no new events", async () => {
        const app = createApp()
        const agent = supertest(app)

        const res = await agent.post("/{route}").send({ /* invalid body */ })
        expect(res.status).toBe(400)

        const newEvents = await streamAllEventsToArray(eventStore.read(Query.all()))
        expect(newEvents).toHaveLength(0)
    })
})
```

### Key differences from unit tests (Step 8)

| Concern | Unit test (`route.tests.ts`) | Integration test (`route.integration.tests.ts`) |
|---------|------------------------------|------------------------------------------------|
| Store | In-memory `MemoryEventStore` | Real `PostgresEventStore` with testcontainers |
| Pool | `{} as Pool` (never used) | Real `Pool` from `getTestPgDatabasePool` |
| Docker | Not required | Required (testcontainers starts Postgres) |
| Seed events | `spec.existingEvents(...)` | `eventStore.append({ events: [...] })` |
| HTTP execution | `spec.when(agent => ...)` | `supertest(createApp())` |
| Event assertion | `then(emittedEventFactory(...))` matches TaggedEvent | Read back from Postgres, verify all `SequencedEvent` fields |
| Fields verified | `event.type`, `event.data`, `tags` | Plus `id`, `position`, `recordedAt`, `schemaVersion` |
| Error scenarios | `expectError(code)` | Assert status code AND no new events persisted |

### What integration tests catch that unit tests miss

- JSON serialization round-trip (data → TEXT payload → parse)
- Tags persisted as TEXT[] and correctly reconstructed
- UUID `id` (message_id) generated and persisted
- `position` is sequential and non-zero
- `recordedAt` timestamp is reasonable
- `schemaVersion` defaults to "1"
- Error scenarios truly persist nothing (not just an in-memory check)
- Idempotency key → `message_id` mapping through real `findExistingPosition`

Add one integration `test(...)` block per specification in slice.json — the same count as the unit test file.

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
├── command.ts                   ← command type
├── decisionModels.ts            ← EventHandlerWithState factories
├── decider.ts                   ← decider() combining models + logic
├── schema.ts                    ← Zod body schema + registerCommand (its /openapi.json entry)
├── route.ts                     ← Express route
├── route.tests.ts               ← ApiSpecification unit tests (no Docker)
└── route.integration.tests.ts   ← Postgres integration tests (testcontainers)

src/contexts/{context}/
└── Events.ts                    ← add new tagged event types here
```

---

## Final Verification

- [ ] Every field in `commands[].fields` has a corresponding field in `command.ts` — no invented fields, none missing
- [ ] Every event in `events[]` has a type + factory in `Events.ts` — names match exactly
- [ ] Every `EventHandlerWithState` uses `Tags.fromObj(...)` matching the entity's tag key, not a stream name
- [ ] Every entry in `specifications[]` maps to a `test(...)` block in `route.tests.ts` AND in `route.integration.tests.ts`
- [ ] `decider()` handlers object keys match the state properties used in `decide()`
- [ ] No business rules, defaults, or constraints were added that do not appear in slice.json `description` or `comments`
- [ ] `schema.ts` registers the route (`registerCommand`, same method and path as `route.ts`), and `route.ts` imports `./schema.js`
- [ ] Route is wired in `src/index.ts`
- [ ] `npm run build` passes (tsc --noEmit)
- [ ] Slice tests pass
