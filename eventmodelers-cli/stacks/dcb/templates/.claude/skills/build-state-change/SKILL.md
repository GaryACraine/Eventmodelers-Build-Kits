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
- **commands[0].api** — the endpoint the model declares (ADR-058 point 1): a permission (`seat:assign`), `self`,
  `link` (ADR-068) or `anonymous`. **Absent: the command has no endpoint.** Only automations issue it, in-process, through its decider
  (`import { …Decider } from "../<slice>/decider.js"`). Then skip Steps 6, 7, 8b and 9, and test it with Step 8's
  in-process form. Never add a route the model didn't declare: the `api-contract` check rejects a route the contract
  doesn't have.
- **events[]** — list of events this slice interacts with. Entries whose `id` ends with `-ref` are cross-slice references (events defined by another slice); the slice consumes them in decision models but does not emit them. Only non-ref events are emitted by this slice.
- **specifications[]** — test scenarios (given/when/then)
- **storylines[]** (optional) — board walkthroughs; see "Storyline-derived tests" under Step 5

> **Comments & description**: Each element carries a `comments: string[]` array and a `description` field. Use these as implementation hints. When done, resolve each used comment via the board API.

---

## Step 2 — Ensure the shared Events.ts exists

Each context has one `Events.ts` at `src/contexts/{context}/Events.ts` that exports tagged event factories.
**Only your own context's.** Never import another context's `Events.ts`, not even in tests (ADR-059, and the
`context-events-private` check). A fact another context owns reaches you through its published read model (the
signed-in person's `userId` comes from the session lookup) or its published event (`src/contexts/<other>/Published.ts`).

**A published event** (`"published": true` on an event in `events[]`, ADR-073) is part of your context's API, read by
other contexts:
- its type and factory go in **`src/contexts/{context}/Published.ts`** (create it if missing, same shape as below),
  never in `Events.ts`. `Published.ts` imports nothing from `Events.ts` (the check refuses it). `Events.ts`
  re-exports it (`export { … } from "./Published.js"`) and adds its type to the context's event union, so the
  context's own code reads it as any other event;
- the decision appends it **beside** the command's own event, in the same `handle` result, as the spec's `then`
  shows (`[userWasRegistered(…), userContactDetailsWereUpdated(…)]`). It's one append: both or neither;
- once another context reads it, its fields and tags are fixed: a change is a new version (`plan-change`). Never
  change an existing one in this job.

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

**The tags are the model's, never yours (ADR-071).** Each event in slice.json has `eventTags`: the keys the model
decided, in order, each on every instance. Write a new event's factory with exactly those:

```ts
tags: Tags.fromObj({ organisationId, userId })   // eventTags: organisationId, userId
```

- **Every tag is always present:** never a conditional spread (`...(x ? { x } : {})`). A tag is what a rule reads
  before it appends and what a read model files by, so it must be there on every instance. An id the event only
  sometimes has is data in its fields, not a tag.

- Never add, drop or rename a tag, and never copy another event's tags (licensing's `seatWasReleased` once copied
  `seatWasAssigned`'s and lost the person). The commit guard refuses a new factory whose tags differ from `eventTags`
  (`event-tags`).
- **If a rule can't find what it needs by the tags it's given** (a decision model would read a whole organisation to
  find one person's events), block the job with `request-feedback` and say which event needs which tag: the model
  changes, through `plan-change` ("Changing an event's tags").
- **An event already in `Events.ts`** keeps its factory: its tags change only by a deliberate change outside the loop.
- **An event recorded from another system** has that system's ids among its `eventTags` (the model marks them,
  ADR-048); the provider skill says where each comes from.

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

**Once per pair (e.g. a student rates a course once):** a toggle's sibling that only ever turns on. Tag it with
both ids, like the toggle, so it reads only that pair's events:
```typescript
export const {HasRated} = ({ entityId, otherId }: { entityId: string; otherId: string }):
    EventHandlerWithState<{RatedEvent}, boolean> => ({
    tagFilter: Tags.fromObj({ entityId, otherId }),
    init: false,
    when: {
        {ratedEventName}: () => true
    }
})
```

A command about two entities (subscribe a student to a course) uses one decision model per rule, each tagged by
the ids that rule is about. Its event is tagged with both ids.

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

Error types (the library sets the status; the problem's `detail` is the message):
- `NotFoundError` — resource does not exist (→ HTTP 404)
- `IllegalStateError` — business rule violated (→ HTTP 422)
- `ValidationError` — semantically invalid input (→ HTTP 400)

Throw each rejection with its `SPEC_ERROR` title as the message, verbatim. **A range rule on an input** (e.g.
"Rating must be between 1 and 5") is a `ValidationError` thrown in the decider, first. Keep the Zod schema to the
type (`z.number().int()`): a Zod `min`/`max` would answer 400 with a generic "Validation failed: …" detail that
doesn't match the spec.

Add only the rules a specification states. A capacity or duplicate check that no scenario asks for stays out
until a slice specifies it.

**A specification whose `then` is "nothing happens"** (a `SPEC_NOTHING` step, ADR-050). The command's intent already holds (the same
request again, a cancellation already recorded), so the decider returns `[]`: nothing is appended and nothing is
refused. Its title says why ("…: nothing happens"). Refuse with an error only when the intent *can't* hold. An **empty** `then` is an unfinished specification: block
the job with `request-feedback`, don't guess.

```typescript
    decide: (cmd, state) => {
        if (state.{alreadyDone}) return []   // the specification "…: nothing happens"
        if (state.{blocked}) throw new IllegalStateError(`{its SPEC_ERROR title}`)
        return {eventFactory}({ /* … */ })
    }
```

---

## Step 6 — Create `schema.ts` (only when `commands[0].api` is set)

File: `src/contexts/{context}/slices/{slicename}/schema.ts`

The body schema, and the route's entry in `/openapi.json` (the contract a frontend generates its client from).

```typescript
import { z } from "zod"
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi"
import { registerCommand } from "../../../../shared/openapi.js"

extendZodWithOpenApi(z)

export const {CommandName}Schema = z
    .object({
        // Every field from slice.json commands[].fields, except generated ones and those mapped `session:`
        {field1}: z.string().min(1).openapi({ example: "{example}", description: "{description}" }),
        {field2}: z.number().int().min(1).openapi({ example: 30, description: "{description}" })
    })
    .openapi("{CommandName}Body")

registerCommand({
    method: "post",
    path: "{commands[0].apiEndpoint, e.g. /change-course-capacity}",
    summary: "{the command's title from slice.json}",
    body: {CommandName}Schema,
    success: "{noContent|created}",
    // created: z.object({ {generatedField}: z.string() }),   // only with success: "created"
    errors: { {404|409|422}: "{the error text of the specifications that reject}" }
})
```

**The API contract** (`api/openapi.json`, written from the model, ADR-029) already documents this route, and the
UI may already be built against it: the body is `components.schemas.{CommandName}Body` (the command's name in
PascalCase) with slice.json's fields, all but the generated ones, required unless `optional`. Match it: the
`api-contract` commit check compares the route's path, body fields, their types and required ones, and the success
status. Which 4xx a rejection gets is yours (below); its message is the `SPEC_ERROR` title, verbatim, because the UI
shows it.

**The route is `commands[0].apiEndpoint`, always `POST`, every field in the body** (ADR-025: routes are named
after the model, e.g. `POST /change-course-capacity {courseId, newCapacity}`). Never design a REST path, never
put an ID in the path, and never use PUT/PATCH/DELETE: the endpoint in slice.json is the route. (Only if it was
overridden in the model with `{param}` segments do those come from `req.params`, written `:param`.)

- `success`: `"noContent"` (204) normally; `"created"` (201) when the command has `generated: true` fields, with
  `created` the schema of those fields (Step 7).
- `nothingNew: true` when a specification's `then` is nothing happens (`SPEC_NOTHING`, ADR-050): the route also answers
  200 with no body. The contract has the 200 then.
- `errors`: one entry per status the specifications' rejections produce (`NotFoundError` → 404,
  `IllegalStateError` → 422, `ValidationError` → 400), described by their error text. Leave it out when no
  specification rejects. 400 for a bad body is added for you.
