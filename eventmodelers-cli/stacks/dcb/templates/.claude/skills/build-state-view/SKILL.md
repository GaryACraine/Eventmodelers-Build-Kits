---
name: build-state-view
description: Implements a DCB state-view slice (Pongo projection, route, integration tests) from a slice.json definition
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

Two additions needed:

**1. Import and call `init()`:**
```typescript
import { {sliceName}Projection, {PROJECTION_NAME_CONST} } from "./contexts/{context}/slices/{slicename}/projection.js"

// After eventStore.ensureInstalled():
await {sliceName}Projection.init!(initClient)

// In ensureHandlersInstalled():
await ensureHandlersInstalled(pool, [..., {PROJECTION_NAME_CONST}], "_handler_bookmarks")
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

Integration tests using real Postgres (testcontainers via `getTestPgDatabasePool`):

```typescript
import { describe, test, beforeAll, afterAll, afterEach } from "vitest"
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

describe("{SliceName} — Postgres integration", () => {
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
        await pool.query("DELETE FROM {collectionName}")
        await pool.query("UPDATE _handler_bookmarks SET last_sequence_position = 0, version = 1, instance_id = NULL")
        eventStore = new PostgresEventStore({ pool })
        consumer = startConsumer(eventStore)
    })

    afterAll(async () => {
        await consumer.stop()
        if (pool) await pool.end()
    })

    test("GET /{resource}/:id returns document after Prefer: wait", async () => {
        const waitFn = (position: SequencePosition, timeoutMs: number) =>
            waitUntilProcessed(pool, {PROJECTION_NAME_CONST}, position, { timeoutMs })

        const deps = { store: eventStore, pool }
        const app = getApplication({
            apis: [
                configure{WriteSlice}Route(deps),
                configure{SliceName}Route({ ...deps, waitFn })
            ]
        })

        const agent = supertest(app)

        // Perform write
        const postRes = await agent.post("/{resource}").send({ /* command body */ })
        expect(postRes.status).toBe(201)
        const etag = postRes.headers["etag"] as string

        // Read with Prefer: wait
        const getRes = await agent.get("/{resource}/test-id").set("Prefer", "wait=5").set("If-None-Match", etag)
        expect(getRes.status).toBe(200)
        expect(getRes.body).toMatchObject({ id: "test-id" /* expected fields */ })
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
- [ ] `afterEach` resets events table, projection collection, and bookmark
- [ ] One `test(...)` block per specification in slice.json
- [ ] Every field in `readModel.fields` appears in the doc interface and the route response body
- [ ] No invented fields — if it's not in slice.json it's not in the code
