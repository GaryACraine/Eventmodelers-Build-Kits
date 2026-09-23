---
name: build-state-view
description: Implements a DCB state-view slice (Pongo projection — async or inline — route, integration tests) from a slice.json definition
---

# Build State View Slice (DCB)

> Before doing anything else, read the slice definition from `.build-kit/.slices/{Context}/{slicename}/slice.json`. This file is the **source of truth** for all fields, events, and read model shape. Never invent fields not defined there.

---

## What a State View Slice is

A DCB state-view slice is a **read model projection**. It listens to events from the event store and materialises them into a queryable Pongo (JSONB/MongoDB-compatible) collection. It does not emit events or process commands.

Key DCB differences from SQL-based projection stacks:
- **No migration files** — Pongo's `init()` creates JSONB collections automatically
- **No Knex** — Pongo uses `insertOne`/`updateOne`/`findOne`/`deleteMany`
- **No Flyway** — schema is managed by `eventStore.ensureInstalled()` + `projection.init()`
- Read-your-writes via per-projection `waitFn` + `preferWait` middleware
- Bookmark positions from `_handler_bookmarks` table for ETags

The paragraph above describes the default, **async** projection: a consumer follows the event store
and the read model is eventually consistent. A read model can instead be **inline**: the same
projection runs inside the append transaction, so the read model is current the moment the command
returns. Step 0 decides which one this slice builds.

> **Cross-slice events**: A projection typically consumes events from multiple write slices (e.g. a
> student-details view handles `studentWasRegistered`, `studentWasSubscribed`, and course events —
> each produced by a different write slice). This works because the DCB event store is a single
> ordered log; projections see all events regardless of origin. The `events[]` array in slice.json
> already lists every event the projection needs, including cross-slice references.

---

## Step 0 — Which read model type, greenfield or extension?

Read the slice.json first.

**Read model type** — `readmodels[0].readModelType`:

| Value | Build |
|---|---|
| absent, or `"database-projected"` | **async** projection: Steps 1–5 as written |
| `"inline-projected"` | **inline** projection: Steps 1–5, with the changes in **"Inline variant"** below |
| `"live-report"` | not supported yet. Stop and invoke `request-feedback` ("live read models aren't supported by the DCB kit yet"). Do **not** build an async or inline projection in its place |

The model chose inline because a stale read isn't acceptable here, and chose async everywhere else
because inline slows every append of the events it handles. Build exactly the type slice.json names;
never switch one for the other.

**Greenfield or extension** — look for a top-level `extends` block.

- **No `extends`** → a new read model. Follow Steps 1–5 below as written.
- **`extends` present** → an **extension slice**. Its read model is a copy (`readmodels[0].linkedTo`)
  of a read model an earlier slice already built. Do **not** create a new projection, collection,
  route or test file. Follow **"Extending an existing projection"** below instead, then return here
  for the Checklist.

Read models grow one event at a time as the timeline is discovered. Each copy of a read model on the
board is its own slice, so each growth step is its own unit of delivery. The code stays in one place,
the origin's `projection.ts`, so one read model stays one file you can read top to bottom.

---

## Step 1 — Read the slice.json

From the slice definition, extract:
- **sliceName** — the projection name
- **context** — bounded context
- **events[]** — events this projection handles (`canHandle` list)
- **readModel.fields** — the shape of the output document
- **storylines[]** (optional) — board walkthroughs; see "Storyline-derived tests" under Step 5

> **Comments & description**: Use these as implementation hints. Resolve used comments via the board API when done.

---

## Step 2 — Create `projection.ts`

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

### Pongo operation patterns

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

## Step 3 — Register projection in `src/index.ts`

> This step wires an **async** projection. For an inline one, follow **I2** instead.

Two additions needed:

**1. Import and call `init()`:**
```typescript
import { {sliceName}Projection, {PROJECTION_NAME_CONST} } from "./contexts/{context}/slices/{slicename}/projection.js"

// After eventStore.ensureInstalled():
await {sliceName}Projection.init!(initClient)

// In ensureHandlersInstalled():
await ensureHandlersInstalled(pool, [..., {PROJECTION_NAME_CONST}], "_handler_bookmarks")

// In ensureProjectionsCurrent() — rebuilds a projection whose canHandle/version changed since last start:
await ensureProjectionsCurrent(pool, eventStore, [..., {sliceName}Projection], { inline: inlineProjections })
```