- **No fields** (rare): leave out the Zod object and `body`; `schema.ts` holds only `registerCommand`, and
  `route.ts` imports it with `import "./schema.js"`.

The `openapi-registered` commit check rejects a route whose method and path aren't registered here, or a
`route.ts` that doesn't import `./schema.js`.

> **Generated fields**: Fields marked `generated: true` (in commands[] or events[]) must NOT appear in the Zod schema — they are not user-supplied input. A generated *command* field is made by the route (`crypto.randomUUID()`) and returned in the 201 body.

> **The signed-in person's fields** (`mapping: "session:<key>"`, ADR-055 part 2) must NOT appear in the Zod schema
> either: they come from the token, never the body. The contract leaves them out of `{CommandName}Body` too. A
> command whose every field is generated or `session:` has no body: leave out the Zod object and `body`, as for "No
> fields".

---

## Step 7 — Create `route.ts` (only when `commands[0].api` is set)

File: `src/contexts/{context}/slices/{slicename}/route.ts`

**Who may call it** is `commands[0].api`. Put its guard first, before `validateBody`:

| `api` | Guard | Answers |
|---|---|---|
| a permission (`seat:assign`) | `requirePermission("seat:assign", [/* its session keys, if any */])` | 401 not signed in; 404 in an organisation the caller has no role in; 403 a member without the permission (ADR-060); 401 step-up when the role needs a stronger sign-in (ADR-056). The organisation is the role map's tenant key (`organisationId`) in the path or body |
| `self` | `requireSession([/* its session keys */])` (below) | 401; 403 register first |
| `link` | `requireSession([/* its session keys, if any */])`: signed in, with the id from the link in the body (ADR-068). The decider checks what the person may do with it (an invitation: the invited email) | 401; 403 register first |
| `anonymous` | none | — |

