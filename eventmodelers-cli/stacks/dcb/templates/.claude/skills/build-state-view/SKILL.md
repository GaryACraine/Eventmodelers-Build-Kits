---
name: build-state-view
description: Implements a DCB state-view slice — one read model definition served as async, inline or live, with a generic route, named where-predicate queries and contract tests across all three types — from a slice.json definition
---

# Build State View Slice (DCB)

> Before doing anything else, read the slice definition from `.build-kit/.slices/{Context}/{slicename}/slice.json`. This file is the **source of truth** for all fields, events, and read model shape. Never invent fields not defined there.

---

## What a State View Slice is

A state-view slice is a **read model**: a document per key (a course, a student), built from events and served
by a GET route. It doesn't emit events or process commands.

The model picks how the read model is kept current, in `readmodels[0].readModelType`:

| Type | How it runs | A read straight after a write |
|---|---|---|
| `database-projected` (the default when absent) | stored; an async consumer follows the event store | may be a moment behind |
| `inline-projected` | stored; updated inside the append transaction | always current |
| `live-report` | not stored; each read folds the key's events from the event store | always current |

**The contract (ADR-022): the data a client gets is the same whichever type serves the read model.** The same
URL, the same response body, the same status (200, or 404 for an unknown key). So the model can switch the type
later without breaking a client. That works because the read model is written **once**, as a keyed fold
(`defineReadModel` in `readModel.ts`). The scaffold's `src/shared/readModels.ts` runs that one definition as
any of the three types, and `readModelRoute` serves it. The type is one line.

**Queries (ADR-023).** Besides the keyed GET, a read model can answer named **queries**: where predicates over
its documents, such as "courses with at least one free seat". The model declares each one on the read model
element (`readmodels[0].queries`), and a spec whose *when* is a `SPEC_QUERY` step exercises it. A query is
`GET {its endpoint}?{parameters}` → `{ "data": [ …documents… ], "cursor"?: "…" }`, 200 even when `data` is
empty, 400 for a bad parameter, never 404. Queries are declared in `readModel.ts` too, and `readModelRoute`
serves them all, so the page is the same whichever type serves it.

> **Cross-slice events**: A read model typically consumes events from several write slices. That works because
> the DCB event store is a single ordered log. The `events[]` array in slice.json already lists every event it
> needs, including cross-slice references.

---

## Step 0 — What kind of work is this?

Read the slice.json first:

- **`retype` block present** (`{ "from": …, "to": … }`) → the model changed an already-built read model's
  type. Follow **"Changing a read model's type"** below. Nothing else changes.
- **`addQueries` present** (`["availableCourses"]`) → an already-built slice whose specs now run queries its
  read model doesn't serve yet. Follow **"Adding queries"** below. Nothing else changes: not `evolve`, not the
  events, not the existing tests. If `retype` is present too, do the retype first, as its own commit (R1–R3),
  then the queries, and set the slice to `Done` only after both.
- **`extends` block present** → an **extension slice**. Its read model is a copy (`readmodels[0].linkedTo`) of
  one an earlier slice built. Follow **"Extending a read model"** below. Don't create a new read model.
- **Otherwise** → a new read model: Steps 1–6.

In every case, the **queries to build** are the query names in this slice's specs (the title of each *when*
`SPEC_QUERY` step) that the definition doesn't declare yet. For a new read model that's every query its specs
run. A query declared on the element that no spec runs isn't built, because nothing would test it: say so in
your report.

Read models grow one event at a time as the timeline is discovered. Each copy of a read model on the board is
its own slice, so each growth step is its own unit of delivery. The code stays in one place, the origin's
folder, so one read model stays one file you can read top to bottom.

---

## Step 1 — Read the slice.json

From the slice definition, extract:
- **sliceName** — the read model name (`readmodels[0].title`)
- **context** — bounded context
- **type** — `readmodels[0].readModelType`, or `"database-projected"` when absent
- **key** — the readmodel field with `idAttribute: true` (e.g. `courseId`)
- **path** — `readmodels[0].apiEndpoint` with `{param}` written as `:param` (`/course-details/{courseId}` →
  `/course-details/:courseId`). Routes are named after the model (ADR-025): copy it, never design one
- **events[]** — the events this read model handles
- **readModel.fields** — the shape of the document, which is the response body
- **queries[]** — `readmodels[0].queries` (optional): each `{ name, apiEndpoint, parameters, sort? }`. See Step 3b.
- **specifications[]** — each is *given* events → *when* → *then*. An empty *when* is the keyed GET (*then* is
  the one document). A *when* holding one `SPEC_QUERY` step runs the query named by its title, with its fields'
  `example`s as the parameter values (*then* is the rows it returns, in order; empty means no matches).
- **storylines[]** (optional) — board walkthroughs; see "Storyline-derived tests" under P4

> **Comments & description**: Use these as implementation hints. Resolve used comments via the board API when done.

---

## Step 2 — Choose the form

**Fold form** (`readModel.ts`, Steps 3–6) is the default. It needs all of this, which you check in
`src/contexts/{context}/Events.ts`, where each event's `tags: Tags.fromObj({ … })` is declared:

1. **Keyed GET:** the `path` has the key as its parameter, and the read model is not a list
   (`listElement` is not true).
2. **Key tag:** every event in `events[]` that shapes the document carries the key as a tag
   (`Tags.fromObj({ courseId })`).