**2. Add to consumer processors:**
```typescript
projectionToProcessor({sliceName}Projection, { batchSize: 100, startFrom: "BEGINNING" })
```

**3. Create a waitFn and pass it to the route:**
```typescript
const {sliceName}WaitFn = (position: SequencePosition, timeoutMs: number) =>
    waitUntilProcessed(pool, {PROJECTION_NAME_CONST}, position, { timeoutMs })

// In apis array:
configure{SliceName}Route({ ...deps, waitFn: {sliceName}WaitFn }),
```

---

## Step 4 — Create `route.ts`

File: `src/contexts/{context}/slices/{slicename}/route.ts`

```typescript
import { on, OK, withETag, preferWait, type WebApiSetup, type WaitFunction } from "@dcb-es/event-store-express"
import type { SliceDependencies } from "../../../../shared/dependencies.js"
import { {PROJECTION_NAME_CONST} } from "./projection.js"
import type { {SliceName}Doc } from "./projection.js"

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
            router.get("/{resource}/:id", preferWait({ waitFn }))
        }

        router.get(
            "/{resource}/:id",
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

### Paginated list variant:

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

## Step 5 — Create `route.tests.ts`

File: `src/contexts/{context}/slices/{slicename}/route.tests.ts`

Integration tests using real Postgres (testcontainers via `getTestPgDatabasePool`).

The setup (pool, projection init, consumer, reset) lives at **module level**, and the scenarios sit in a
`describe` named after the slice title. That layout is what lets a later extension slice append its own
`describe("{extension title}")` block that reuses the same setup without touching it (see "Extending an
existing projection", E4). The reset calls the projection's own `truncate()` instead of deleting from
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
        const postRes = await agent.post("/{resource}").send({ /* command body */ })
        expect(postRes.status).toBe(201)

        // Read with Prefer: wait
        const getRes = await agent
            .get("/{resource}/test-id")
            .set("Prefer", "wait=5")
            .set("If-None-Match", postRes.headers["etag"] as string)
        expect(getRes.status).toBe(200)
        expect(getRes.body).toMatchObject({ /* the read model fields this specification asserts */ })
    })
})
```

Add one `test(...)` block per specification in slice.json.

### Storyline-derived tests (optional)

If `storylines[]` is present, scan for adjacent READMODEL beats with only EVENT beats between them — no COMMAND beats. Each such pair is one read-model chain test:
- `given` — cumulative events up to and including the intervening event beats
- `then` — assert the read model matches the later READMODEL beat's fields

Put these in a separate `describe` block named after the storyline.

---

## Inline variant (`readModelType: "inline-projected"`)

An inline projection is the same `Projection` object, run by the event store inside the append
transaction instead of by a consumer. Only these parts differ from Steps 2–5.

### I1 — `projection.ts`: same code, stricter rules

Write it exactly as Step 2. Because `handle()` now runs inside every append of the events in
`canHandle`, while that append holds its consistency locks:

- Keep `handle()` small and fast: Pongo reads and writes on this projection's own collections only.
- No external calls (HTTP, queues, other services) and no reads of other projections' collections.
- **A throw fails the command.** It rolls back the append, so the client gets an error and nothing is
  recorded. Handle a missing document (`findOne` returning null, `updateOne` matching nothing)
  quietly, as the async patterns in Step 2 already do. Never throw for a business rule; rules belong
  in the command's decider.

### I2 — Register it in `src/index.ts` (replaces Step 3)

Add it to the `inlineProjections` array that is passed to the one `PostgresEventStore`:

```typescript
import { {sliceName}Projection } from "./contexts/{context}/slices/{slicename}/projection.js"

const inlineProjections: Projection[] = [..., {sliceName}Projection]

const eventStore = new PostgresEventStore({ pool, inlineProjections })
```

That's all: `eventStore.ensureInstalled()` registers and inits it, and
`ensureProjectionsCurrent(pool, eventStore, projections, { inline: inlineProjections })` backfills it
from the existing history on its first start and rebuilds it when its fingerprint changes. Do **not**
add it to the async `projections` array, `ensureHandlersInstalled`, the consumer, or a `waitFor`.
The route gets `deps` without a `waitFn`.

### I3 — `route.ts`: no waiting, no bookmark (replaces the Step 4 plumbing)

The read model is already current when any command returns, so drop `preferWait`, `waitFn`,
`getBookmarkPosition` and `withETag`. The query and the response mapping stay as in Step 4:

```typescript
import { on, OK, type WebApiSetup } from "@dcb-es/event-store-express"
import type { SliceDependencies } from "../../../../shared/dependencies.js"
import type { {SliceName}Doc } from "./projection.js"

// Inline read model: updated inside the append transaction, so it is current the moment a
// command returns. No Prefer: wait, no bookmark ETag.
export function configure{SliceName}Route(deps: SliceDependencies): WebApiSetup {
    const { pool } = deps

    return router => {
        router.get(
            "/{resource}/:id",
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

### I4 — `route.tests.ts`: read straight after the write (replaces the Step 5 setup)

The store is built with the projection inline, and there is no consumer. Each test reads
**immediately** after the write, with no `Prefer: wait` header; that read is the proof the read
model is inline. Keep the module-level layout, the `describe("{slice title}")` block, one `test` per
specification and `toMatchObject`, exactly as Step 5 requires.

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

        const postRes = await agent.post("/{resource}").send({ /* command body */ })
        expect(postRes.status).toBe(201)

        // No Prefer: wait — the append that returned 201 already updated the read model.
        const getRes = await agent.get("/{resource}/test-id")
        expect(getRes.status).toBe(200)
        expect(getRes.body).toMatchObject({ /* the read model fields this specification asserts */ })
    })
})
```

### Extensions of an inline read model

A copy of an inline read model is inline too (emcli exports the origin's type for every copy), so
an extension slice of it follows "Extending an existing projection" unchanged. The origin's
`route.tests.ts` already has the inline setup, so the appended `describe` block reads straight after
writing, like the origin's tests. E5 holds for inline projections too: `ensureProjectionsCurrent`
rebuilds an inline projection whose fingerprint changed, before the app takes requests.

---

## Extending an existing projection (extension slices)

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

`events[]` lists **only** the added events, with their fields. `readmodels[0].fields` is the
read model's full, cumulative shape. `specifications[]` covers the behaviour this step adds.

**Origin folder:** `src/contexts/{originContext}/slices/{origin slice folder}/`. The folder name is
the origin slice title, kebab-cased the same way the origin was built. Confirm it exists and holds
`projection.ts`. If it doesn't, stop and report: the origin slice hasn't been built yet.

### E1 — Guard against double-building

Open the origin's `projection.ts`. If **any** event in `extends.addedEvents` is already in
`canHandle`, stop and report that this extension is already built. Do not edit anything.

### E2 — Extend `projection.ts` (additive only)

- Append each added event to the end of `canHandle`.
- Add each field in `extends.addedFields` to the Doc interface. A field added after the read
  model's first version is **optional** in the interface (`subscribedStudents?: …`): documents
  written before this step don't have it.
- Add one `case` per added event at the end of the `switch`, using the Pongo operation patterns from
  Step 2. A case that updates a document must tolerate one written before this step. Use
  `$push`/`$set` on the field, or `?? []` when reading an array that may be absent.
- If an added event needs data from another entity (denormalisation, e.g. a student's name on
  `studentWasSubscribed`), feed a lookup collection from that entity's event. Add a
  `createCollection()` line to `init()` and a `deleteMany()` line to `truncate()`, following the lookup
  naming in Step 2. The feeding event must itself be in `extends.addedEvents` (the modeler wires it
  into the copy). If it isn't, don't invent it: stop and report the missing inbound event.
- If this step derives a **new field from an event the projection already handled**, increment the
  projection's `version` (add `version: 2` if absent). That forces a rebuild on the next start.
- **Never** edit, reorder or delete an existing `case`, field or `canHandle` entry. The commit
  check rejects any removed line in the origin's `projection.ts` other than the line a `canHandle`
  entry was appended after.

### E3 — Extend `route.ts`

Map each added field into the response body. Default it for documents written before this step
(`subscribedStudents: doc.subscribedStudents ?? []`), so the endpoint returns the full read model
shape without waiting for the rebuild.

### E4 — Extend `route.tests.ts`

Append a new top-level `describe("{extension slice title}", () => { … })` block to the origin's
`route.tests.ts`. It holds one `test(...)` per specification in this extension slice and reuses the
module-level setup (`pool`, `eventStore`, `waitFn`, reset). Assert with `toMatchObject`, as in Step 5.
If the origin's file predates the module-level layout (setup inside one `describe`), stop and report it:
the origin needs its test setup lifted first, as a separate commit. Existing tests stay untouched and must still pass: they are proof the
extension is additive. Add any write-slice route the new tests need to that block's `getApplication`
call.

### E5 — Replay is automatic

Do nothing by hand. `ensureProjectionsCurrent()` in `src/index.ts` fingerprints each projection's
`version` + `canHandle`. On the next start it rebuilds any projection whose fingerprint changed
(truncate → replay from the beginning) before consumers start. So events of a newly handled type
recorded before this deploy are projected rather than skipped behind the bookmark. Confirm the
origin projection is already in that call's array; add it if missing.

### E6 — No new wiring

The origin's projection, consumer, `waitFn` and route (or, for an inline origin, its
`inlineProjections` entry and route) are already registered in `src/index.ts`.
Change `index.ts` only if E4's tests revealed a missing route registration.