`requirePermission` and `requireSession` come from `../../../../shared/signIn.js`. A permission route reads its
session keys with `sessionOf(req)`, as `self` does. Never check a role yourself.

Every command route has this shape (ADR-025): `POST {commands[0].apiEndpoint}`, all fields from the body,
`Idempotency-Key` dedupe, the position in `ETag`.

```typescript
import { handle } from "@dcb-es/event-store"
import { on, NoContent, withETag, getIdempotencyKey, validateBody, type WebApiSetup } from "@dcb-es/event-store-express"
import type { SliceDependencies } from "../../../../shared/dependencies.js"
import { findExistingPosition } from "../../../../shared/idempotency.js"
import { {commandHandlerFn} } from "./decider.js"
import { {CommandName}Schema } from "./schema.js"

export function configure{SliceName}Route(deps: SliceDependencies): WebApiSetup {
    const { store, pool } = deps

    return router => {
        router.post(
            "{commands[0].apiEndpoint}",
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
                        { idempotencyKey, retry: { onConflict: true } }
                    ))
                return res => {
                    withETag(position)(res)
                    NoContent()(res)
                }
            })
        )
    }
}
```

**Every route decides again after a conflict** (`retry: { onConflict: true }`, ADR-067): when another request
appended first, the command is read and decided again, so the loser of a race gets the decider's own refusal (422)
or nothing new, never a bare 409. Its integration test fires two of the slice's command at once with the same
tags (`Promise.all` of two `agent.post(...)`) and expects one 201/204 and the rejection's 422 when the decider has
a rule the winner's event breaks.

**When a specification's `then` is nothing happens (`SPEC_NOTHING`, ADR-050),** call `handleCommand` instead of `handle`: it
says whether anything was appended, and the route answers 200 when nothing was.