3. **Lookups:** data from another entity (a student's *name* on a course) must be reachable by tags. The event
   that brings the other entity in (`studentWasSubscribed`) carries that entity's id as a tag (`studentId`),
   and the events that hold the data (`studentWasRegistered`) carry the same tag. Each such entity becomes a
   **lookup**.

4. **Live queries** (only when the type is `live-report` and there are queries to build): each query needs a
   required parameter with a `tag` and operator `eq`, `in` or `contains`. A live read finds the query's
   candidates by that tag: the keys of the `events[]` events tagged `{tag}={value}`. So at least one event in
   `events[]` must carry **both** that tag and the key tag, and it must be the event that makes a document match
   (`studentWasSubscribed` carries `courseId` and `studentId`, so "courses for a student" works). A query
   without such a parameter is stored-only: `startReadModels` refuses it on a live read model.

**Imperative form** (`projection.ts`, the "Imperative form" section below) is only for what fold form can't
express: list read models, or data reachable only by payload fields, not tags. It can be async or inline, but
**never live**, and it **can't serve queries**. A list the model gives a query (often a parameterless one) is
built in fold form, one document per key, with that query. It isn't an imperative list.

If the type is `live-report` and any requirement above fails, stop and invoke `request-feedback` naming the
failing requirement (for example, "`studentWasRegistered` has no `courseId` tag and isn't reachable as a
lookup", or "query `availableCourses` has no tagged parameter, so live can't serve it"). If there are queries to
build and fold form's requirements 1–3 fail, do the same: never serve a query from an imperative projection.
Never build a different type than slice.json names.

---

## Step 3 — Create `readModel.ts` (fold form)

File: `src/contexts/{context}/slices/{slicename}/readModel.ts`

```typescript
/* eslint-disable @typescript-eslint/no-explicit-any */
import { defineReadModel } from "../../../../shared/readModels.js"

export interface {SliceName}Doc {
    [key: string]: unknown
    // ... fields from slice.json readModel, exactly as the response body shows them
}

// Only when the read model needs data from another entity (Step 2, requirement 3):
interface {Related}Entry {
    [key: string]: unknown
    // ... just the fields of the related entity this read model shows
}

export const {sliceName} = defineReadModel<{SliceName}Doc, { {relatedPlural}: {Related}Entry }>({
    name: "{SliceName}",
    type: "{type}",                     // slice.json readModelType — the only line a type switch changes
    key: "{key}",
    collection: "{snake_case_name}",    // where the stored types keep documents
    canHandle: [
        "{eventType1}",
        "{eventType2}"
    ],
    lookups: {
        {relatedPlural}: {
            key: "{relatedKey}",        // e.g. "studentId"
            canHandle: [
                "{relatedEventType}"
            ],
            evolve: (entry, { event }) => {
                const data = event.data as Record<string, any>
                return { name: data.name }
            }
        }
    },
    // Only when there are queries to build (Step 3b):
    queries: {
        {queryName}: {
            path: "{query path}",       // the query's apiEndpoint, `{param}` written as `:param`
            params: {
                {paramName}: { field: "{mapping}", op: "{operator}", type: "{string|number|boolean}" }
            }
        }
    },
    evolve: (doc, { event }, { {relatedPlural} }) => {
        const data = event.data as Record<string, any>
        switch (event.type) {
            case "{eventType1}":
                return { {key}: data.{key}, {field1}: data.{field1} }
            case "{eventType2}":
                return doc && { ...doc, {field1}: data.{newField1} }
        }
        return doc
    }
})
```

Leave out `lookups` (and the second type argument) when the read model needs no other entity, and `queries`
when there are none to build. Keep `queries` **before `evolve`**: a query added later is then an insertion,
never an edit of the lines around it.

Rules for `evolve`. They are what make the three types produce the same data:

- **Pure.** No I/O, no clock, no randomness. It gets the document so far (or `null`) and one event, and
  returns the next document, or `null` to delete it.
- **Return new objects** (`{ ...doc, … }`), never mutate `doc`.
- **Tolerate a missing document:** `return doc && { … }` for events that update one.
- **Lookups:** `{relatedPlural}.get(id)` holds entries only for the ids in the **current event's tags**. Read
  the related data at the event that brings the entity in (`studentWasSubscribed`), and copy what the document
  shows. A missing entry is `undefined`: store `null`, don't throw.
- **Ignored events:** end the `switch` with `return doc`.
- **Aggregates** (fields mapped `derived: count of …` / `average of ….field`): the first event creates the
  document from `doc?.… ?? 0`. Keep only the fields slice.json declares: update an average incrementally,
  `(average * (count - 1) + value) / count`, rather than storing a hidden sum. Such a document doesn't exist
  until its first event, so its keyed GET answers 404 until then (the UI shows that as empty, not as an error).
- Write `canHandle` (and each lookup's `canHandle`) **one event per line**, each followed by a comma except the
  last. Extension slices append to these arrays.

### Step 3b — Declare the queries

One entry in `queries` per query to build (Step 0), copied from its `readmodels[0].queries` entry. The model
has settled every choice here. Transcribe it and don't invent parameters, operators or endpoints.

| slice.json (`queries[]`) | `readModel.ts` |
|---|---|
| `name` | the key in `queries` |
| `apiEndpoint` `/course-details/courses-for-student` | `path: "/course-details/courses-for-student"` (an override's `{param}` is written `:param`) |
| parameter `name` | the key in `params` |
| parameter `mapping` (a dot path into the document) | `field` |
| parameter `operator` | `op`: leave it out when it's `eq` |
| parameter `type`: `String`, `UUID`, `Date`, `DateTime` | `type: "string"` |
| parameter `type`: `Int`, `Long`, `Double`, `Decimal` | `type: "number"` |
| parameter `type`: `Boolean` | `type: "boolean"` |
| parameter `optional: true` | `optional: true` |
| parameter `tag` | `tag` (the tag key on the events, e.g. `"studentId"`) |
| `sort: { field, direction }` | `sort: { field }`, adding `direction: "desc"` only when it's `desc` |

- By the standard every parameter is a query-string parameter. `pathParameter: true` appears only when the
  model overrode the endpoint with a `{param}`; it needs nothing of its own, because `defineReadModel` checks
  that each `:param` in `path` is a required `eq`/`contains` parameter.
- Write each query's `params` **one parameter per line**, and end every query entry with `},` except the last,
  as with `canHandle`.
- `field` must be a field the document actually has, because `evolve` writes it. A `mapping` into a field this
  read model doesn't produce is a model error. Invoke `request-feedback` naming it.
- Don't write any SQL, filtering or paging. The runtime serves every query the same way for every type, and
  creates the indexes it uses on start.

---

## Step 4 — Create `schema.ts` and `route.ts`

File: `src/contexts/{context}/slices/{slicename}/schema.ts`

The Zod schema of the document: what `/openapi.json` shows a frontend for the keyed GET and every query.

```typescript
import { z } from "zod"
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi"

extendZodWithOpenApi(z)

export const {SliceName}Schema = z
    .object({
        // One entry per field of the Doc interface, same names and types (slice.json readModel.fields)
        {key}: z.string().openapi({ example: "{example}" }),
        {field1}: z.number().int().openapi({ example: {example} }),
        {listField}: z.array(z.object({ {subField}: z.string() }))
    })
    .openapi("{SliceName}")
```

- Types follow the Doc interface: `string` → `z.string()`, `number` → `z.number()` (`.int()` for `Int`/`Long`),
  `boolean` → `z.boolean()`, a list → `z.array(z.object({ … }))`, a value `evolve` may store as `null` →
  `.nullable()`, an optional Doc field → `.optional()`.
- Examples come from the slice.json field `example`s. Leave `.openapi({ … })` out of a field without one.
- Don't add `.min()` or other validation: this schema describes a response, it doesn't check input.

File: `src/contexts/{context}/slices/{slicename}/route.ts`

```typescript
import type { WebApiSetup } from "@dcb-es/event-store-express"
import type { SliceDependencies } from "../../../../shared/dependencies.js"
import { readModelRoute } from "../../../../shared/readModels.js"
import { {sliceName} } from "./readModel.js"
import { {SliceName}Schema } from "./schema.js"

// Serves the {SliceName} document as the body, whichever type the read model runs as (ADR-022).
export function configure{SliceName}Route(deps: SliceDependencies): WebApiSetup {
    return readModelRoute({sliceName}, deps.readModels!, "{path}", {
        schema: {SliceName}Schema,
        pool: deps.pool,
        notFound: "{Entity} not found"
    })
}
```

Don't write a handler by hand: `readModelRoute` returns the document as the body, 404 for an unknown key, and
for an async read model the optional `Prefer: wait` / ETag extras. It also serves **every query in the
definition** at that query's `path`, so a query needs no route code of its own. The route file is the same with
or without queries.

`readModelRoute` also puts the keyed GET and every query into `/openapi.json`, documented with `schema`. The
`openapi-registered` commit check rejects a `readModelRoute` call without `schema`, and tsc checks the schema
against the Doc interface: a field missing from it, or with another type, fails the build. (An optional Doc
field left out isn't caught: add those too.)

---

## Step 5 — Register it in `src/index.ts`

Add the definition to the `readModels` array. This goes in a separate `chore: wire …` commit, because
`index.ts` isn't slice work:

```typescript
import { {sliceName} } from "./contexts/{context}/slices/{slicename}/readModel.js"
import { configure{SliceName}Route } from "./contexts/{context}/slices/{slicename}/route.js"

const readModels: ReadModel[] = [..., {sliceName}]

// In the apis array:
configure{SliceName}Route(deps),
```

`startReadModels` does the rest: it runs the read model by its `type`, backfills or rebuilds stored ones on
start, and hands out the reader the route uses.

---

## Step 6 — Create `route.tests.ts`: one contract, all three types

File: `src/contexts/{context}/slices/{slicename}/route.tests.ts`

The tests prove the contract: **the same scenarios, run against every type, get the same bodies.** They talk
HTTP only. Write through the write slices' routes, call `settle()` (which waits for an async read model to
catch up, and does nothing for inline and live), then GET.

```typescript
import { describe, test, expect } from "vitest"
import { readModelTestApp } from "@test/readModelHarness"
import { READ_MODEL_TYPES, withType } from "../../../../shared/readModels.js"
import { configure{WriteSlice}Route } from "../{write-slice}/route.js"
import { configure{SliceName}Route } from "./route.js"
import { {sliceName} } from "./readModel.js"

describe.each(READ_MODEL_TYPES)("{slice title} (%s)", type => {
    const app = readModelTestApp({
        readModels: [withType({sliceName}, type)],
        routes: deps => [configure{WriteSlice}Route(deps), configure{SliceName}Route(deps)]
    })

    test("{specification title}", async () => {
        // Given — through the write routes
        const postRes = await app.agent().post("/{command}").send({ /* command body */ })
        expect(postRes.status).toBe(204)

        await app.settle()

        // Then
        const getRes = await app.agent().get("/{read-model}/test-id")
        expect(getRes.status).toBe(200)
        expect(getRes.body).toMatchObject({ /* the read model fields this specification asserts */ })
    })
})
```

- **One `test(...)` per specification** in slice.json, inside the `describe.each` block.
- **Assert bodies with `toMatchObject`**, never an exact-shape `toEqual`. The read model grows as extension
  slices add fields. An exact-shape assertion would then fail although its scenario still holds.
- **Nothing type-specific in the file.** No consumers, no `Prefer: wait`, no store setup. That is what lets a
  retype run these tests unchanged.
- Every test gets a fresh database (the harness does it), so there is no reset code.
- Storyline-derived tests (see P4) go in their own `describe.each` block in the same layout.
- The block above holds the **keyed** specifications, the ones with an empty *when*. Specifications whose *when*
  runs a query go in the query blocks below.

### Step 6b — Query tests: one block per query

A specification whose *when* is a `SPEC_QUERY` step becomes a test in its query's block. Each block runs over
**the types that can serve that query**: `queryTypes` gives all three when a tag narrows the query, and the two
stored types otherwise. (`withType(…, "live-report")` drops stored-only queries, which is why the keyed block
above still runs live.)

```typescript
import { READ_MODEL_TYPES, queryTypes, withType } from "../../../../shared/readModels.js"

describe.each(queryTypes({sliceName}, "{queryName}"))("{slice title}: {queryName} (%s)", type => {
    const app = readModelTestApp({
        readModels: [withType({sliceName}, type)],
        routes: deps => [configure{WriteSlice}Route(deps), configure{SliceName}Route(deps)]
    })

    test("{specification title}", async () => {
        // Given: every event in the specification's given, through the write routes
        expect((await app.agent().post("/{command}").send({ /* command body */ })).status).toBe(204)
        await app.settle()

        // When: the query, with the when step's example values
        const res = await app.agent().get("{query path}").query({ {param}: "{example}" })

        // Then: the rows, in order
        expect(res.status).toBe(200)
        expect(res.body.data).toMatchObject([
            { /* then row 1: the fields it gives examples for */ },
            { /* then row 2 */ }
        ])
    })
})
```

- **When:** each *when* field is a parameter, and its `example` is the value.
  - Parameters go in `.query({ … })`, always as strings (an overridden endpoint's path parameter goes into
    the URL instead).
  - An `in` parameter's values are joined with commas (`{ courseIds: "c1,c2" }`).
  - Leave out an optional parameter that has no example. A required one with no example on the *when* field
    uses the parameter's own `example` from `queries[]`.
- **Then:** one object per *then* row, in the order given. That is the query's order (its `sort`, else the key
  ascending), so write the *given* events so that holds.
  - `toMatchObject` on the array checks the row count and the order, and each row only on the fields it names.
    So an extension that adds fields later can't break it.
  - An empty *then* is `expect(res.body.data).toEqual([])`.
  - A *then* row with no example values can't be asserted. Invoke `request-feedback` ("specification X: the rows
    it expects have no example values") and don't invent them.
- **Given:** its events must produce the documents the rows name, and also documents the query should **not**
  return, when the specification gives them. That is what proves the predicate.
- Keep these blocks free of anything type-specific, like the keyed block. Don't assert `cursor` unless a
  specification is about paging.

---

## Imperative form (lists, and read models fold form can't express)

Use this only when Step 2 sends you here. It builds a `pongoProjection` by hand, stored as async or inline.

### P0 — Choosing async or inline

- `database-projected` → P1–P4 as written.
- `inline-projected` → P1–P4 with the **Inline** changes after P4.

### P1 — `projection.ts`

File: `src/contexts/{context}/slices/{slicename}/projection.ts`

```typescript
/* eslint-disable @typescript-eslint/no-explicit-any */
import { SequencedEvent } from "@dcb-es/event-store"
import { pongoProjection, PongoProjectionContext } from "@dcb-es/event-store-postgres"

export interface {SliceName}Doc {
    [key: string]: unknown
    _id?: string
    // ... fields from slice.json readModel
}

export const {PROJECTION_NAME_CONST} = "{SliceName}Projection"

export const {sliceName}Projection = pongoProjection({
    name: {PROJECTION_NAME_CONST},
    canHandle: [
        // event type strings from slice.json events[]
        "{eventType1}",
        "{eventType2}"
    ],
    init: async pongo => {
        const db = pongo.db()
        await db.collection<{SliceName}Doc>("{collectionName}").createCollection()
        // Create additional lookup collections if needed
    },
    handle: async (events: SequencedEvent[], context: PongoProjectionContext) => {
        const collection = context.pongo.db().collection<{SliceName}Doc>("{collectionName}")

        for (const sequencedEvent of events) {
            const data = sequencedEvent.event.data as Record<string, unknown>
            switch (sequencedEvent.event.type) {
                case "{eventType1}":
                    await collection.insertOne({
                        _id: data.{entityId} as string,
                        {field1}: data.{field1} as string,
                        {field2}: data.{field2} as number
                    })
                    break
                case "{eventType2}":
                    await collection.updateOne(
                        { _id: data.{entityId} as string },
                        { $set: { {field1}: data.{newField1} as string } }
                    )
                    break
            }
        }
    },
    truncate: async pongo => {
        await pongo.db().collection<{SliceName}Doc>("{collectionName}").deleteMany()
    }
})
```

Write `canHandle` **one event per line, each followed by a comma except the last**, even when there is
only one event. Extension slices append to this array. A one-line array (`canHandle: ["a"]`) can only be
extended by rewriting the line.

#### Pongo operation patterns

**Insert (on create event):**
```typescript
await collection.insertOne({
    _id: data.entityId as string,
    entityId: data.entityId as string,
    field1: data.field1 as string
})
```

**Update specific fields:**
```typescript
await collection.updateOne(
    { _id: data.entityId as string },
    { $set: { field1: data.newField1 as string } }
)
```

**Push to array (append-to-collection):**
```typescript
await collection.updateOne(
    { _id: data.entityId as string },
    { $push: { items: { id: data.itemId, name: data.name } } as any }
)
```

**Filter array (remove from collection):**
```typescript
const doc = await collection.findOne({ _id: data.entityId as string })
if (doc) {
    await collection.updateOne(
        { _id: data.entityId as string },
        { $set: { items: doc.items.filter(i => i.id !== data.itemId) } }
    )
}
```

**Cross-collection lookup (for denormalisation):**

> **Lookup collection naming**: When a readmodel field has `cardinality: "List"` with `subfields` sourced from a different entity's events, create a separate lookup collection. Name it `_{projectionCollectionName}_{entityPlural}` — e.g., for a `students` collection needing course data: `_student_projection_courses`. This mirrors the reference project pattern.

```typescript
const lookup = context.pongo.db().collection<LookupDoc>("_{projectionName}_{entityPlural}")
const related = await lookup.findOne({ _id: data.relatedId as string })
if (related) {
    await collection.updateOne(
        { _id: data.entityId as string },
        { $push: { relatedItems: { id: related.id, name: related.name } } as any }
    )
}
```

Note: with Pongo there is no need to pin to a transaction client — Pongo manages its own connection pool.

---

### P2 — Register it in `src/index.ts`

Add it to the `imperative` array (a separate `chore: wire …` commit):

```typescript
import { {sliceName}Projection, {PROJECTION_NAME_CONST} } from "./contexts/{context}/slices/{slicename}/projection.js"

const imperative: StoredProjectionRegistration[] = [
    ...,
    { projection: {sliceName}Projection, type: "{type}" }   // "database-projected" or "inline-projected"
]

// In the apis array — async: the route waits through the index's `waitFor` helper
configure{SliceName}Route({ ...deps, waitFn: waitFor({PROJECTION_NAME_CONST}) }),
// inline: no waitFn
configure{SliceName}Route(deps),
```

`startReadModels` inits it, registers async projections with the consumer and inline ones in the event store,
and keeps them current (`ensureProjectionsCurrent`).

### P3 — `schema.ts` and `route.ts` (async)

File: `src/contexts/{context}/slices/{slicename}/schema.ts`

A hand-written route is documented by hand, with `registerRead`, the response body as a Zod schema written as
in Step 4:

```typescript
import { z } from "zod"
import { registerRead } from "../../../../shared/openapi.js"

export const {SliceName}Schema = z
    .object({
        // the response body's fields, as the handler below maps them
    })
    .openapi("{SliceName}")

registerRead({
    path: "/{read-model}/:{key}",       // exactly as route.ts writes it: the apiEndpoint (ADR-025)
    summary: "{the read model's title}",
    response: {SliceName}Schema,        // a list: z.object({ data: z.array({SliceName}Schema), cursor: z.string().optional() })
    notFound: "{Entity} not found",     // keyed reads only
    wait: true                          // async: it honours Prefer: wait and sends an ETag; false for inline
})
```

The `openapi-registered` commit check rejects a `router.get(…)` path that `schema.ts` doesn't register, and a
`route.ts` that doesn't import `./schema.js`.

File: `src/contexts/{context}/slices/{slicename}/route.ts`

```typescript
import { on, OK, withETag, preferWait, type WebApiSetup, type WaitFunction } from "@dcb-es/event-store-express"
import type { SliceDependencies } from "../../../../shared/dependencies.js"
import { {PROJECTION_NAME_CONST} } from "./projection.js"
import type { {SliceName}Doc } from "./projection.js"
import "./schema.js"

export function configure{SliceName}Route(deps: SliceDependencies & { waitFn?: WaitFunction }): WebApiSetup {
    const { pool, waitFn } = deps

    const getBookmarkPosition = async (): Promise<string> => {
        const r = await pool.query<{ last_sequence_position: string }>(
            "SELECT last_sequence_position FROM _handler_bookmarks WHERE handler_id = $1",
            [{PROJECTION_NAME_CONST}]
        )
        return r.rows[0]?.last_sequence_position?.toString() ?? "0"
    }

    return router => {
        if (waitFn) {
            router.get("/{read-model}/:{key}", preferWait({ waitFn }))
        }

        router.get(
            "/{read-model}/:{key}",
            on(async req => {
                const id = req.params["id"] as string
                const result = await pool.query<{ data: {SliceName}Doc }>(
                    "SELECT data FROM {collectionName} WHERE _id = $1",
                    [id]
                )
                if (result.rows.length === 0) {
                    return res =>
                        res.status(404).json({ status: 404, title: "Not Found", detail: "{Entity} not found" })
                }
                const doc = result.rows[0].data
                const bookmarkPosition = await getBookmarkPosition()
                return res => {
                    withETag(bookmarkPosition)(res)
                    OK({
                        body: {
                            id: doc.{entityId},
                            // ... map from doc fields per slice.json readModel
                        }
                    })(res)
                }
            })
        )
    }
}
```

#### Paginated list variant

```typescript
import { on, OK, withETag, preferWait, parsePageParams, type WebApiSetup, type WaitFunction } from "@dcb-es/event-store-express"

// Inside the route:
router.get(
    "/{resources}",
    on(async req => {
        const { limit } = parsePageParams(req)
        const cursor = typeof req.query["cursor"] === "string" ? req.query["cursor"] : undefined

        let result: { rows: { _id: string; data: {SliceName}Doc }[] }
        if (cursor) {
            result = await pool.query<{ _id: string; data: {SliceName}Doc }>(
                "SELECT _id, data FROM {collectionName} WHERE _id > $1 ORDER BY _id LIMIT $2",
                [cursor, limit]
            )
        } else {
            result = await pool.query<{ _id: string; data: {SliceName}Doc }>(
                "SELECT _id, data FROM {collectionName} ORDER BY _id LIMIT $1",
                [limit]
            )
        }

        const items = result.rows.map(row => ({ id: row.data.{entityId}, /* ... */ }))
        const nextCursor = result.rows.length === limit ? result.rows[result.rows.length - 1]._id : undefined
        const body: { data: typeof items; cursor?: string } = { data: items, ...(nextCursor && { cursor: nextCursor }) }

        const bookmarkPosition = await getBookmarkPosition()
        return res => {
            withETag(bookmarkPosition)(res)
            OK({ body })(res)
        }
    })
)
```

---

### P4 — `route.tests.ts` (async)

File: `src/contexts/{context}/slices/{slicename}/route.tests.ts`

Integration tests using real Postgres (testcontainers via `getTestPgDatabasePool`).

The setup (pool, projection init, consumer, reset) lives at **module level**, and the scenarios sit in a
`describe` named after the slice title. That layout is what lets a later extension slice append its own
`describe("{extension title}")` block that reuses the same setup without touching it (see "Extending a
read model", E4). The reset calls the projection's own `truncate()` instead of deleting from
named collections, so lookup collections an extension adds later are cleared without editing this file.

Assert the response with **`toMatchObject`**, never an exact-shape `toEqual`. The read model grows as later
extension slices add fields. An exact-shape assertion would then fail even though its scenario still holds,
and fixing it would mean editing an earlier slice's test.

```typescript
import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest"
import supertest from "supertest"
import type { Pool } from "pg"
import { getApplication } from "@dcb-es/event-store-express"
import {
    PostgresEventStore,
    createConsumer,
    projectionToProcessor,
    ensureHandlersInstalled,
    waitUntilProcessed,
    type RunningConsumer
} from "@dcb-es/event-store-postgres"
import { SequencePosition } from "@dcb-es/event-store"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { configure{WriteSlice}Route } from "../{write-slice}/route.js"
import { configure{SliceName}Route } from "./route.js"
import { {sliceName}Projection, {PROJECTION_NAME_CONST} } from "./projection.js"

let pool: Pool
let eventStore: PostgresEventStore
let consumer: RunningConsumer

function startConsumer(store: PostgresEventStore): RunningConsumer {
    return createConsumer({
        pool,
        eventStore: store,
        processors: [projectionToProcessor({sliceName}Projection, { batchSize: 100, startFrom: "BEGINNING" })]
    })
}

const waitFn = (position: SequencePosition, timeoutMs: number) =>
    waitUntilProcessed(pool, {PROJECTION_NAME_CONST}, position, { timeoutMs })

beforeAll(async () => {
    pool = await getTestPgDatabasePool({ max: 20 })
    eventStore = new PostgresEventStore({ pool })
    await eventStore.ensureInstalled()

    const initClient = await pool.connect()
    try {
        await {sliceName}Projection.init!(initClient)
    } finally {
        initClient.release()
    }

    await ensureHandlersInstalled(pool, [{PROJECTION_NAME_CONST}], "_handler_bookmarks")
    consumer = startConsumer(eventStore)
})

afterEach(async () => {
    await consumer.stop()
    await pool.query("TRUNCATE TABLE events")
    await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
    // The projection's own truncate() clears every collection it owns — including lookup
    // collections later extension slices add — so this reset never needs editing.
    const client = await pool.connect()
    try {
        await {sliceName}Projection.truncate!(client)
    } finally {
        client.release()
    }
    await pool.query("UPDATE _handler_bookmarks SET last_sequence_position = 0, version = 1, instance_id = NULL")
    eventStore = new PostgresEventStore({ pool })
    consumer = startConsumer(eventStore)
})

afterAll(async () => {
    await consumer.stop()
    if (pool) await pool.end()
})

describe("{slice title}", () => {
    test("{specification title}", async () => {
        const deps = { store: eventStore, pool }
        const agent = supertest(
            getApplication({ apis: [configure{WriteSlice}Route(deps), configure{SliceName}Route({ ...deps, waitFn })] })
        )

        // Perform write
        const postRes = await agent.post("/{command}").send({ /* command body */ })
        expect(postRes.status).toBe(204)

        // Read with Prefer: wait
        const getRes = await agent
            .get("/{read-model}/test-id")
            .set("Prefer", "wait=5")
            .set("If-None-Match", postRes.headers["etag"] as string)
        expect(getRes.status).toBe(200)
        expect(getRes.body).toMatchObject({ /* the read model fields this specification asserts */ })
    })
})
```

Add one `test(...)` block per specification in slice.json.

#### Storyline-derived tests (optional)

If `storylines[]` is present, scan for adjacent READMODEL beats with only EVENT beats between them — no COMMAND beats. Each such pair is one read-model chain test:
- `given` — cumulative events up to and including the intervening event beats
- `then` — assert the read model matches the later READMODEL beat's fields

Put these in a separate `describe` block named after the storyline.


### Inline changes (`readModelType: "inline-projected"`)

An inline imperative projection is the same `Projection` object, run by the event store inside the append
transaction instead of by a consumer.

#### Inline: `projection.ts` rules

Write it exactly as P1. Because `handle()` now runs inside every append of the events in
`canHandle`, while that append holds its consistency locks:

- Keep `handle()` small and fast: Pongo reads and writes on this projection's own collections only.
- No external calls (HTTP, queues, other services) and no reads of other projections' collections.
- **A throw fails the command.** It rolls back the append, so the client gets an error and nothing is
  recorded. Handle a missing document (`findOne` returning null, `updateOne` matching nothing)
  quietly, as the patterns in P1 already do. Never throw for a business rule; rules belong
  in the command's decider.


#### Inline: `route.ts` has no waiting and no bookmark (replaces P3's plumbing)

The read model is already current when any command returns, so drop `preferWait`, `waitFn`,
`getBookmarkPosition` and `withETag`. The query and the response mapping stay as in P3, and so does
`schema.ts`, with `wait: false` in its `registerRead`:

```typescript
import { on, OK, type WebApiSetup } from "@dcb-es/event-store-express"
import type { SliceDependencies } from "../../../../shared/dependencies.js"
import type { {SliceName}Doc } from "./projection.js"
import "./schema.js"

// Inline read model: updated inside the append transaction, so it is current the moment a
// command returns. No Prefer: wait, no bookmark ETag.
export function configure{SliceName}Route(deps: SliceDependencies): WebApiSetup {
    const { pool } = deps

    return router => {
        router.get(
            "/{read-model}/:{key}",
            on(async req => {
                const id = req.params["id"] as string
                const result = await pool.query<{ data: {SliceName}Doc }>(
                    "SELECT data FROM {collectionName} WHERE _id = $1",
                    [id]
                )
                if (result.rows.length === 0) {
                    return res =>
                        res.status(404).json({ status: 404, title: "Not Found", detail: "{Entity} not found" })
                }
                const doc = result.rows[0].data
                return OK({
                    body: {
                        id: doc.{entityId},
                        // ... map from doc fields per slice.json readModel
                    }
                })
            })
        )
    }
}
```


#### Inline: `route.tests.ts` reads straight after the write (replaces P4's setup)

The store is built with the projection inline, and there is no consumer. Each test reads
**immediately** after the write, with no `Prefer: wait` header; that read is the proof the read
model is inline. Keep the module-level layout, the `describe("{slice title}")` block, one `test` per
specification and `toMatchObject`, exactly as P4 requires.

```typescript
import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest"
import supertest from "supertest"
import type { Pool } from "pg"
import { getApplication } from "@dcb-es/event-store-express"
import { PostgresEventStore } from "@dcb-es/event-store-postgres"
import { getTestPgDatabasePool } from "@test/testPgDbPool"
import { configure{WriteSlice}Route } from "../{write-slice}/route.js"
import { configure{SliceName}Route } from "./route.js"
import { {sliceName}Projection } from "./projection.js"

let pool: Pool
let eventStore: PostgresEventStore

beforeAll(async () => {
    pool = await getTestPgDatabasePool({ max: 20 })
    // Inline: the store runs the projection inside every append. ensureInstalled() registers and inits it.
    eventStore = new PostgresEventStore({ pool, inlineProjections: [{sliceName}Projection] })
    await eventStore.ensureInstalled()
})

afterEach(async () => {
    await pool.query("TRUNCATE TABLE events")
    await pool.query("ALTER SEQUENCE events_sequence_position_seq RESTART WITH 1")
    const client = await pool.connect()
    try {
        await {sliceName}Projection.truncate!(client)
    } finally {
        client.release()
    }
})

afterAll(async () => {
    if (pool) await pool.end()
})

describe("{slice title}", () => {
    test("{specification title}", async () => {
        const deps = { store: eventStore, pool }
        const agent = supertest(
            getApplication({ apis: [configure{WriteSlice}Route(deps), configure{SliceName}Route(deps)] })
        )

        const postRes = await agent.post("/{command}").send({ /* command body */ })
        expect(postRes.status).toBe(204)

        // No Prefer: wait — the append that returned 201 already updated the read model.
        const getRes = await agent.get("/{read-model}/test-id")
        expect(getRes.status).toBe(200)
        expect(getRes.body).toMatchObject({ /* the read model fields this specification asserts */ })
    })
})
```


---

## Extending a read model (extension slices)

Use this section only when slice.json has an `extends` block (see Step 0).

```jsonc
"extends": {
  "originElementId":    "…",                 // the origin read model
  "originSliceId":      "…",
  "originSliceTitle":   "course details",    // → origin folder: src/contexts/{originContext}/slices/course-details/
  "originContext":      "enrollment",
  "previousInstanceId": "…",                 // origin, or the previous copy in the chain
  "addedEvents":        ["courseCapacityWasChanged"],
  "addedFields":        []                   // fields the read model gains in this step
}
```

`events[]` lists **only** the added events, with their fields. `readmodels[0].fields` is the read model's full,
cumulative shape. `specifications[]` covers the behaviour this step adds. A copy has its origin's type (emcli
exports the origin's type for every copy), so the type never changes in an extension.

**Origin folder:** `src/contexts/{originContext}/slices/{origin slice folder}/`. The folder name is the origin
slice title, kebab-cased the same way the origin was built. It holds `readModel.ts` (fold form) or
`projection.ts` (imperative form). If neither exists, stop and report that the origin slice hasn't been built yet.

### E1 — Guard against double-building

If **any** event in `extends.addedEvents` is already in the origin's `canHandle` (or a lookup's `canHandle`),
stop and report that this extension is already built. Do not edit anything.

### E2 — Extend the definition (additive only)

**Fold form** (`readModel.ts`):
- Append each added event to the end of `canHandle`, and add a `case` for it at the end of `evolve`'s `switch`,
  before the final `return doc`.
- If an added event needs data from another entity, apply Step 2's requirement 3. Either extend an existing
  lookup (append the related event to its `canHandle` and handle it in its `evolve`), or append a new lookup
  entry. The events feeding a lookup must be in `extends.addedEvents` (the modeler wires them into the copy).
  If they aren't, don't invent them: stop and report the missing inbound event.
- Each field in `extends.addedFields` becomes an **optional** field of the Doc interface, and an `.optional()`
  field at the end of the origin's `schema.ts` object (Step 4), so `/openapi.json` shows it.
- If the origin is `live-report`, re-check Step 2 for the added events. They need the key tag, or a lookup's
  tag. If one fails, invoke `request-feedback`.

**Imperative form** (`projection.ts`):
- Append each added event to the end of `canHandle`, with one `case` per added event at the end of the
  `switch`, using the Pongo operation patterns from P1.
- A case that updates a document must tolerate one written before this step. Use `$push`/`$set` on the field,
  or `?? []` when reading an array that may be absent.
- A lookup the step needs gets a `createCollection()` line in `init()` and a `deleteMany()` line in
  `truncate()`, named as in P1.
- Fields in `extends.addedFields` become optional in the Doc interface, and `.optional()` fields at the end of
  the response schema in the origin's `schema.ts` (P3).

**Queries:** if the extension's specifications run queries the origin doesn't declare yet (Step 0), add them to
the origin's `readModel.ts` as in "Adding queries" A3–A4, in the same commit.

Both forms:
- If this step derives a **new field from an event the read model already handled**, increment `version`
  (add `version: 2` if absent). That forces a rebuild on the next start.
- **Never** edit, reorder or delete an existing `case`, field, lookup or `canHandle` entry. The commit check
  rejects any removed line in the origin's `readModel.ts` / `projection.ts`, other than a line re-added with a
  trailing comma so something can be appended after it.

### E3 — The route

- **Fold form:** nothing to do. `readModelRoute` returns the whole document, new fields included. Give a new
  field its default in `evolve` (`doc.subscribedStudents ?? []`), so documents from before this step show it
  too.
- **Imperative form:** map each added field into the response body, with a default for documents written
  before this step (`subscribedStudents: doc.subscribedStudents ?? []`).

### E4 — Extend `route.tests.ts`

Append a new top-level block to the origin's `route.tests.ts`, with one `test(...)` per specification in this
extension slice:

- **Fold form:** `describe.each(READ_MODEL_TYPES)("{extension slice title} (%s)", type => { … })`, with its
  own `readModelTestApp`. Its `routes` include every write route the new scenarios use. Specifications whose
  *when* runs a query go in `describe.each(queryTypes(…))("{extension slice title}: {queryName} (%s)", …)`
  blocks instead (Step 6b).
- **Imperative form:** `describe("{extension slice title}", () => { … })`, reusing the module-level setup, as
  in P4. If the origin's file predates the module-level layout (setup inside one `describe`), stop and report
  it: the origin needs its test setup lifted first, as a separate commit.

Existing tests stay untouched and must still pass: they are the proof the extension is additive.

### E5 — Replay is automatic

Do nothing by hand. `ensureProjectionsCurrent` (called by `startReadModels`) fingerprints each stored read
model's `version` + `canHandle`. On the next start it rebuilds any whose fingerprint changed (truncate → replay
from the beginning) before the app takes requests. So events of a newly handled type recorded before this
deploy are projected rather than skipped. A live read model has nothing to rebuild: its next read folds the new
events.

### E6 — No new wiring

The origin is already registered in `src/index.ts`. Change `index.ts` only if E4's tests revealed a missing
route registration.

### Files touched by an extension slice

```
src/contexts/{originContext}/slices/{originFolder}/
├── readModel.ts        ← (fold form) appended: canHandle entries, evolve cases, lookups, optional Doc fields
│   or projection.ts    ← (imperative) appended: canHandle entries, cases, lookup init/truncate lines
├── schema.ts           ← appended: an .optional() field per added field
├── route.ts            ← imperative form only: added fields mapped (with defaults)
└── route.tests.ts      ← appended: a block for the extension's specifications
```

These are the only files outside the slice's own folder that a commit may touch, and only when slice.json
has `extends`.

---

## Adding queries (`addQueries`)

Use this section only when slice.json has `addQueries`. The slice was built before, and its specifications now
run queries the read model doesn't serve yet: the modeler added a query to the read model element and a
specification that uses it. A query reads the documents the read model already has, so this is **additive**.
The documents don't change and nothing is rebuilt. The runtime creates the query's indexes on the next start.

### A1 — Find the definition

The query goes on the origin read model's definition. If slice.json has `extends`, that is the origin folder
(see "Extending a read model"). Otherwise it's this slice's own folder.
- `readModel.ts` present → continue.
- Only `projection.ts` → stop and invoke `request-feedback`: "{SliceName} is an imperative projection. Queries
  need the `readModel.ts` fold form. Converting it is a refactor that needs its own reviewed commit first."

### A2 — Guard against double-building

If a name in `addQueries` is already a key in the definition's `queries`, stop and report that this query is
already built. Do not edit anything.

### A3 — Check live

If the definition's `type` is `live-report`, apply Step 2's requirement 4 to each added query. If one fails,
invoke `request-feedback` naming it, and change nothing.

### A4 — Declare the queries (additive only)

In `readModel.ts`, declare each name in `addQueries` as Step 3b describes, from its `readmodels[0].queries`
entry:
- **No `queries` property yet:** insert the whole `queries: { … },` block on the lines just **before
  `evolve:`**, which is a pure insertion.
- **`queries` exists:** append the new entries at the end of it. The previous last entry's closing `}` is
  re-added as `},`.
- Never touch `canHandle`, `lookups`, `evolve`, `version`, the Doc interface or an existing query. The
  documents don't change, so nothing else may either.

`route.ts` and `src/index.ts` stay as they are. `readModelRoute` serves every declared query. The
`query-additive` commit check enforces this and A5.

### A5 — The tests

In the route.tests.ts next to the definition, append one `describe.each(queryTypes(…))` block per added query
(Step 6b), with one `test` per specification in **this** slice whose *when* runs it. Add `queryTypes` to the
file's `readModels.js` import if it isn't there. The existing tests stay untouched and must still pass.

### A6 — Prove it and commit

Run the slice's tests, then commit as `feat: {slice title} query {names}` and set the slice to `Done`.

---

## Changing a read model's type (retype)

Use this section only when slice.json has a `retype` block, e.g. `{ "from": "inline-projected", "to": "live-report" }`.
The model switched an already-built read model to another type. Clients must not notice: the contract tests
already run every scenario against every type, so the switch is one line.

### R1 — Find the definition

It is in this slice's own folder (a retype is always on the origin read model).
- `readModel.ts` present → fold form: continue.
- Only `projection.ts` → imperative form, which can't switch in one line. Stop and invoke `request-feedback`:
  "{SliceName} is an imperative projection. Converting it to a `readModel.ts` fold is a refactor that needs its
  own reviewed commit before its type can change."

### R2 — Check the target type

If `to` is `live-report`, re-check Step 2's requirements for **every** event in the definition's `canHandle`
and its lookups (read `Events.ts`), and requirement 4 for every query in its `queries`. If one fails, invoke
`request-feedback` naming it, and change nothing.

### R3 — Change the `type:` line

In `readModel.ts`, change `type: "{from}"` to `type: "{to}"`. **Nothing else:** no test edits, no route
edits, no `index.ts` edits. The `retype-scope` commit check enforces this.

### R4 — Prove it and commit

Run the slice's tests. They already cover every type, and must pass unchanged. Commit as
`refactor: {slice title} → {to}`, then set the slice to `Done`.

On the next start, `ensureProjectionsCurrent` rebuilds the stored copy when switching into a stored type
(async ↔ inline, or live → stored). Switching to live needs nothing.

---

## Files to create / modify

```
src/contexts/{context}/slices/{slicename}/
├── readModel.ts        ← fold form: defineReadModel (or projection.ts, imperative form)
├── schema.ts           ← the document's Zod schema (imperative form: plus registerRead)
├── route.ts            ← readModelRoute with that schema (imperative form: the P3 handler)
└── route.tests.ts      ← contract tests, describe.each over READ_MODEL_TYPES (imperative: P4)

src/
└── index.ts            ← add it to readModels (imperative: imperative) and its route to apis
```

Queries add no files: they're declared in `readModel.ts`, served and documented in `/openapi.json` by
`readModelRoute`, and tested in `route.tests.ts`.

---

## Checklist

**Fold form (new read model):**

- [ ] Step 2's requirements checked against `Events.ts` (key tag on every event, lookups reachable by tags, keyed GET)
- [ ] `readModel.ts`: `type` from slice.json, `key` = the idAttribute field, `canHandle` = slice.json `events[]` (one per line), lookups only for data from another entity
- [ ] `evolve` is pure, returns new objects, tolerates a missing document, and ends with `return doc`
- [ ] Every field in `readModel.fields` is produced by `evolve`, and there are no invented fields
- [ ] `schema.ts` has the document's Zod schema, one entry per Doc field (optional ones too)
- [ ] `route.ts` is a `readModelRoute` call with the `path` from `apiEndpoint` and `schema`
- [ ] `readModels` in `src/index.ts` lists it, and its route is in `apis` (a separate wire commit)
- [ ] `route.tests.ts`: `describe.each(READ_MODEL_TYPES)`, one `test` per keyed specification, `settle()` before each GET, `toMatchObject`, nothing type-specific

**Queries (any slice whose specifications run a query the definition doesn't declare yet):**

- [ ] Only queries some specification runs are declared, each transcribed from `readmodels[0].queries` (path with `:param`, `field` = mapping, `op`, `type`, `optional`, `tag`, `sort`)
- [ ] `queries` sits before `evolve`, one parameter per line, and every `field` is one `evolve` produces
- [ ] For `live-report`: every query has a required tagged `eq`/`in`/`contains` parameter, and an event in `events[]` carries both that tag and the key tag
- [ ] No route code for queries. `route.ts` and `index.ts` are unchanged by them
- [ ] One `describe.each(queryTypes({sliceName}, "{queryName}"))("{slice title}: {queryName} (%s)")` block per query, one `test` per specification that runs it, the rows asserted in order with `toMatchObject` on `res.body.data`

**Imperative form:** as P1–P4 (and the Inline changes). It's registered in the `imperative` array, and its
`truncate()` clears every collection `init()` creates.

**Extension slices (`extends` present):**

- [ ] No new read model, route or test file created. All edits are in the origin folder.
- [ ] None of `extends.addedEvents` was already handled (E1)
- [ ] Every added event appended to `canHandle` with its own `case`, and new fields optional, in the Doc and in `schema.ts`
- [ ] No existing `case`, field, lookup or `canHandle` entry edited, reordered or removed
- [ ] `version` incremented if a new field is derived from an already-handled event
- [ ] A block for the extension's specifications appended to the origin's `route.tests.ts`, and every pre-existing test still passes unchanged

**Adding queries (`addQueries` present):**

- [ ] None of `addQueries` was already declared (A2), and the definition is fold form (A1)
- [ ] `readModel.ts` only gained query entries. `canHandle`, `lookups`, `evolve`, `version` and existing queries are untouched
- [ ] Query blocks appended to the existing `route.tests.ts`, and every pre-existing test still passes unchanged

**Retype (`retype` present):**

- [ ] Only the `type:` line of `readModel.ts` changed, and for live the Step 2 requirements hold
- [ ] The existing tests pass unchanged