### Files touched by an extension slice

```
src/contexts/{originContext}/slices/{originFolder}/
├── projection.ts       ← appended: canHandle entries, Doc fields, cases, lookup init/truncate lines
├── route.ts            ← added fields mapped (with defaults)
└── route.tests.ts      ← appended: describe("{extension slice title}")
```

These are the only files outside the slice's own folder that a commit may touch, and only
when slice.json has `extends`.

---

## Files to create / modify

```
src/contexts/{context}/slices/{slicename}/
├── projection.ts       ← pongoProjection with canHandle, init, handle, truncate
├── route.ts            ← GET endpoint with preferWait + ETag
└── route.tests.ts      ← Postgres integration tests (testcontainers)

src/
└── index.ts            ← add projection init, consumer processor, waitFn, route
```

---

## Checklist

- [ ] `canHandle` lists every event type the projection handles — names match Events.ts exactly
- [ ] `init()` creates all required Pongo collections (including any lookup collections)
- [ ] `handle()` processes every event type listed in `canHandle`
- [ ] `truncate()` deletes from every collection `init()` creates
- [ ] Projection registered in `src/index.ts` (init, consumer, waitFn)
- [ ] Route registered in `src/index.ts` with the projection's `waitFn`
- [ ] `getBookmarkPosition()` reads from `_handler_bookmarks` using the correct `handler_id`
- [ ] `withETag(bookmarkPosition)` called on every response
- [ ] `preferWait({ waitFn })` registered before the actual GET handler when `waitFn` is present
- [ ] Integration tests use `getTestPgDatabasePool`, `ensureInstalled`, `projection.init!`, `ensureHandlersInstalled`
- [ ] Test setup is at module level, scenarios in `describe("{slice title}")`, and `afterEach` resets via `projection.truncate!()` (not per-collection deletes)
- [ ] One `test(...)` block per specification in slice.json
- [ ] Every field in `readModel.fields` appears in the doc interface and the route response body
- [ ] No invented fields — if it's not in slice.json it's not in the code
- [ ] Projection passed to `ensureProjectionsCurrent(...)` in `src/index.ts`

**Inline read models (`readModelType: "inline-projected"`) — instead of the consumer, `waitFn`, bookmark and ETag items above:**

- [ ] Projection added to `inlineProjections` in `src/index.ts`, and **not** to the async `projections` array, `ensureHandlersInstalled` or the consumer
- [ ] `handle()` touches only this projection's collections, makes no external calls, and never throws for a missing document or a business rule
- [ ] Route has no `preferWait`, `waitFn`, bookmark lookup or `withETag`
- [ ] Tests build the store with `inlineProjections: [projection]`, start no consumer, and read immediately after the write without `Prefer: wait`

**Extension slices (`extends` present) — instead of the create items above:**

- [ ] No new projection, collection, route or test file created. All edits are in the origin folder.
- [ ] None of `extends.addedEvents` was in the origin's `canHandle` before this change (E1)
- [ ] Every event in `extends.addedEvents` appended to `canHandle` with its own `case`, and every field in `extends.addedFields` in the Doc interface (optional) and the route body (defaulted)
- [ ] No existing `case`, field or `canHandle` entry edited, reordered or removed
- [ ] New lookup collections are in both `init()` and `truncate()`
- [ ] `version` incremented if a new field is derived from an already-handled event
- [ ] A `describe("{extension slice title}")` block with one `test(...)` per specification appended to the origin's `route.tests.ts`, and every pre-existing test still passes unchanged