```typescript
import { handleCommand } from "@dcb-es/event-store"
import { NoContent, withETag /* … */ } from "@dcb-es/event-store-express"
// …
                const existingPosition = await findExistingPosition(pool, idempotencyKey)
                if (existingPosition) return res => { withETag(existingPosition)(res); NoContent()(res) }
                const { position, events } = await handleCommand(
                    store,
                    {commandHandlerFn},
                    { type: "{commandName}", data: { {field1}, {field2} } },
                    { idempotencyKey, retry: { onConflict: true } }
                )
                return res => {
                    withETag(position)(res)
                    if (events.length === 0) res.status(200).end()   // nothing new: the intent already holds, no body
                    else NoContent()(res)
                }
```

### The signed-in person's values (`session:`, ADR-055 part 2)

A field mapped `session:<key>` is the signed-in person's own: **never read it from the body, the path or the query
string.** List the route's session keys in `requireSession`, before `validateBody`, and read them with `sessionOf`:

```typescript
import { requireSession, sessionOf } from "../../../../shared/signIn.js"
// …
        router.post(
            "{commands[0].apiEndpoint}",
            requireSession(["{key1}", "{key2}"]),          // every session:<key> of the command's fields
            validateBody({CommandName}Schema),
            on(async req => {
                const { {field1} } = req.body                // the typed fields only
                const { {key1}: {sessionField1} } = sessionOf(req)   // e.g. activatedBy ← session:userId
```

- **`sub` and `email` are the token's;** any other key (`userId`) comes from the session lookup. `requireSession`
  answers **401** without a valid token and **403** "register first" when the lookup has nobody. Don't write either
  yourself.
- **The field keeps its own name in the command** (`activatedBy`); the session key is what the mapping names
  (`userId`).
- **Tests sign in** with `testSignIn` (`src/test/signIn.ts`). Put `signIn.configure()` first in `apis`, and send
  `.set("Authorization", await signIn.bearer({ sub: "sub-7f3a" }))`. Give it a lookup when the route needs a key the
  token doesn't hold. Add one test that a request without the header gets 401. If the route needs a looked-up key,
  add another that someone the lookup doesn't know gets 403.

### Responses (ADR-025, ADR-050): the status says what the request did
- **204** `NoContent()`: the normal answer, something was recorded. The client reads the position from `ETag`.
- **200**, no body (`res.status(200).end()`; `OK()` would send "OK" as the body): **nothing new**, the command's
  intent already holds (a specification whose `then` is nothing happens). `ETag` is the position the decision was read at. Never
  304: that's for conditional reads only.
- **201** with the generated fields, when the command has `generated: true` fields: make them before `handle`
  (`const {generatedField} = crypto.randomUUID()`, and pass them in `data`), then answer
  `res.status(201).json({ {generatedField} })` after `withETag`. On an idempotent replay, return the same body
  (read the generated value back from the recorded event, or derive it from the idempotency key).
- **Never** `Created({ createdId })` or `Created({ url })`: they send a `Location` header, and a command doesn't
  know which read model shows its result.

---

## Step 8 — Create `route.tests.ts` (or `decider.tests.ts` when there's no endpoint)

**No endpoint (`commands[0].api` absent):** test the decider in-process, in `decider.tests.ts`, with the library's
`DeciderSpecification`. Name one test after each specification, its title verbatim:

```typescript
import { describe, test } from "vitest"
import { DeciderSpecification } from "@dcb-es/event-store"
import { {eventFactory} } from "../../Events.js"
import { {commandHandlerFn} } from "./decider.js"

describe("{slice title}", () => {
    test("{specification title}", async () => {
        await DeciderSpecification.for({commandHandlerFn})
            .given({eventFactory}({ /* given's examples */ }))
            .when({ type: "{commandName}", data: { /* when's examples */ } })
            .then({eventFactory}({ /* then's examples */ }))   // or .thenThrows(…), .thenNothingHappened()
    })
})
```

**With an endpoint:**

File: `src/contexts/{context}/slices/{slicename}/route.tests.ts`

A permission route's tests sign in like a `self` route's (below), and say what the caller holds (ADR-060). The
project's role map, `api/roles.json`, decides:

```typescript
const signIn = await testSignIn(lookup, { roles: { platform: [], organisations: { "org-1": ["owner"] } } })
```

Use a role the map gives the permission, and the specifications' organisation. Add three tests:
- a request without the header gets 401;
- the same caller in another organisation gets 404;
- a member whose roles lack the permission gets 403 (`{ "org-1": ["engineer"] }`, or any role without it).

**How strongly the caller signed in** (ADR-056): `signIn.bearer({ sub })` signs in with a password and the
authenticator app (`amr: ["pwd", "totp"]`), which is enough for every role, so the other tests never depend on the
role map's levels. When the role you use is `not-by-email` in `api/roles.json` (an owner, the platform admin), add a
fourth test: the same caller signed in with only an emailed code, `signIn.bearer({ sub, amr: ["pwd", "email-otp"] })`,
gets **401** with `WWW-Authenticate` containing `insufficient_user_authentication` and `body.signIn` `not-by-email`.
`requirePermission` does this; never check `amr` in a route.

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

describe("POST {commands[0].apiEndpoint} — {slice title}", () => {
    test("{specification title}", async () => {   // the happy path
        await spec
            .existingEvents(/* events that must be present for this command to succeed */)
            .when(agent => agent.post("{commands[0].apiEndpoint}").send({ {field1}: "value", {field2}: 30 }))
            .then(
                expectResponse(204, { headers: { etag: '"N"' } }),
                {emittedEventFactory}({ /* expected event data */ })
            )
    })

    test("returns 404 when {entity} not found", async () => {
        await spec
            .when(agent => agent.post("{commands[0].apiEndpoint}").send({ {field1}: "nonexistent", {field2}: 30 }))
            .then(expectError(404))
    })

    test("{specification title}", async () => {   // a rule's rejection: 422
        await spec
            .existingEvents(/* events that trigger the rule */)
            .when(agent => agent.post("{commands[0].apiEndpoint}").send({ {field1}: "value", {field2}: 30 }))
            .then(expectError(422))
    })

    test("{specification title}", async () => {   // a specification whose then is nothing happens: 200
        await spec
            .existingEvents(/* events that make the intent already hold */)
            .when(agent => agent.post("{commands[0].apiEndpoint}").send({ {field1}: "value", {field2}: 30 }))
            .thenNothingAppended(expectResponse(200))
    })

    test("returns 400 when required field missing", async () => {
        await spec
            .when(agent => agent.post("{commands[0].apiEndpoint}").send({}))
            .then(expectError(400))
    })
})
```

Add one `test(...)` block per specification in slice.json, **named after it: its title, verbatim** (the
`spec-coverage` check matches the titles). Tests beyond the specifications (a validation 400) are welcome.

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

describe("POST {commands[0].apiEndpoint} — {slice title} (Postgres integration)", () => {
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

        const res = await agent.post("{commands[0].apiEndpoint}").send({ /* command body */ })
        expect(res.status).toBe(204) // 201 when the command has generated fields

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

        const res = await agent.post("{commands[0].apiEndpoint}").send({ /* command body */ })
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

        const res = await agent.post("{commands[0].apiEndpoint}").send({ /* invalid body */ })
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

## Step 9 — Wire up the route in `src/index.ts` (only when `commands[0].api` is set)

```typescript
import { configure{SliceName}Route } from "./contexts/{context}/slices/{slicename}/route.js"

// In the getApplication({ apis: [...] }) array:
configure{SliceName}Route(deps),
```

---

## Step 9b — A setup command (ADR-043): a draft, on first use

> **Draft.** The kit's helper is proven by its own tests (`src/shared/setup.tests.ts`), not yet by a slice the loop
> built. Follow it; where a slice doesn't fit, block the job with `request-feedback` and don't improvise.

A command with a field mapped **`config:<NAME>`** is a **setup command**: a system setting (a grace period's length)
that the app records itself, once, the first time it starts. Build everything above as for any command (its route is
how the setting is changed later), and add `setup.ts`:

```typescript
import { configInt, defineSetup } from "../../../../shared/setup.js"
import type { ConfigureGracePeriod } from "./command.js"
import { configureGracePeriodDecider } from "./decider.js"

/** Issued once, the first time the app starts: the grace period from GRACE_PERIOD_DAYS, 14 days if unset. */
export const configureGracePeriodSetup = defineSetup<ConfigureGracePeriod>({
    name: "configureGracePeriod",
    decider: configureGracePeriodDecider,
    command: env => ({
        type: "configureGracePeriod",
        data: { settingsId: "licensing", gracePeriodDays: configInt(env, "GRACE_PERIOD_DAYS", 14), configuredBy: "setup" }
    })
})
```

- `name` is the command's name: it's issued once under `setup:<name>`.
- **Each `config:<NAME>` field** reads that environment variable, and its default is the field's example in
  slice.json (`configInt` for a whole number, `configText` for text). Never invent a default.
  - **The exception: a setting that grants access** (who is a platform admin) defaults to nobody (`""`), never the
    example. A deployment that forgot the variable must not make a stranger an admin. With nothing to grant, the
    decider returns `[]`, nothing is recorded, and the setup is issued again at the next start (licensing,
    2026-10-11).
- **Each `derived:` field** is the value its mapping gives (`derived:"setup"` → `"setup"`).
- A value the decider refuses stops the app from starting: that's intended, don't catch it.
- **Wiring** (`src/index.ts`, the wiring commit): add it to `setup`, beside the route.
- **A test** in `route.integration.tests.ts`: `runSetup` issues it with the default; run again, it issues nothing.
- Add the variable to `.env.example`, with its default and what it sets.

---

## Files to create

```
src/contexts/{context}/slices/{slicename}/
├── command.ts                   ← command type
├── decisionModels.ts            ← EventHandlerWithState factories
├── decider.ts                   ← decider() combining models + logic
├── schema.ts                    ← Zod body schema + registerCommand (its /openapi.json entry)  ┐
├── route.ts                     ← Express route, guarded by its api                          │ only with
├── route.tests.ts               ← ApiSpecification unit tests (no Docker)                     │ commands[0].api
├── route.integration.tests.ts   ← Postgres integration tests (testcontainers)                 ┘
├── decider.tests.ts             ← DeciderSpecification, when the command has no endpoint
└── setup.ts                     ← a setup command only (a `config:` field): defineSetup (draft, ADR-043)

src/contexts/{context}/
└── Events.ts                    ← add new tagged event types here
```

---

## Final Verification

- [ ] Every field in `commands[].fields` has a corresponding field in `command.ts` — no invented fields, none missing
- [ ] Every event in `events[]` has a type + factory in `Events.ts` — names match exactly
- [ ] Every new event factory's `tags` are exactly its `eventTags` (ADR-071); every `EventHandlerWithState` reads by those tags, not a stream name
- [ ] Every entry in `specifications[]` maps to a `test(...)` block in `route.tests.ts` AND in `route.integration.tests.ts`
- [ ] `decider()` handlers object keys match the state properties used in `decide()`
- [ ] No business rules, defaults, or constraints were added that do not appear in slice.json `description` or `comments`
- [ ] `schema.ts` registers the route (`registerCommand`, same method and path as `route.ts`), and `route.ts` imports `./schema.js`
- [ ] The body is named `{CommandName}Body` and matches the API contract (`npm run contract:check` shows the route as match)
- [ ] Route is wired in `src/index.ts`
- [ ] A setup command (a `config:` field): `setup.ts`, its default from the field's example, added to `setup` in
      `src/index.ts`, its variable in `.env.example`
- [ ] `npm run build` passes (tsc --noEmit)
- [ ] Slice tests pass
