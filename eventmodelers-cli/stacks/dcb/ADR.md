# Architecture Decision Records — DCB Build Kit

This document captures the architectural decisions made in the DCB build kit's skill templates and shared infrastructure. Each record includes the alternatives not taken, so that future experimentation has a clear map of what could change.

---

### ADR-001: Pongo JSONB collections for read model projections

**Status:** Accepted
**Date:** 2026-09-22

**Context:** Read model projections need a persistence layer. The DCB library supports both Pongo (MongoDB-compatible JSONB collections over Postgres) and raw SQL projections. The build kit must choose a default for generated code.

**Decision:** Use `pongoProjection()` with MongoDB-compatible JSONB collections (`insertOne`, `updateOne`, `$push`, `findOne`). No SQL, no Knex, no migration files.

**Alternatives considered:**
- **Pongo SQL variant** — raw SQL projections with typed queries. Full relational power but requires hand-written SQL and migration management
- **Knex SQL builder** — used in the Emmett stack. Provides a fluent query builder but adds a dependency and requires migration files
- **Raw `pg` queries** — maximum control over relational tables but no abstraction, highest maintenance burden

**Consequences:** JSONB is simpler (no migrations, schema-free) and matches the document-oriented mental model of projections. However, it loses relational query power, indexing control, and SQL join performance for complex read models. Worth revisiting if projections need cross-entity joins or complex aggregations that JSONB queries handle poorly.

---

### ADR-002: Client-supplied identifiers as default

**Status:** Accepted
**Date:** 2026-09-22

**Context:** Commands that create new entities need an identity. The choice is whether the client or server generates it.

**Decision:** When a command field has `idAttribute: true` and no `generated: true`, the client supplies the ID. It appears in the Command type, Zod schema, and request body. Server-generated IDs are used only when explicitly marked `generated: true`.

**Alternatives considered:**
- **Server always generates IDs** — UUID generated server-side, returned in the response. Simpler client contract but makes creation non-idempotent without a separate idempotency mechanism
- **Hybrid** — server generates if client omits. Convenient but ambiguous ownership semantics

**Consequences:** Client-supplied IDs enable deterministic tests and idempotent creation (re-sending the same ID is a no-op via the idempotency mechanism). The trade-off is that clients must generate unique IDs and the ID format becomes part of the API contract. This pairs well with ADR-006 (idempotency via message_id).

---

### ADR-003: Tag-scoped event sourcing (no aggregate roots or stream IDs)

**Status:** Accepted
**Date:** 2026-09-22

**Context:** Event-sourced systems need a consistency boundary. Traditional approaches use aggregate roots with a fixed stream identity. The DCB library offers an alternative: tag-based scoping.

**Decision:** All consistency scoping via `Tags.fromObj({...})` on each `EventHandlerWithState`. No aggregate root, no stream key.

**Alternatives considered:**
- **Stream-per-aggregate** — the Emmett pattern. Each aggregate has a deterministic stream ID. Well-understood, supports stream-level snapshotting and subscriptions
- **Aggregate root with fixed stream identity** — DDD-style aggregates. Strong transactional boundaries but rigid scoping

**Consequences:** Tags enable dynamic, multi-dimensional scoping — a subscription event can be scoped to both student AND course simultaneously. This makes cross-entity consistency boundaries natural. The trade-off is that stream-level snapshotting and stream-based subscriptions are impossible, and the mental model is unfamiliar to developers coming from traditional event sourcing.

---

### ADR-004: MemoryEventStore for unit tests, PostgresEventStore for integration tests

**Status:** Accepted
**Date:** 2026-09-22

**Context:** Tests need to verify command handling, event emission, and projection logic. Using real Postgres for every test is slow; using only in-memory misses serialization issues.

**Decision:** Two-tier testing — fast unit tests with `ApiSpecification` + `MemoryEventStore` (no Docker), and integration tests with `PostgresEventStore` + testcontainers.

**Alternatives considered:**
- **Integration-only** — always use Postgres. Catches more issues but slow (container startup, real I/O)
- **Unit-only** — trust serialization. Fast but misses tag persistence, sequence position, and serialization bugs

**Consequences:** Unit tests are fast and deterministic, giving quick feedback during development. Integration tests catch serialization, tag persistence, and sequence position issues that only surface with real Postgres. The cost is maintaining two test configurations and ensuring both stay in sync.

---

### ADR-005: Error type to HTTP status code mapping

**Status:** Accepted
**Date:** 2026-09-22

**Context:** Command handlers throw typed errors that must be mapped to HTTP status codes. The mapping must be consistent across all slices.

**Decision:** `NotFoundError` → 404, `IllegalStateError` → 422 (business rule violation), `ValidationError` → 400 (bad input format). Zod schema failures also produce 400 via `validateBody`.

**Alternatives considered:**
- **409 Conflict for business rule violations** — semantically closer to "state conflict" but less commonly used for domain rule violations
- **problem+json detail codes** — RFC 7807 problem details with machine-readable type URIs. Richer but adds complexity to every error response

**Consequences:** 422 for both `IllegalStateError` and semantic validation means clients cannot distinguish "entity not in correct state" from "field value semantically invalid" by status code alone. If this becomes a problem, switching to problem+json with distinct type URIs would be the path forward.

---

### ADR-006: Idempotency via message_id in events table

**Status:** Accepted
**Date:** 2026-09-22

**Context:** HTTP command endpoints need idempotency to handle retries safely. The system needs somewhere to store and check idempotency keys.

**Decision:** HTTP `Idempotency-Key` header → stored as `message_id` in the events table. `findExistingPosition()` queries this before command execution. If found, returns the cached position without re-executing.

**Alternatives considered:**
- **Separate idempotency table with TTL** — independent lifecycle from events, can expire old keys. Adds infrastructure
- **Distributed lock** — prevents concurrent execution but doesn't handle completed-request replay
- **Client-side deduplication** — shifts responsibility to clients. Unreliable across client restarts

**Consequences:** Piggybacks on the events table (no extra infrastructure) and idempotency keys live as long as the events they produced. The trade-off is coupling idempotency lifetime to event retention and requiring a raw SQL query against the events table rather than going through the event store API.

---

### ADR-007: Zod + zod-to-openapi for validation and API documentation

**Status:** Accepted
**Date:** 2026-09-22

**Context:** API endpoints need both runtime validation and OpenAPI documentation. Maintaining these separately leads to drift.

**Decision:** Zod schemas with `.openapi()` extensions for both runtime validation (`validateBody`) and OpenAPI spec generation via `OpenAPIRegistry`.

**Alternatives considered:**
- **JSDoc `@openapi` blocks + swagger-jsdoc** — the Emmett pattern. Documentation lives in comments, separate from validation logic. Familiar to Express developers but can drift from actual validation
- **Separate validation and documentation layers** — e.g. Joi for validation, manual OpenAPI YAML. Maximum control but double maintenance

**Consequences:** Single source of truth for validation and docs. Schema changes automatically propagate to the OpenAPI spec. The trade-off is tying API documentation format to Zod's type system, and `.openapi()` extensions add verbosity to schema definitions.

**Update 2026-09-23 (PLAN 14.1):** the registry is no longer one central `document.ts` that imports every slice's
schema. Slices built by the loop can only touch their own folder, so each slice registers its own routes in
`src/shared/openapi.ts`: `registerCommand` / `registerRead` in its `schema.ts`, and `readModelRoute` documents a
fold-form read model (keyed GET and every query) from the document's Zod schema, typed against the Doc so tsc
catches drift. The `openapi` slice serves the result. The `openapi-registered` commit check keeps it complete,
because a frontend now generates its client from `/openapi.json`.

---

### ADR-008: Single ordered event log (no per-aggregate streams)

**Status:** Accepted
**Date:** 2026-09-22

**Context:** The DCB event store uses a single ordered event log rather than per-aggregate streams. Projections need to consume events across slices.

**Decision:** DCB uses a single ordered event log. Projections see all events regardless of origin slice. Cross-slice event consumption works because events are globally ordered.

**Alternatives considered:**
- **Per-aggregate event streams** — with cross-stream subscriptions. Better locality for single-aggregate reads but requires subscription management for cross-aggregate projections
- **Topic-based event routing** — events published to topics, consumers subscribe to relevant topics. Flexible but adds messaging infrastructure

**Consequences:** Simplifies projections (no subscription management) and makes cross-slice event consumption trivial. The trade-off is that every projection scans the full log — performance depends on tag filtering efficiency at scale. This is the foundational architectural choice that enables ADR-003 (tag-scoped consistency).

---

### ADR-009: Lookup collection naming convention for cross-entity denormalisation

**Status:** Accepted
**Date:** 2026-09-22

**Context:** Projections that denormalise data across entities (e.g. embedding course names in a student projection) need auxiliary storage. The naming and structure of this storage affects maintainability.

**Decision:** Cross-entity lookup collections named `_{projectionName}_{entityPlural}` (e.g. `_student_projection_courses`).

**Alternatives considered:**
- **Single collection with embedded documents** — everything in one document. Simpler queries but unbounded document growth and complex updates
- **Relational JOIN via SQL** — normalised tables with joins at query time. No denormalisation but loses the JSONB simplicity of ADR-001

**Consequences:** Explicit lookup collections make denormalisation visible and truncation clean (each collection can be independently rebuilt). The cost is collection proliferation and manual cross-collection consistency during projection rebuilds.

---

### ADR-010: Generated field default is GUID (crypto.randomUUID)

**Status:** Accepted
**Date:** 2026-09-22

**Context:** Fields marked `generated: true` need a default generation strategy when the event model doesn't specify one.

**Decision:** Default to `crypto.randomUUID()` unless the event model explicitly shows a specific generation pattern (e.g. sequence from an information model).

**Alternatives considered:**
- **Auto-increment sequences** — human-readable and sortable but require database coordination and are not safe across distributed instances
- **ULID/KSUID** — sortable by time, URL-safe. Better for pagination/ordering but adds a dependency
- **Snowflake IDs** — sortable, compact, distributed-safe. Complex to implement and operate

**Consequences:** UUIDs are simple, collision-free, and require no coordination. They are not sortable, not human-readable, and consume more storage than sequential integers. If sortable IDs become needed (e.g. for cursor-based pagination), ULID would be the natural upgrade path.

---

### ADR-011: Automation processors catch-and-log errors (never crash consumer)

**Status:** Accepted
**Date:** 2026-09-22

**Context:** Automation processors react to events and trigger commands. If a processor throws, the question is whether to crash the consumer (blocking all subsequent events) or continue.

**Decision:** Automation processor errors are caught and logged. Failed automations don't block the event stream or crash the consumer.

**Alternatives considered:**
- **Dead-letter queue** — failed events routed to a separate queue for manual inspection and retry. Robust but adds infrastructure
- **Retry with backoff** — automatic retries with exponential backoff. Handles transient failures but can amplify persistent ones
- **Circuit breaker** — stop processing after N failures, require manual reset. Prevents cascade but blocks all processing
- **Fail-fast** — crash the consumer, require manual intervention. Safest for data integrity but highest operational burden

**Consequences:** Prevents cascading failures and keeps the event stream flowing. The trade-off is that failed automations are silently dropped — no built-in retry or dead-letter mechanism. Worth revisiting when automation reliability requirements increase, likely starting with a dead-letter collection.

---

### ADR-012: testcontainers with single shared Postgres instance

**Status:** Accepted
**Date:** 2026-09-22

**Context:** Integration tests need a real Postgres instance. The question is how to manage the container lifecycle and test isolation.

**Decision:** One `PostgreSqlContainer("postgres:16")` started in `globalSetup`, shared across all test files. Each test creates an isolated database within that instance via `getTestPgDatabasePool()`.

**Alternatives considered:**
- **Container-per-test-file** — maximum isolation but slow (container startup per file)
- **Docker Compose managed externally** — container runs outside the test process. Simpler test code but requires external setup
- **SQLite for test isolation** — no Docker needed but different SQL dialect and behaviour from production Postgres

**Consequences:** Fast (one container startup, ~5s overhead) and isolated (separate databases per test). Requires Docker available in CI environments. The shared container means tests cannot customise Postgres configuration per-file, but this hasn't been needed.

---

### ADR-013: preferWait middleware for read-your-writes consistency

**Status:** Accepted
**Date:** 2026-09-22

**Context:** After a command writes events, the next read should see the updated projection. With async projections (ADR-014), there's a delay between event append and projection update.

**Decision:** `preferWait({ waitFn })` middleware registered BEFORE the GET handler. Uses `waitUntilProcessed()` to block until the projection catches up to the position in the `If-None-Match` header.

**Alternatives considered:**
- **Client-side polling with retry** — client retries until projection is current. Simple server but pushes complexity to every client
- **Server-sent events for projection readiness** — push notification when projection catches up. Lower latency but adds SSE infrastructure
- **Synchronous projection updates** — project inline during append. Instant consistency but see ADR-014 trade-offs

**Consequences:** Transparent to clients (just set the Prefer header) and guarantees read-your-writes consistency. The trade-off is added latency to reads (blocking until projection catches up) and coupling read availability to projection processing speed. If projection lag grows, reads will time out.

*Updated 2026-09-25 (PLAN 14.10b, dcb-event-store phase 18):* any position can be waited for, including a write the read model doesn't handle (a page refetching all its views after one write), because a processor's checkpoint moves past the events it doesn't handle. A wait that runs out is a `WaitTimeoutError`, answered 504.

---

### ADR-014: Async consumer projections over inline projections

**Status:** Accepted
**Date:** 2026-09-22

**Context:** Projections can run asynchronously (background consumer) or inline (inside the append transaction). The DCB library supports both. The build kit must choose a default for generated code.

**Decision:** The `build-state-view` skill generates async consumer-based projections: a background `createConsumer` processes events, `preferWait` middleware provides read-your-writes, and `_handler_bookmarks` tracks position.

**Alternatives not excluded:**
- **Inline projections** — projection runs inside the `append` transaction. Instant consistency (no `waitUntilProcessed`, no consumer lifecycle, no bookmark table). Trade-off: advisory locks held through projection code, reducing write concurrency on overlapping consistency boundaries. The DCB library fully supports this via `PostgresEventStore({ inlineProjections: [...] })`

**Consequences:** Async is the safer default for throughput — it decouples write latency from projection complexity. Inline may be preferable for low-write-volume slices where instant consistency outweighs concurrency concerns. Switching would require a new `build-state-view-inline` skill (or a mode flag in `slice.json`), generating `inlineProjections` wiring in `index.ts` instead of consumer setup.

---

### ADR-015: ApiSpecification over DeciderSpecification for generated tests

**Status:** Accepted
**Date:** 2026-09-22

**Context:** Generated state-change tests need a testing harness. The DCB library offers both `ApiSpecification` (tests through HTTP) and `DeciderSpecification` (tests the decider directly).

**Decision:** Generated state-change unit tests use `ApiSpecification` which tests through the HTTP layer — validating Zod schemas, route middleware, HTTP status codes, and emitted events in a single pass.

**Alternatives not excluded:**
- **`DeciderSpecification`** — tests the decider directly at the command level. Supports `.thenCondition()` to assert the append condition (consistency boundary coverage). Faster (no Express overhead), more focused, but does not exercise schema validation, routing, or HTTP response handling. Could be generated as a complementary test file alongside ApiSpecification

**Consequences:** ApiSpecification catches more integration issues (bad schema, wrong HTTP verb, missing middleware) but never verifies that the consistency boundary tags are correct — a gap that DeciderSpecification's `.thenCondition()` would fill. Adding a `decider.tests.ts` alongside the existing test file would be additive, not a replacement.

---

### ADR-016: No projection rebuild tooling generated

**Status:** Superseded by ADR-020
**Date:** 2026-09-22

**Context:** When a projection's schema changes, it needs to be rebuilt from the event log. The DCB library provides `rebuildProjection()` but the build kit doesn't generate rebuild infrastructure.

**Decision:** The build kit does not generate projection versioning or rebuild infrastructure. When a projection schema changes, the developer must manually truncate and replay, or write rebuild code by hand.

**Alternatives not excluded:**
- **Generated rebuild script** — a per-projection rebuild command that calls `rebuildProjection()` with the current projection definition. The DCB library supports the full lifecycle: deactivate → truncate → replay from beginning → reactivate
- **Projection version tracking** — generating v1/v2 projection definitions with a version constant, enabling rebuild tooling to detect when a projection needs rebuilding after a schema change

**Consequences:** Without rebuild tooling, projection schema changes in production require manual intervention. As the number of projections grows, this becomes operationally burdensome. Adding rebuild support would require a new skill step in `build-state-view` generating a `rebuild.ts` script per projection, plus a top-level `rebuild-all` command. The `rebuildProjection()` API is already available in `@dcb-es/event-store-postgres`.

---

### ADR-017: Append-only Events.ts (add, never modify or remove)

**Status:** Accepted
**Date:** 2026-09-22

**Context:** Event factories in `Events.ts` define the event shapes persisted to the store. Changes to these factories affect all historical data.

**Decision:** Event factories are append-only. New events are added; existing factories are never modified or removed.

**Alternatives considered:**
- **Versioned event schemas with upcasters** — transform old events to new shapes on read. See ADR-018 for the versioning strategy chosen
- **Event type registry with schema evolution** — centralised registry managing backwards-compatible changes. Adds infrastructure but enables controlled evolution

**Consequences:** Guarantees backward compatibility with persisted events — old events always deserialize correctly. Event shapes are frozen once deployed. Schema evolution is handled by creating new versioned types (ADR-018) rather than modifying existing ones.

---

### ADR-018: Explicit new event versions — no global upcasters

**Status:** Accepted
**Date:** 2026-09-22

**Context:** When an event's schema needs to change (field renamed, structure changed, optional → required), the system needs a strategy for handling both old and new events in the log.

**Decision:** Create explicit new versioned types (e.g. `CourseWasRegisteredV1`, `V2`, `V3`) as a union type. Set `schemaVersion` on new writes. Each consumer handles each version individually — either via a plain `switch (schemaVersion ?? "1")` or the `versionedHandler()` utility. No global upcasters transform old events before consumers see them.

**Every change to a released event's schema is a new version, breaking or not** (Gary, 2026-10-06): adding an optional field too, so an old event is never mistaken for a new one in which the optional field wasn't given. Before release (ADR-046), an event may still be changed in place.

**Alternatives considered:**
- **Global upcaster pipeline** — transforms old events into the latest shape before any consumer sees them. Simpler consumer code but introduces a global transformation layer that must be maintained, tested, and applied consistently across all read paths
- **Backwards-compatible-only changes** — never break the schema, only add optional fields. Avoids versioning entirely but constrains domain evolution (can't rename fields, can't make optional fields required, can't restructure)
- **Event type aliasing** — treat schema changes as entirely new event types (e.g. `courseWasRegisteredV2` as a separate event, not a version of the same type). Simpler per-consumer but fragments the event timeline and complicates queries that need "all course registration events"

**Consequences:** Each consumer retains full control of how it interprets historical data, at the cost of version dispatch code in every consumer that touches the changed event. The DCB library provides `versionedHandler()` to reduce this boilerplate. Worth revisiting if the number of versioned events grows large enough that consumer-level dispatch becomes a maintenance burden — at that point, a global upcaster pipeline may justify its complexity.

---

### ADR-019: Read models grow through extension slices that edit the origin projection

**Status:** Accepted
**Date:** 2026-09-22

**Context:** A read model is discovered one event at a time. `courseWasRegistered` exists first, and `courseCapacityWasChanged`, `studentWasSubscribed` and the rest turn up later on the timeline. Modeling tools draw that growth as a **copy** of the read model placed after each new event, instead of a backward arrow. On prooph board you copy the element. On eventmodelers the node gets `meta.linkedTo`. The eventmodelers modeling kit's rule gives a copy no slice, so the work of teaching the read model a new event has no slice to plan, track or build. `build-state-view` could also only create projections from scratch.

**Decision:** A READMODEL copy with inbound events its previous instance lacks is its own **extension slice**. Its slice.json carries `extends { originSliceTitle, originContext, previousInstanceId, addedEvents, addedFields }`, and emcli computes that delta at export. `build-state-view` Step 0 routes it to "Extending an existing projection". There it appends to the **origin's** `projection.ts` (new `canHandle` entries, cases, optional Doc fields, lookup init/truncate lines), maps the new fields with defaults in `route.ts`, and appends a `describe("{extension title}")` block to `route.tests.ts`. The `extension-additive` commit check keeps it honest: changes stay in the origin's folder, the projection only gains lines, and there's a test block per spec.

**Alternatives considered:**
- **Copy implies no slice; reopen and rebuild the origin slice** (the eventmodelers default). Keeps one slice per read model, but the growth step is invisible in delivery tracking, and a slice already marked Done can't be re-queued cleanly.
- **Contributor projections**: each producing slice ships its own projection writing into the origin's collection. Safe only for inline projections. With async consumers (ADR-014) each has its own bookmark, so `studentWasSubscribed` can be handled before `courseWasRegistered` created the document, and the update is silently lost.
- **Handler fragments composed under one bookmark**: each extension slice owns a `{canHandle, handle}` fragment in its own folder, and the origin composes them. Ordering is safe, but one read model's logic is spread across N folders that still depend on each other (a lookup fed by one fragment, read by another). The origin's init, truncate and replay must know every fragment anyway.

**Consequences:** One read model stays one projection file, readable top to bottom, while each growth step is its own planned, tracked, tested commit. Ownership bends in one narrow, checked way: an extension slice may edit its origin's folder. Two template rules follow and were both found in the progressive proof (`~/Projects/enrollment-progressive`):
- read-model tests keep their setup at module level and reset through `projection.truncate()`, so new lookup collections need no test edits
- scenarios assert with `toMatchObject`, because an exact-shape `toEqual` breaks as soon as the read model gains a field

The eventmodelers modeling-kit rules (`eventmodeling-core-rules`, `eventmodeling-slicing-event-models`) were changed to match.

---

### ADR-020: Automatic projection rebuild on changed canHandle or version

**Status:** Accepted
**Date:** 2026-09-22

**Context:** An async projection's consumer reads only the event types in `canHandle`, from its bookmark onward, and the bookmark advances to every *handled* event it processes. When an extension slice adds an event type, events of that type recorded before the deploy are skipped whenever a handled event was recorded after them. In the proof run, `CourseDetailsProjection`'s bookmark stood at 10 while the five student events it was about to handle sat at positions 5–9. The same applies when an extension derives a new field from an already-handled event.

**Decision:** `src/shared/ensureProjectionsCurrent.ts` stores a fingerprint per projection: `v{version}:{sorted canHandle}`. At startup, after `init()` and `ensureHandlersInstalled()` and before `createConsumer()`, it rebuilds any projection whose fingerprint changed, using `rebuildProjection()` (deactivate → truncate → replay → reactivate). A first sighting is only recorded. An extension that derives a new field from an already-handled event bumps `version`.

**Alternatives considered:**
- **Agent decides per extension whether to replay.** Error-prone. The necessity depends on the live log's interleaving, which the build agent can't see.
- **Generated per-projection rebuild script, run by hand** (ADR-016's open alternative). Correct but relies on a human remembering after every extension deploy.
- **Always rebuild on startup.** Simple, but the cost grows with the log for no benefit when nothing changed.

**Consequences:** Replay is never a manual step. Every extension deploy in the proof run rebuilt automatically, and history recorded before each extension (capacity changes, subscriptions, an unsubscribe, a rename) appeared correctly. Startup blocks while a rebuild runs, which is proportional to the log size for the rebuilt projection only. A shape change that isn't visible in `canHandle` needs the `version` bump, which the skill's E2 step and checklist cover.

---

### ADR-021: Inline projections for read models that must be immediately consistent

**Status:** Accepted
**Date:** 2026-09-23

**Context:** Every DCB read model so far is an async projection (ADR-014): a consumer follows the event store,
and a reader who needs their own write waits for it (`Prefer: wait`). Some business users won't accept a stale
read in particular places, for example seeing a free seat that was just taken. dcb-event-store can run a
projection **inline**, inside the append transaction (`new PostgresEventStore({ inlineProjections })`), so its
read model commits atomically with the events. The model says which read models need this:
emcli's `readModelType: "inline-projected"`, exported into slice.json and inherited by every copy.

**Decision:** `build-state-view` builds both types from the same `projection.ts`, and Step 0 picks the variant
from `readModelType`. An inline read model:
- is listed in `src/index.ts`'s `inlineProjections`, with no consumer, bookmark or `waitFn`;
- is served by a route without `preferWait` or a bookmark ETag;
- is tested by reading straight after the write.

`ensureProjectionsCurrent` takes the inline projections too. It keeps ADR-020's fingerprint rebuild for them,
prefixing their fingerprint with `inline:`, and it also **rebuilds an inline projection the first time it sees
it**, because nothing else would project the history recorded before it was deployed. It installs their
bookmark rows first, since `rebuildProjection()` replays through a temporary consumer. `live-report` read
models are blocked with a question until the kit supports them (PLAN 11.7).

**Alternatives considered:**
- **A separate `build-state-view-inline` skill.** Rejected: the projection code and the extension steps (E1–E6)
  are identical, and two copies would drift. Only the wiring, route and tests differ.
- **Make every read model inline.** Rejected: every append of a handled event waits for every inline projection
  on it, holding its consistency locks (dcb-event-store Invariant 6), so write throughput falls with each one.
- **Keep async and make readers wait longer.** That doesn't give a guarantee. `Prefer: wait` only helps a client
  that holds the ETag of its own write, and another client's read can still be stale.

**Consequences:**
- Inline read models are consistent the moment a command returns, with no read-your-writes plumbing.
- They cost write latency, so the model should use them sparingly. emcli's export warns when one event feeds
  three or more of them.
- **A bug in an inline projection fails the command.** A throw rolls back the append. The skill therefore
  forbids external calls and throwing for a missing document or a business rule.
- Switching a read model between async and inline changes its fingerprint, which rebuilds it.
- Verified in `src/shared/ensureProjectionsCurrent.tests.ts`: backfill, an immediate read, extension rebuild,
  rollback, and an async → inline switch.
- Library quirk: an inline `pongoProjection` is recorded as type `'a'` in `_projections`, because its `init`
  re-registers it after `ensureInstalled()` registered it as `'i'`. Behaviour is unaffected: inline dispatch only
  checks `status`.

---

### ADR-022: Read model contract and switchable read model types

**Status:** Accepted
**Date:** 2026-09-23

**Context:** A read model can be `database-projected` (async), `inline-projected` (ADR-021) or `live-report`
(folded from the event store per request). A model may need to change a read model's type after clients use it:
live when stored data isn't worth keeping, inline when staleness starts to matter, async when writes need to be
cheaper. Until now each type was generated as different code. The t5 inline route didn't even send the ETag
that the async routes do, so the type leaked into what clients saw. Live read models also have to handle
cross-entity data, such as a student's name on a course, which stored projections get from lookup collections.

**Decision:**
- **The contract is the data shape.** For a read model, the URL, the response body and the status (200, or 404
  for an unknown key) are identical whichever type serves it, and so is the OpenAPI schema. Headers are outside
  the contract. An async route may keep its `ETag` / `Prefer: wait` extras, but clients must not depend on them.
  A switch changes freshness only.
- **One definition, several runners.** A read model is written once, as a keyed fold. `defineReadModel` takes a
  `key` (the idAttribute field, carried as a tag by every primary event), `canHandle`, and a pure
  `evolve(doc, event, lookups)`.
- **Lookups.** Cross-entity data is declared as `lookups`: a related key, the related entity's event types, and a
  small `evolve` of its own. `evolve` can see only the lookup entries whose ids are in the current event's tags.
- **The stored runner** (async or inline) is a generic pongo projection. A lookup event folds into a lookup
  collection. A primary event loads its document and the referenced lookup entries, runs `evolve`, and saves the
  result.
- **The live runner, read 1:** the primary events for the key. The related ids come from their tags.
- **The live runner, read 2:** one **union read**, `(primary types ∧ key tag) OR (lookup types ∧ tags && {related ids})`.
  dcb-event-store ORs query items and matches tags by overlap, so this is a single position-ordered query using the
  tags GIN index. The runner folds it exactly like the stored runner. If read 2 reveals related ids that read 1
  didn't have (a subscription committed in between), it repeats until the set is stable.
- **Identical data.** Both runners fold the same functions over the same event sequence, in position order.
  Contract tests run every scenario against every supported type to prove it.
- **Switching.** A switch changes one `type:` line. `ensureProjectionsCurrent` fingerprints live read models as
  `live:…`, so switching back to a stored type rebuilds the stored copy instead of serving data that went stale
  while unused.

**Alternatives considered:**
- **A uniform header protocol** (ETag = the position reflected, `Prefer: wait` honoured by every type). Rejected
  as the contract: clients care about the data. It stays an optional async extra.
- **Live read models without lookups.** Rejected: it would exclude most real read models. The union read gives
  lookups the same semantics as a stored lookup collection.
- **Separate code per type**, as in ADR-021. Rejected: a switch would mean a rewrite, and the outputs could drift.

**Consequences:**
- Read models that are keyed folds can switch freely between all three types.
- Live requires every primary event to carry the key tag, and every related id to be a tag on the primary events
  that reference it. Read models that can't meet that stay in imperative form, as async or inline.
- Live serves keyed GETs only. Its cost per request is two reads, sized by one entity's history plus its related
  entities' lookup events.
- Lookup values are captured when a primary event is folded, as before, in every type.
- Verified read-only on course-enrollment: the union read for CourseDetails c1 returned positions 1, 3, 5, 6, 7,
  8, 11, exactly the sequence the stored projection processed.


---

### ADR-023: Read model queries: the spec's *when* is the read operation

**Status:** Accepted
**Date:** 2026-09-23

**Context:** Every read model so far answers one operation, a GET of one document by its key (ADR-022). Clients
also need **where predicates**: filtering documents on their fields, e.g. "courses with at least one free seat"
or "the courses a student is subscribed to". A read slice's GWT spec has always been *given* events, an empty
*when*, then the read model. The *when* slot is free to name the read operation, so the specs that describe a
query can also generate and test it.

**Decision:**

*Model: the query is declared once, and specs exercise it*
- **A query belongs to the read model element**, next to its keyed `apiEndpoint`, the same way a command element
  holds the fields that command specs fill in. emcli stores `queries: [{ name, apiEndpoint, parameters }]` on the
  origin read model (copies inherit it, as they do `readModelType`). Export puts it on `readmodels[0].queries` in
  slice.json.
- **Each parameter is a `Field`** (name, type, `optional`, `example`) with two additions:
  - `operator`: `eq` (the default), `ne`, `gt`, `gte`, `lt`, `lte`, `in` or `contains`;
  - `mapping`: the document field it compares, as a dot path. It defaults to the parameter's name.
- **Every parameter is a query-string parameter** at the standard route `/<read-model>/<query>` (ADR-025, e.g.
  `/course-details/courses-for-student?studentId=s1`). Only an overridden endpoint can name a path parameter
  in `{…}`: it is then required and matched by equality (`eq`, or `contains` for an array field).
- **The spec's *when* is one `SPEC_QUERY` step** (emcli type alias `query`):
  - its title is the query name, and it links to the read model element;
  - its fields give the example values for this scenario.
- ***then* is the expected rows:** one `SPEC_READMODEL` step per document the query returns, in order. An empty
  *then* means "no matches". A spec with an empty *when* is still the keyed GET.

*The contract (extends ADR-022; still the data shape only)*
- **URL:** a query is `GET {apiEndpoint}?{parameters}`, with **named parameters only**. There is never a raw
  filter language, so clients see a typed, stable API, and the predicate behind a parameter can change without
  breaking them.
  - `limit` and `cursor` are reserved names.
  - `in` takes a comma-separated list.
  - A query sits beside its read model's keyed GET (`/course-seats/available-courses` next to
    `/course-seats/{courseId}`), so `readModelRoute` mounts the query routes first. emcli rejects a query
    endpoint that another read model's route also matches.
- **Body:** always a page, `{ "data": [ …documents… ], "cursor"?: "…" }`.
  - Each document has the same shape as the keyed GET body.
  - `cursor` is opaque, and present only when there are more rows (the runner fetches `limit + 1`). `limit`
    defaults to 50, with a maximum of 200.
- **Status:** 200 always, including an empty `data`. A missing required parameter or a value that doesn't parse
  gives 400. A query is never 404.
- **Semantics** (the same in the SQL and in the in-memory matcher; `readModelQueries.ts`):
  - **Predicates:** parameters are ANDed, and an absent optional parameter drops its predicate.
  - **Types:** each parameter declares `string`, `number` or `boolean`, and a comparison only matches a document
    value of that JSON type. So the string `"2"` never equals the number `2`, and numbers compare numerically.
  - **Paths:** `eq`, `ne`, `gt`, `gte`, `lt`, `lte` and `in` read a scalar at a dot path through objects. A path
    that is missing, or that crosses an array, has no value.
  - **`contains`** follows the path through arrays at every step, including a final array field. That is
    Postgres jsonpath lax mode. It matches if any value reached equals the parameter:
    `subscribedStudents.studentId`, or `tags`.
  - **Missing fields:** a missing field matches only `ne`.
  - **Strings** compare and sort by UTF-8 bytes (`COLLATE "C"`, `Buffer.compare`), never by the database's
    locale.
  - **Order:** by the query's `sort` field (types rank missing < number < string < boolean < object), then by the
    key, both in the sort's direction. The default is the key, ascending. The cursor encodes a position in that
    order.
- The page body is the same whichever type serves the query.

*Runtime*
- `defineReadModel({ …, queries: { name: { params, sort? } } })` describes the query declaratively, with no
  predicate function, so every runner can read it:
  - `params: { minFreeSeats: { field: "remainingSeats", op: "gte", type: "number" } }`;
  - an optional `tag` names the tag key that finds candidates live (below).
- **The stored runner** (async or inline) runs one parameterised JSONB SELECT, sorted by
  `(rank, number, string, key)`, with keyset paging from the cursor.
  - It does **not** use pongo's `find`. Verified in pongo 0.17: `find` compares `$gt`/`$gte`/`$lt`/`$lte`/`$ne`
    as text (`'10' < '9'`), doesn't reach into arrays along a dot path, and sorts by the database collation. Any
    of these would make stored results differ from live ones.
  - At startup the runtime creates the indexes the queries use: one typed expression index per compared field, a
    `jsonb_path_ops` GIN index for `contains` (the SQL uses `data @? jsonpath`), and one per sort order.
    An unsorted query orders by the key alone, so it gets a key-order index, `(_id COLLATE "C")`, which the
    primary key (default collation) can't serve. Its cursor is sent as `(_id COLLATE "C") > $key`, not as the
    full tuple comparison, whose constant columns can't be an index condition. A page of a query most documents
    match then walks the keys and stops at `limit + 1`. At 20k documents, the first page drops from 7.8 ms to
    0.5 ms and a deep page from 3.5 ms to 0.4 ms (PLAN 12.6b).
    Indexes don't change documents, so they are **not** part of the rebuild fingerprint.
- **The live runner** can serve a query **only if the query has a required equality parameter (`eq`, `in` or
  `contains`) that declares a `tag`**:
  - It reads the primary events carrying `{tag}={value}` and collects their key tags as candidates.
  - It folds each candidate, with the ADR-022 union read for lookups.
  - It then applies **every** predicate in memory, sorts and pages.
  - The tag only narrows the candidates, so any state predicate can ride along.
  - The requirement: every document that should match has at least one primary event tagged with that value. The
    skill checks this against `Events.ts`, as it does lookups.
- **A query without a tag parameter is stored-only.** That includes a parameterless "list everything" query,
  which replaces imperative list read models in fold form. `startReadModels` refuses to start a live read model
  with such a query, and emcli warns at export (alongside `warnLiveLists`).
- One generic handler, `readQueryRoute(readModel, runtime, name, path?)`, parses and validates the parameters and
  serves the page for every type, so the shape can't drift per slice.
- **Each query declares its `path`** in the definition (the model's `apiEndpoint`, with `:param`), and
  `readModelRoute` mounts every declared query next to the keyed GET. Adding a query then changes only
  `readModel.ts` and its tests. The route file and the app's wiring stay the same, which keeps the loop's
  query-added path additive. `defineReadModel` checks that each `:param` is a required `eq`/`contains`
  parameter.
- **Tests across types:** `withType(readModel, "live-report")` keeps only the queries live can serve, so a read
  model with a stored-only query still runs its keyed contract tests live. `queryTypes(readModel, name)` gives
  the types a query's own tests run over. `startReadModels` still refuses a *definition* typed live that has
  an untagged query.

*Tests and the loop*
- **Contract tests:** each spec with a *when* query becomes a test that appends *given*, GETs the endpoint with
  *when*'s examples, and expects `data` to equal *then*'s rows. It runs `describe.each` over the query's supported
  types.
- **New queries are additive.** A query added to a Done read model re-queues it through the loop, as a retype does
  (ADR-022), and the skill adds the query without touching `evolve`. Documents don't change, so no rebuild.
- **Commit checks hold it additive.** While an `addQueries` slice is InProgress, `query-additive` allows only
  its own `readModel.ts` and tests to change: lines added inside `queries` (re-adding the previous last entry's
  `}` as `},`), every added name declared, a `"{slice title}: {query} (%s)"` block per added query with a test per
  spec that runs it, and existing test lines kept, except the import widened with `queryTypes`. With a `retype`
  too, the retype is its own one-line commit first: `retype-scope` holds any commit that touches the `type:`
  line to that line, and leaves the queries commit to `query-additive`. An extension's queries go in the
  origin, where `extension-additive` counts its query blocks with its keyed block.

**Alternatives considered:**
- **Reusing `SPEC_READMODEL` in *when*.** Rejected: it's ambiguous against *then* for the kit, and it can't carry
  operators.
- **Defining the query only in the spec steps** (the kit collects them). Rejected: two specs could disagree on an
  operator or an endpoint, and there'd be nowhere to hold the endpoint. The read model element already owns its
  API.
- **A generic filter parameter** (`?filter=remainingSeats>0` or MongoDB JSON). Rejected: it exposes the storage
  model and ties clients to what one type can evaluate. That breaks the switchable contract and needs its own
  guarding.
- **A bare array body.** Rejected: it has no room for a cursor, and the scaffold's list already uses
  `{ data, cursor? }`.
- **Deriving query URLs by convention** (`{keyed path}/{query-name}`). Rejected: Express would match them to the
  keyed route's parameter. The model names the endpoint instead.
- **Stored-only queries.** Rejected: tag narrowing lets live serve the common "X for a given Y" queries with the
  same body.

**Consequences:**
- The keyed GET is unchanged. Existing read models and specs need no migration.
- A query is a model decision: emcli owns its endpoint, parameters and operators, and the spec's *when* shows it in
  use. prooph board sees it as rendered markdown only.
- Read models can switch type freely as long as each query supports the target type. A query without a tag
  parameter pins its read model to stored types.
- Live query cost scales with the number of candidates, i.e. the entities tagged with the parameter's value, not
  with the store.
- Stored queries cost an indexed SELECT. Heavily filtered fields may need tuning beyond the indexes the runtime
  creates. Right after a bulk load (a rebuild's replay), a GIN index's pending list and the dead tuples can make
  the planner skip an index until VACUUM runs (PLAN 12.6).
- Out of scope: OR predicates, full-text search, aggregates (counts, sums) and cross-read-model joins.

---

### ADR-024: Screens as bound HTML

**Status:** Accepted (implementation in progress: PLAN 14.2b–14.9)
**Date:** 2026-09-23

**Context:** A slice's screen was an ASCII sketch in a board description: a picture, but nothing a build could
use or check. Two things changed that (PLAN 14.0):
- prooph board draws a fenced ` ```html ` block in an element's description as a native wireframe;
- its snippet API lets a workspace share a design system that wireframes import with `<!-- @import <slug> -->`.

The backend already exposes every route in `/openapi.json` (14.1).

**Decision:**
- **A screen's mockup is a full HTML document** on its `ui` element in the model (`mockup.html`), static (no
  scripts). It names what it shows with bindings:
  - `data-field` (an input or a shown value);
  - `data-list` (a repeated region);
  - `data-command` (what submits);
  - `data-slice` (a region of a shared screen owned by another slice).
- **The screen's dependencies are the contract.** It `displays` read models and `submits` commands.
  - **Every binding must come from those dependencies.** A name that doesn't exist is an error, which fails
    `completeness` and so the hand-off to the loop: the build can't write code for it.
  - **Coverage gaps are warnings the builder fills:**
    - a submitted command with no button;
    - a command field the page supplies but has no input for;
    - a displayed read model never shown.
  - **Field exceptions are shared with the backend's field-flow check.** A field needs no input when it's
    generated, technical, or mapped `session:`, `derived:` or `webhook:`.
  - **Nothing blocks drawing, pushing or exporting a mockup** (PLAN 14.4).
- **On the board:** the mockup is pushed into the screen's description as a fenced HTML block, never as an image.
  It goes in the description because details are shared between an element and its copies. The design system is
  a board snippet, pushed by emcli with an explicit slug. Mockups import it by slug and never expand it, since the
  expanded form is a frozen copy.
- **In code:** the loop builds `web/` (React, Tailwind) from the mockup, one component per bound command and read
  model, with the client generated from `/openapi.json`. Tests come from the slice's scenarios.

**Alternatives considered:**
- **Images** (PNG rendered from the HTML, or SVG sketches). Rejected: they need a renderer and image storage,
  can't be edited on the board, and carry no structure a build can use.
- **Checking bindings against the slice's elements** (14.2's first version). Rejected: slice membership is
  layout, not information flow. A screen can show a read model from another slice, and a slice can hold a command
  its screen doesn't submit.
- **Generic generated forms** (prooph's Cody / RJSF). Rejected as the target. Borrowed only as the idea behind
  `--draft`.
- **Scripts in mockups.** Rejected for mockups, although the board may allow JS: a blueprint has to be static to
  map 1:1 to JSX. Live HTML (charts from production data) is a separate use.

**Consequences:**
- One HTML document is the board's wireframe, a checked part of the model, and the blueprint for the React
  screen.
- Screens need explicit `displays` / `submits` dependencies before they can be drafted or built. Existing models
  (course-enrollment's 24 screens have none) need them added.
- A design-system change is one snippet edit: every wireframe on the board follows it live, and the same CSS ships
  in `web/`.
- The board shows mockups only as long as emcli pushes the description: `sync push` owns it, and a board-side edit
  is taken back into the model on pull (14.3).

---

### ADR-025: API routes are named after the model, 1:1

**Status:** Accepted
**Date:** 2026-09-24

**Context:** Nothing set API endpoints. Each route was whatever the modeler typed, and the build skills copied
it, so projects drifted apart. course-enrollment and this kit's example app gave the subscription relationship
three names (`/courses/:id/students`, `/courses/:id/subscriptions`, `/students/:id/subscriptions`), placed read
models as if an entity owned them (`/courses/:courseId` vs `/courses/:courseId/seats`), and gave queries no single
home (`/available-courses`, `/students/:studentId/courses`). The frontend (PLAN 14.6) needed a rule before it
could be generated.

**Decision (Gary, PLAN 14.5b):**

| Element | Route | Example |
|---|---|---|
| Command | `POST /<command>`, every field in the body, no IDs in the path | `POST /change-course-capacity {courseId, newCapacity}` |
| Read model | `GET /<read-model>/:<ID attribute>` (none: `GET /<read-model>`) | `GET /course-details/c1` |
| Query | `GET /<read-model>/<query>?<parameters>`, every parameter in the query string | `GET /course-seats/available-courses?minRemainingSeats=1` |
| Infra | unchanged | `/events`, `/openapi.json` |

- Names are kebab-cased from the model. emcli derives every route at export; `apiEndpoint` is only an override,
  and one that differs from the standard is a warning (never a block).
- **Commands are always POST.** Retries are safe because every command dedupes on its `Idempotency-Key`, not
  because of the method. A command answers 204 + `ETag`, or 201 with its generated fields as the body. There is
  no `Location` header: a command doesn't know which read model will show its result. Rejections stay
  Problem-JSON.
- `readModelRoute` mounts a read model's query routes before its keyed GET, so a query name isn't read as a key.
- **The app's page routes are a separate concern**, entity-shaped for people (`/courses/:courseId`, PLAN 14.6).
  Code generation joins the two through the ID attribute (DCB tag) names they share, which must be the same
  everywhere: the route param `:courseId`, the command field `courseId`, the read model key `courseId`.

**Alternatives considered:**
- **Resource-style REST** (`PUT /courses/:courseId/capacity`). Rejected: a DCB command can span several tags
  (`subscribeStudent` touches a course and a student), so it has no single owner to nest under. Every such
  command needs a judgement call, and the model already names it.
- **PUT when the command carries its identifier.** Rejected: having an ID doesn't make a command idempotent (an
  `addSeats` command with a `courseId` isn't), nearly every DCB command carries a tag ID anyway, and the
  idempotency key already makes retries safe.
- **Read models under their entity.** Rejected: in CQRS a read model is its own resource. CourseSeats and
  CourseDetails both key on `courseId`, and neither owns `/courses/:courseId`.
- **Queries as filters on the read model** (`GET /course-seats?minRemainingSeats=1`). Rejected: a read model can
  answer several named queries, and two with overlapping parameters would be ambiguous.

**Consequences:**
- A route never needs designing: it is the element's name. The build skills copy `apiEndpoint` from slice.json
  as before; only its shape changed.
- The API is RPC-shaped, for the project's own frontend. A public, REST-shaped API can be a facade later.
- Existing projects migrate once: overrides cleared in the model (emcli warns about each), the routes and their
  tests rewritten, and the frontend's client regenerated.

### ADR-026: Lists in the UI page with "Load more" over the backend's cursor

**Status:** Accepted
**Date:** 2026-09-24

**Context:** Every list the backend serves is cursor-paginated: a query route (ADR-023) and a list read model take
`?limit=` (default 50, at most 200) and `?cursor=`, and answer `{ data, cursor? }`. The cursor is an opaque
bookmark meaning "the next page starts after this row"; it is present only when there are more rows. The
frontend (PLAN 14.6) showed only the first page. It needed one way of paging that `build-screen` applies to every
list.

A cursor only moves forward. It answers "what comes after this row?", never "what is on page 7?" or "how many
pages are there?".

**Decision (Gary, 2026-09-24):** a list shows its first page (20 rows) with a **Load more** button under it.

- The page opens and asks for `?limit=20`. The backend returns those rows and, if there are more, a cursor.
- While there is a cursor, **Load more** is shown. Clicking it asks for `?limit=20&cursor=<bookmark>`, and the next
  20 rows are **added below** the ones already shown: the list grows from 20 to 40, and so on.
- When the backend returns no cursor, the button goes (the list is complete).
- The person never leaves the list; it gets longer, like "Show more comments" on a website.
- Built on TanStack Query's `useInfiniteQuery`, with the cursor as its page parameter. After a write
  (`recordWrite`), the loaded pages are refetched in order, each with `afterLastWrite()` for an async read model.
- Only lists that are pages from the backend are paged: a query's rows or a list read model. A `List` field inside
  one document (a course's students) comes whole with its document and isn't.

**Why:**
- **It is what a cursor does.** Load more only ever asks "what comes after the last row I have?", the one
  question a cursor answers, so it maps onto the backend exactly.
- **It stays right when the data changes.** After a write (subscribing to a course while looking at the list),
  the list refetches and every loaded row stays in place, updated. With pages, a refetch can shift rows between
  pages, so an item can slip onto the page already left behind, or show on two.
- **It is the least code.** TanStack Query, already in `web/`, has it built in; the skill's pattern and its
  tests stay simple.

**Alternatives considered:**
- **Next / Previous pages.** One page at a time. The backend can't page backwards, so the UI has to remember
  every cursor it used (a stack) to offer Previous, and there can still be no page numbers, no "page 3 of 10" and
  no jump to page 7, because a cursor can't count or seek. Rows can shift between pages when data changes.
  Better for very long lists (one tidy page on screen instead of every loaded row), for table-style admin
  screens where people expect a pager, and for linking to "page 3" (though a cursor in a URL goes stale as data
  changes). Rejected as the default for the kinds of lists these apps have (courses, a student's courses, query
  results); it can be added per list later if a screen needs it.
- **Infinite scroll.** Load more, triggered by scrolling to the bottom. Harder to test, less accessible (keyboard
  and screen-reader users, and the page footer can't be reached). Rejected; it can be layered on Load more later.
- **Both, chosen per list in the model.** Rejected for now: two components to build and test, and a per-list
  setting in emcli, before any screen has needed the second one.

**Consequences:**
- `build-screen` gives every paged list the same shape: the rows, then Load more. Its mock handlers page the
  scenario rows the way the backend does, and each list gets a test that loads the next page.
- Loaded rows stay in memory and on screen; a list someone pages through hundreds of times grows long. That's
  the trade for simplicity, and the reason Next / Previous stays an option.
- A list has no page in its URL: a shared link opens the first page.


### ADR-027: A build status per concern: backend and UI

**Status:** Accepted
**Date:** 2026-09-24

**Context:** Since PLAN 14.7 the loop builds a slice's UI (its screen, in `web/`) after its backend, but it tracked
one status per slice. A screen that failed its checks set the whole slice to Blocked, and the hand-off gate then
held back every slice depending on it, although the backend they needed was built and committed. The status also
hid what was true ("Blocked" said nothing about the working backend), and the loop inferred the split instead of
recording it (a screen fingerprint, a pending `buildScreen`, and a search of `git log` for the backend commit).

**Decision (Gary, 2026-09-24):** each slice has a build status per **concern**, and one loop runs a routine per
concern.

- **Concerns:** `backend` (the slice's commands, events, read models, processors) and `ui` (its screen, once it
  has a mockup). The loop's queue entry (`index.json`) carries `concerns: { backend: { status, blockedReason?,
  blockedAt? }, ui: { … } }`; emcli's export writes them, the loop claims one, and its agent finishes it.
- **The slice's status is derived:** Blocked if any concern is, else InProgress, else Planned, else Created, else
  Done. Everything that read the one status keeps working; the model and the board keep one status each, and the
  slice's board details show both ("Backend ✓ built · UI ✗ blocked: …").
- **Order:** a slice's UI is built once its backend is Done (it calls the backend's routes and its types are
  generated from the backend's code). The backend never waits for a UI, and a prerequisite counts as built once
  its backend is Done. A mockup's own errors hold back only the UI.
- **Re-queues per concern:** a retype or added queries queue the backend; a screen added or changed queues the
  UI; planning a slice again after the loop blocked it frees only the blocked concern.
- **One loop, a routine per concern:** `lib/backend-prompt.md` and `lib/screen-prompt.md`, each smaller and
  tuned to its job, optionally with its own model (`models` in the project's config). Entries without concerns
  (other kits, older exports) are one backend concern: the whole slice.

**Why:**
- **A UI must not hold up a backend.** Other slices build on a slice's events and commands, never on its screen.
- **The status should say what's true.** Full-stack teams track a story's backend and frontend tasks separately,
  and the story is done when both are.
- **Explicit over inferred.** The concern statuses replace the `git log` search and make recovery, the stuck
  guard and re-planning precise to the job that failed.

**Alternatives considered:**
- **One status per slice (as in 14.7).** Rejected for the reasons above.
- **Two loops running at once, one per concern.** They would share one working tree, so two agents would collide
  on git's index and on the pre-commit hook, and "never commit while the loop builds" would apply to two loops.
  Doing it properly needs a worktree per loop and merging between them. It adds only throughput, and the UI would
  still wait for its backend. Rejected for now; worth revisiting with contract-first (below).
- **A new board status per concern.** Rejected: the board keeps one status (PLAN 14.4c); the details show both.

**Consequences:**
- A blocked UI shows its slice as Blocked, but nothing else waits; re-planning rebuilds only the UI.
- The UI still waits for its own slice's backend. **Contract-first** (PLAN 14.10, future) removes that: emcli
  writes the API contract from the model, so the UI and the backend can be built in parallel, each against the
  contract, with a check that the code's `/openapi.json` matches it. *Done in ADR-029: with the contract, a UI
  waits for nothing.*


### ADR-028: The loop's memory by concern, with git as the record

**Status:** Accepted; implemented in PLAN 14.10a (kit: `lib/memory.js`, the DCB prompts and `learnings/`)
**Date:** 2026-09-25

**Context:** The loop keeps two memory files, and both routines (ADR-027) read and append to both:
- `progress.txt`: append-only, one entry per job, each ending in "Learnings for future iterations";
- `.build-kit/AGENTS.md`: "Project Learnings".

It isn't a pipeline: in one run the agent writes its progress entry and appends the same lessons to AGENTS.md,
and nothing reads `progress.txt` later to distil it.

On course-enrollment after t14:
- `progress.txt` was 25 entries (30 KB), read in full by every job. 22 entries repeated one environment line.
- AGENTS.md held 42 bullets: 32 backend, 4 UI and 6 shared (environment, git, checks).
- Five bullets contradicted the kit (PUT/DELETE routes after ADR-025; "a screen job skips the backend" after
  ADR-027). Several more repeated what the skills now say.

The lessons were applied: t14's backend reused the project's patterns, and jobs passed first time. But time and
cost per job stayed flat from t0 to t14. Where knowledge really crystallised was outside the loop: lessons we
promoted into the skills.

**Decision (Gary, 2026-09-25):**
- **Learnings by concern.** Three files: `.build-kit/learnings/shared.md` (environment, git, checks, conventions),
  `backend.md` and `ui.md`. The loop puts the shared file and the job's concern's file into the prompt, under
  "Your task". Agents don't go looking, and a routine never reads the other discipline's lessons.
- **Git is the record of completed work.** A job that ends in a commit writes its summary into the commit body:
  - what it built;
  - the rules and patterns it applied;
  - the tests it ran;
  - what the other concern needs to know.

  It writes no progress entry. A UI job gets its backend's commit body in its prompt; contract-first (PLAN 14.10)
  later replaces even that.
- **`progress.txt` is the journal of what has no commit:** blocked or interrupted jobs, escalated questions, and
  the loop's own notes, each naming its slice and concern.
  - **Retention:** an entry is kept while its concern isn't Done, and the loop's settle step removes it once the
    concern is Done.
  - The file is committed with the model (`model(…)` commits), so history keeps every version:
    `git log -p -- progress.txt`.
- **Pruning.** A lesson is written, used, then promoted, kept or deleted, at three triggers:
  1. a kit update removes the lessons its change supersedes;
  2. a cap of about 40 bullets per file makes the agent merge before adding;
  3. at phase close, lessons true for every project are promoted into the skills (a kit change the user
     approves) and removed. Lessons the kit covers, or that are wrong, are deleted.

  Writing rules: project-specific and non-obvious only; no environment status lines; correct a wrong bullet,
  never append a contradicting one.
- **Other kits:** entries without `concerns` keep AGENTS.md and `progress.txt` as before (as in ADR-027).

**Why:**
- **Relevance.** Backend and UI are different disciplines. A routine that reads only its own lessons has less to
  disregard, and less chance of applying the wrong one.
- **Correctness.** Stale lessons contradicting the kit are the real risk today. Small files with owners can be
  capped and pruned, and a kit update knows which lessons it supersedes.
- **Bounded context.** Nothing an agent reads grows with the project. The full `progress.txt` was about 8k
  tokens after 25 jobs, and would be about 60k after 100.
- **One record, not three.** The commit already holds the diff. Its body adds the why, so a separate log of
  completed work duplicates git.
- **Ready for independence.** Two loops, one per concern, would collide appending to shared files. Separate
  memory is a prerequisite, and contract-first removes the last cross-concern read.

**Alternatives considered:**
- **Keep one AGENTS.md and label bullets by concern.** Rejected: every routine still reads all of it, and caps
  and pruning are per discipline anyway.
- **Keep `progress.txt` as the full audit log, and have agents read only its tail.** Rejected: it would still
  duplicate git, and the useful part of an entry (the why) belongs with the commit it explains.
- **Distil `progress.txt` into the learnings later** (a two-stage pipeline). Rejected: the agent that did the
  work knows the lesson at the time. Curation is better spent on promoting lessons into the skills.

**Consequences:**
- The loop's commits gain a body, and the commit checks must accept one.
- A blocked job's narrative lives in the journal until it's fixed, then only in history.
- Keeping the learnings accurate becomes part of every kit update and every phase close.


### ADR-029: The API contract comes from the model

**Status:** Accepted; implemented in PLAN 14.10 (emcli `model/contract.ts`; kit: `src/shared/contract.ts`, the
`api-contract` and `api-types` checks, `nextWork`'s contract-first order, `run --concern`)
**Date:** 2026-09-25

**Context:** The UI depended on its slice's backend three ways (ADR-027, ADR-028):
- **the order:** the loop ran a UI job only once its backend was Done;
- **the types:** `gen:api` generated the UI's client from the backend's code (`src/openapi.ts`), so the code had to
  exist;
- **what it knew:** the UI job was given the backend's commit body, and read rejection messages from `decider.ts`.

Yet the model already names everything the UI needs: every route (ADR-025), every field with its type, optional
and ID flags and example, each query's parameters, each read model's type, and every rejection (its specs'
`SPEC_ERROR` titles). Gary wants the backend and the UI developed independently (PLAN 14.10).

**Decision:**
- **emcli writes the API contract**, `api/openapi.json` (OpenAPI 3.1), at every build-kit export, from the whole
  model, whatever the export is scoped to. It covers the slices handed to the build (planned or later, never
  drafts), and it's committed with the model and never edited.
- **It mirrors what the kit serves** (`src/shared/openapi.ts`), so the same types come from either:
  - **Commands:** `POST /<command>`, body `{Command}Body` (all fields but generated ones), 204 + ETag or 201 with the
    generated fields, 400, and `4XX` listing the rejections (`x-rejections`).
  - **Read models:** `GET /<read-model>/{id}` → `{ReadModel}` and 404 (`"<Entity> not found"`), or a page without
    an ID. A copy's new fields join the origin: a scalar optional, a List required (the fold starts it `[]`).
  - **Queries:** their parameters, `limit` and `cursor`, answering a page.
  - **Async reads:** `If-None-Match` + `Prefer: wait`, ETag, 504.
- **The UI builds from the contract.** `gen:api` generates `api-types.ts` from it, with no backend; rejection
  messages come from slice.json's `SPEC_ERROR` titles, which the backend sends verbatim. The UI job isn't given
  the backend's commit body. The `api-types` check keeps the types exactly the contract's.
- **The backend is checked against it.** `npm run contract:check` builds the served document from the code (no
  database) and compares it operation by operation, on what the typed client sees:
  - the parameters (name, required);
  - the success status;
  - the fields, required ones and types (an integer is a number) of the body and response;
  - the schema names.

  Descriptions, headers, formats, nullability and which 4xx a rejection uses aren't compared: the model doesn't
  decide them, and the UI shows a rejection's `detail` whatever its status. A served route the contract lacks is
  an error; a contract route not served yet is **pending**. The `api-contract` commit check runs it for the
  touched slices' operations.
- **The loop:** with a contract, a UI job waits for nothing (`nextWork`'s `contractFirst`); within a slice, the
  backend is still picked first. `eventmodelers run --local --concern ui|backend` builds one discipline only, so
  the screens can be built before the backends (or by a person, from the contract, in mock mode).

**Why:**
- **Independence.** Each discipline works from the model alone: the UI needs neither the backend's code nor its
  notes, and each learns only its own lessons (ADR-028).
- **One source of truth.** The model already decides the API (ADR-025). Deriving the contract means nobody
  designs it twice, and the check keeps the code honest to it.
- **It's visible.** The contract is a committed file: a model change that changes the API shows in its diff, and
  the export names the operations it changed.

**Alternatives considered:**
- **Keep generating the client from the backend's code.** Rejected: that's the dependency this removes.
- **Generate the backend's Zod schemas from the contract.** Rejected for now: the build skills already write them
  from slice.json (the same data), and the check catches any drift. Worth it if drift proves common.
- **Put each rejection's HTTP status in the model.** Rejected: statuses are the backend's (ValidationError 400,
  NotFound 404, IllegalState 422), and the UI treats every rejection alike. The model keeps the message.
- **Two loops at once, one per concern** (worktrees). Out of scope (PLAN 14.10): one working tree still means one
  loop at a time. The contract makes it possible later; `--concern` covers building one discipline first.

**Consequences:**
- A UI can be built, tested and shown in mock mode before its backend exists; it works against the backend once
  that's built, with no change, as long as the backend matches the contract (proven in PLAN 14.10's t16).
- A model change to a built slice's API makes its code **differ** until the slice is built again;
  `contract:check` names what differs, and the export lists the changed operations.
- The contract can't say: a custom 404 message, which 4xx a rejection gets, a value the backend may send as
  `null`, or a read that answers 404 until its first event. Those stay in the specs, the skills and the backend's
  commit body.
- Two slices modelling the same route (not linked as copies) make the contract use the later one; the export warns.



### ADR-030: Everything runs in containers; no cloud-only services

**Status:** Accepted
**Date:** 2026-09-27

**Context:** PLAN Phase 15 takes up automations. Its reference implementation (fraktalio's restaurant
order-management demo) runs its automation on Cloudflare Workflows. The workflow's state is kept in Durable
Objects, and Postgres is reached through Hyperdrive. None of these exists outside Cloudflare. Automations will
bring more engines of this kind (workflow engines, schedulers, queues), and each could tie the kit to one cloud.
Gary wants services built with the kit deployable to any cloud or on premises.

**Decision:**
- **Every runtime part of a kit project runs as a container image** that we can run ourselves: the API and its
  processors, Postgres, any workflow engine (PLAN 15.3: Temporal's server is MIT-licensed and self-hosted), and
  mocks of external systems. `docker compose up` runs the whole system on one machine; tests use testcontainers,
  as they do today.
- **A cloud service may host a standard interface, never replace it.** We may use:
  - a managed Postgres, as long as the code uses only Postgres;
  - a static file host for `web/`, such as S3 and CloudFront (PLAN 14.8), as long as the same build is also
    served from a container (nginx);
  - a managed runtime for our containers.

  We may not use APIs that exist only in one cloud: Cloudflare Workflows, Durable Objects or Hyperdrive, AWS Step
  Functions, Lambda-only triggers, and the like.
- **Every external engine the kit adopts must be self-hostable in containers.** It may offer a managed version
  (Temporal Cloud), but the kit must not need it.

**Why:**
- **Portability.** The same system runs on a laptop, on premises, and on any cloud.
- **Testability.** Integration tests run the real engines in containers, with no emulators and no accounts.
- **One mental model.** A project's `docker-compose.yml` lists everything it needs.

**Alternatives considered:**
- **Adopt the reference's Cloudflare stack.** Rejected: it locks us into one vendor, and Workflows can't run on
  premises.
- **Abstract over the cloud-specific services** (an adapter per cloud). Rejected: it means several
  implementations to maintain, and the lowest common denominator of their semantics.

**Consequences:**
- PLAN 14.8's deploy needs a container path for `web/` (an nginx image) next to S3 and CloudFront.
- Adopting an engine includes proving it runs in `docker compose` and in a testcontainers test (PLAN 15.3).
- The reference's workflow code and skills are adapted, never copied (PLAN 15.3).


### ADR-031: Automations are to-do lists worked by a processor group; external work runs in Temporal

**Status:** Accepted, 2026-09-27. Temporal as the executor for external work is subject to PLAN 15.3's proof
(running in containers and tested under vitest). Temporal under vitest was proven in a spike on 2026-09-28; the kit's
runtime is ADR-033, and the loop proof is recorded in PLAN 15.3.
**Date:** 2026-09-27
**Blueprint:** [`docs/case-studies/automation-todo-list.md`](../../../docs/case-studies/automation-todo-list.md)

**Context:** `build-automation` is still Phase 4's template, and no automation has been through the loop. It
builds an event handler that issues a command and **swallows its errors** (`catch → console.error`). In the
library, a handler that throws rolls back and ends its processor, and `createConsumer` never restarts it. So a
failed automation is either skipped for good or stops silently. We looked at five sources.

- **Fraktalio's restaurant demo** (the Phase 15 domain) orchestrates payment with a Cloudflare Workflow:
  - the UI starts it, and it places the order;
  - it waits up to an hour for a gateway signal;
  - it then marks the order paid or failed.

  It has no to-do list and isn't event-driven. Its progress lives in the workflow's own store, and it resolves
  the dual write with idempotency keys (`workflowId:step`). The pending work isn't visible in the model, and a
  timed-out wait records nothing.
- **Dilger, *Understanding Eventsourcing***:
  - **ch. 35, "Processor-TODO-List":** a read model lists the processor's open tasks. Events open a task and
    events close it, and the command's own event checks it off. A failed task stays open until it's closed or set
    aside. It prefers choreography over a saga orchestrator.
  - **ch. 26:** translate external events first; automation specs are GIVEN/THEN; handlers fire again on replay;
    never swallow errors. The book keeps the to-do projection and the automation in one Axon processing group.
- **Axon 5** (`axon-messaging` 5.0.2 and 5.1.0):
  - A processor calls its handling components **one after another for each event, in registration order, in one
    unit of work** (`ProcessorEventHandlingComponents`). Its progress moves once, after all of them.
  - The default `ErrorHandler`, `PropagatingErrorHandler`, **fails fast**: the batch aborts, and the segment is
    claimed again after a backoff that grows, so the same event is retried and that processor blocks until the
    handler succeeds. Other processors carry on.
  - "Log and continue" is an `ErrorHandler` you write.
  - Axon 5 has no dead-letter queue yet: Axon 4's `SequencedDeadLetterQueue` and `LoggingErrorHandler` aren't
    ported.
  - Gary's Axon 5 project (`generator-axon5-scratch`, `addssndata`) puts its to-do projector and its automation in
    one processor, but the automation reacts to the event, never reads the list, and skips replays
    (`isReplay`).
- **Emmett** (`error-handling.md`, `workflows.md`):
  - A throw in a reactor stops the processor, which resumes from the same point on its next run. A handler can
    return `skip()` (log and continue) or `stop()`.
  - The guidance is "never throw in asynchronous handlers": record a failure event or skip.
  - It has no dead-letter queue; its only retries are for optimistic-concurrency conflicts.
  - Emmett's workflows are event-sourced process managers (an inbox/outbox stream and an `outputHandler` for
    external work). A failed external call stops them, with no durable retries.
- **emcli** already models automations (`automation` with `processorType`) and the rule that every automation has
  a to-do list (`skills/event-model/references/slicing.md`).

**Decision:**
- **Every automation is a to-do list, and the event store is the only source of truth.**
  - The model reads: the opening event → the to-do read model → the automation → its command → the closing event.
  - A modeled event opens the work. A technical event appended to signal it is never used.
- **One processor per automation: our processing group, with two steps in a declared order for each event.**
  1. **The list step** opens or closes the item.
  2. **The automation step** runs only if the item is open, reading it in the same transaction, so it's always
     there. There's no race and no signal between separate components.

  The processor records its progress after both. Our order is written down in the kit's helper; Axon's is only
  implied by registration order.
- **Internal work** (an event → one of our commands) runs in the automation step. It issues the command with the
  idempotency key `<automation>:<item key>`: the library turns that into deterministic event ids, and a repeat is
  dropped.
- **External work** (a system we don't control) **runs in Temporal from day one.**
  - The automation step starts a workflow with `workflowId` = the item key, so a repeated start does nothing.
  - The workflow's activities call the external system, then issue the command with the idempotency key.
  - **Retries, backoff and timeouts are the workflow's configuration only.** We write no retry schedules of our
    own.
  - Starting a workflow is quick, so no slow call runs inside the event's transaction.
  - Temporal holds only execution state. Business facts stay in the event store.
- **The closing event ticks the item off.**
  - If Temporal gives up, the item stays open on the list, and Temporal's UI shows the reason.
  - **Redrive** (a UI action → a command → the item's workflow started again) is designed separately (ADR-032, PLAN 15.4).
- **The processor's failure policy follows Axon's default:**
  - **Fail fast by default:** log, back off, retry the same event, and block this processor only, with its blocked
    status and error visible. It never dies silently and never skips.
  - **Skip is opt-in** (Emmett's `skip`): log and continue, only where losing an event is acceptable.
  - **No dead-letter queue.** For automations, the to-do list plus Temporal is the visible record of stuck work.
- **Replays and rebuilds** skip the automation step and rebuild only the list. A repeated start or command would
  be a no-op in any case.

**Why:**
- **One source of truth, and it's visible.** Pending work is a read model that the board shows and the UI can list.
- **Idiomatic.** It's Axon's processing group and the book's own arrangement, built from pieces our library
  already has (a processor with its handler, a bookmark, idempotent appends). The only new piece, Temporal, does
  what neither Axon 5 nor Emmett offers: durable retries of outside calls.
- **Resilient from day one.** External calls get proven retry, backoff and timeout semantics without our writing
  any.
- **Replay-safe**, and the slices stay one at a time for the loop.

**Alternatives considered:**
- **An event-triggered automation beside its list** (today's skill; Gary's Axon 5 example). Rejected: failures are
  lost or fatal, work is skipped on replay (`isReplay`), and the list is only a report.
- **A separate worker woken by the list's notifications** ("two bells"). Rejected: it uses existing notifications,
  but it adds a new kind of component that the processing group makes unnecessary.
- **A technical event appended after the item is written.** Rejected:
  - a projection that appends becomes an automation, with its own dual write;
  - a rebuild appends the events again;
  - plumbing becomes permanent history.
- **Our own retry schedule for failed items.** Rejected: retries belong to Temporal's configuration (Gary). Our
  processor only fails fast on its own infrastructure errors.
- **A dead-letter queue.** Rejected for now: Axon 5 and Emmett have none, and the to-do list already holds stuck
  work, visibly.
- **The reference's orchestrating workflow** (on Temporal). Rejected: business state moves into the engine and
  the model stops showing the process.
- **Emmett workflows as the external executor.** Rejected: no durable retries of external calls.
- **Temporal for every automation.** Rejected: internal event → command reactions need nothing it adds.

**Consequences:**
- **The library** (PLAN 15.2): a processor failure policy (fail fast with backoff and a visible blocked status by
  default, or opt-in skip), `createConsumer` never losing a processor, and the automation step told when the
  processor is rebuilding.
- **The kit** (PLAN 15.3):
  - Temporal's server and UI in `docker compose` (ADR-030, on our Postgres) and in testcontainers;
  - a worker in the runtime;
  - a helper that composes the list step and the automation step;
  - `build-automation` rewritten around them.
- **The model** marks each automation as internal or external.


### ADR-032: Stalled automation work: seen, retried or given up by a person

**Status:** Accepted, 2026-09-29 (Gary, PLAN 15.4). The circuit breaker (below) is deferred, with its place decided.
**Date:** 2026-09-27; decided 2026-09-29

**Context:**
- ADR-031 sends external work to a Temporal workflow named after the to-do item, and Temporal retries it by
  configuration.
- An external automation's item can end in one of three ways:

  | How it ends | Example (the restaurant) | What closes it |
  |---|---|---|
  | **A business answer** | paid; declined | the workflow records our command, and the item closes |
  | **Our side blocked** | Temporal down; a bug in our processor | the dependency returning, or a deploy (ADR-031 fail fast) |
  | **The work stalled**: Temporal gave up, and the outcome is still unknown | Braintree down beyond the retry budget (about 5 minutes); our API keys expired; the SDK needs an upgrade; a bug in a step that outlived the retries; the card charged but recording it failed | **nothing.** No new event arrives, so nothing ever looks at the item again |

- Before this decision, a stalled item stayed open forever and looked exactly like one still in progress. The
  restaurant's order stayed `CREATED`, holding its stock, with the customer waiting (15.3's end-to-end record).
- The third row belongs to any external automation, not only to payments.

**Principle:** no item stays stuck silently. Every open item is either being worked on, or visibly **stalled**, with
its reason, and a person able to act on it.

**Not a stall:** a declined card is a business answer, and the item closes. Paying again needs a new nonce from the
customer (the first is spent), so it's the customer's action from their order, not an operator's retry (ADR-034).

**Decision:**
1. **A stall is recorded as an event named for the business.**
   - The workflow catches its step's final failure. Its last step issues the automation's stall command (the
     restaurant's is *Payment Stalled*), carrying:
     - a **category**: `configuration`, `unavailable` or `unknown` (ADR-034 lists how the restaurant's step decides);
     - the last error's text;
     - the attempt number.
   - That's the failure-as-event practice of Emmett and the book. It isn't a technical event (rejected in ADR-031),
     because it records what happened to the business: the payment couldn't be taken, for now.
   - The to-do list step marks the item `stalled`, with the category and the reason. The screen never asks Temporal
     for business state.
2. **What decides the category is the step, not Temporal.**
   - An error that retrying can fix (network, 429, 5xx) is thrown as it is, and Temporal retries it. If the retries
     run out, the stall's category is `unavailable`.
   - An error that no retry can fix (bad keys, not permitted, SDK too old) is thrown as Temporal's
     `ApplicationFailure.nonRetryable`, with a type. The workflow then gives up **at once**, not after 5 minutes,
     and the stall's category is `configuration`.
   - Anything the step can't classify is retried, and a stall after that is `unknown`.
3. **A person decides: retry or give up.** Both are ordinary write slices, issued from the to-do list's screen.
   - **Retry** (*Retry Payment*) is allowed only on a stalled item. Its event reopens the item and raises its attempt
     number. The automation's processor handles that event like any other: the list step marks the item open, and
     the automation step starts the workflow again.
   - **Give up** (*Give Up Payment*) is allowed only on a stalled item. It records the automation's own failure
     outcome. In the restaurant that's `orderPaymentFailed`, with a reason saying the restaurant gave up and why, so
     the existing Stock Returner gives the stock back and the customer sees the order failed.
   - Both carry the UI's `Idempotency-Key` (ADR-006), so a double click acts once. Neither is allowed on a paid,
     declined or in-progress item: the decider refuses, saying why.
4. **Each attempt has its own workflow id: `<automation>:<key>:<attempt>`.**
   - A stall completes the workflow (the failure is caught and recorded), so a retry can't reuse the same id under
     `REJECT_DUPLICATE`. The attempt number comes from the item, which the retry event raised.
   - A replayed event starts the same id again, which is a no-op (`USE_EXISTING`), as before.
   - Temporal's UI shows every attempt separately.
   - The stall command's idempotency key includes the attempt too (`payment-stalled:<orderId>:<attempt>`), so each
     attempt can stall once.
   - **Retrying never charges twice.** The step's search-first (ADR-034) finds any charge an earlier attempt made,
     including the case where the card was charged but recording it failed. The retry then just records the payment.
5. **The to-do list can be filtered by state.** `GET /<list>/stalled?category=…` is a query read model (ADR-025
   naming), newest first, with the reason and attempt. The operator can quickly find every stalled item, for
   example all those left by one Braintree outage, and retry or give up on them from that screen. A bulk action
   issues one command per item, each with its own idempotency key, so the model stays one command per item.
6. **The administrator is alerted on a stall.** This is an operational signal, not a business event.
   - The kit's `alert({ code, severity, message, details })` port is called by the stall-recording step. It is
     best-effort: the stalled list is the durable record, and the alert only draws attention to it.
   - By default it writes one structured line to the log (`{"level":"alert","code":"payment-stalled",…}`).
   - In the cloud, a log-based alert rule turns that line into an email or a page, with no code of ours.
     Alternatively, an email transport is plugged in behind the port. **Any provider is checked for Isle of Man
     availability first.**
   - `configuration` stalls are `critical`, because a person must act (fix keys, upgrade the SDK). `unavailable`
     and `unknown` stalls are `warning`. Grouping repeated alerts belongs to the alerting service, not our code.
7. **Every external automation gets this pattern by default** (Gary): the `event-model` skill proposes the stall
   event, the stalled state on the list, and the retry and give-up slices. `build-automation` builds them. The
   domain names the events, and decides what giving up means and which errors are which category.
8. **The customer sees the stall** on their order, for example "your payment is delayed", not "pending" forever.
   The screen comes with 15.5.
9. **An automation's failure outcome says what the user can do** (Gary, 2026-09-29). Its event keeps one type
   (every reaction to it is the same), with a structured **`kind`** and the provider's **`code`** beside the
   reason text. The domain defines the kinds; the restaurant's are in ADR-034 (`declined-hard`, `declined-soft`,
   `gateway-unavailable`, `payment-method-unusable`, `abandoned`). A screen then tells the user their next step,
   and a report can separate the provider's declines from our own failures. What the customer can do about a
   decline is ADR-035.

**Deferred, with its place decided: a circuit breaker.**
- **What it would prevent.** During a Braintree outage, every new order is accepted, holds its stock, retries for
  about 5 minutes, and stalls. Temporal makes those retries cheap. The cost is to the business: customers waiting,
  stock held, and a list of stalls to work through.
- **Where it would sit: at the door, not in the processor.** A breaker that paused the Payment Requester would
  stop its list step too (they share one processor, ADR-031). It would also only move the waiting from Temporal to
  the list. The honest place is where the order is placed: "card payments are unavailable right now", before any
  stock is taken.
- **What would feed it:** a gateway-health signal kept like Temporal's health (ADR-033: a background check, runtime
  state, never an event), or the recent stalls of category `unavailable`.
- **Why deferred.** Filtered retry and give-up (5) already make an outage manageable. The breaker is a business
  choice about refusing orders, and needs evidence from a real outage's volume. It's recorded as PLAN 15.4b.

**Alternatives considered:**
- **The UI asks Temporal for each item's status.** Rejected: business state would then depend on the executor
  (ADR-031).
- **The same workflow id with `ALLOW_DUPLICATE_FAILED_ONLY`.** Rejected: a caught stall completes the workflow, and
  a workflow that fails instead of recording its stall would leave the item looking in progress.
- **A timer that sweeps for stalled items.** Rejected: no timers (ADR-030, ADR-031).
- **A dead-letter queue.** Rejected: the stalled list is the visible record (ADR-031).
- **An alert as an automation reacting to the stall event** (its own to-do list, and email through Temporal).
  Rejected for now: it's heavy for an operational nudge, and the stalled list is already the durable record. It
  can be reconsidered if alerts must be guaranteed.

**Known limit:** a workflow **terminated by hand** in Temporal's UI records no stall, so its item looks in progress.
Use *Give Up* instead. The manual says so.

**Who may retry or give up:** anyone who sees the screen, until the kit has real sign-in (PLAN 14.6). It then becomes a
role on both commands.

**Consequences:**
- **The kit:**
  - the workflow template catches the final failure and records the stall;
  - the starter takes the attempt in the workflow id;
  - `alert()` in `src/shared/alerts.ts`, with the console transport;
  - `build-automation` and the `event-model` skill learn the pattern.
- **The restaurant:**
  - *Payment Stalled*, *Retry Payment* and *Give Up Payment*;
  - the stalled state and query on Payments Awaiting;
  - its step classifies Braintree's errors (ADR-034).
- **End-to-end cases 9 onwards** (PLAN 15.4).


### ADR-033: The kit's automation runtime: Temporal on our Postgres, a to-do list processor helper

**Status:** Accepted, 2026-09-28 (PLAN 15.3). Proven once the restaurant domain's two automations have run
through the loop (PLAN 15.3's record).
**Date:** 2026-09-28

**Context:** ADR-031 settles what an automation is: a to-do list and one processor, which runs the list step and
then the automation step for each event. Internal work runs in that processor, and external work runs in Temporal.
The kit had none of the parts. The library's processor now fails fast and says when it's rebuilding (PLAN 15.2).
Temporal's TypeScript SDK (1.24.0) was proven under vitest in a spike (2026-09-28): a worker bundling a `.ts`
workflow ran against Temporal's time-skipping server and against a `temporalio/temporal` dev-server container, and
a second start with the same workflow id returned the same run.

**Decision:**
- **Temporal runs on our Postgres, in `docker compose`.**
  - `temporalio/admin-tools` creates Temporal's own databases (`temporal`, `temporal_visibility`) on the project's
    Postgres server, then `temporalio/server` and `temporalio/ui` start (the UI on :8080).
  - Versions are pinned, following Temporal's `samples-server/compose` (its `auto-setup` image is retired).
- **The worker runs in the API's process.** There's one image and one `npm start`.
  - The worker connects lazily and retries with backoff, so the API still serves when Temporal is down.
  - Meanwhile an automation that needs Temporal blocks its processor (fail fast, ADR-031) and shows it, until
    Temporal is back.
  - **Every call to Temporal has a deadline we set**, `TEMPORAL_CALL_TIMEOUT_MS` (default 5000). Without it, the
    client's own retries (10 attempts, backing off ×1.7) decide: a start failed after about 21 s. With it, a start
    fails at the deadline, naming it, and the processor shows `blocked` then (PLAN 15.3, e2e case 4: 5.1 s).
  - The worker is split into its own process only when load says so.
- **The helper, `defineAutomation`** (`src/shared/automations.ts`):
  - takes the automation's to-do list (a `database-projected` read model), its triggers (the model's `reacts-to`
    events) and its `act`;
  - its processor takes the list's projection name, so the list's bookmark is the automation's progress;
  - for each event it runs the list step. Then, unless the processor is rebuilding and only for a trigger event, it
    reads the item **as it stands now** and calls `act` if the item is open;
  - "as it stands now" is a live fold of that key's events with the list's own definition (`readLive`, ADR-022).
    Once the processor has caught up, that's the list's row. While it catches up on history (a new automation
    deployed onto old events), it differs: the stored row reflects only the events up to this one, so an order paid
    long ago would still look open and be charged again. The live fold already sees the later `orderPaid`. This is
    also how a GIVEN/THEN spec reads ("given the payment was initiated and the order was paid, nothing happens"),
    and the book's to-do list, which is judged on its current state;
  - `act` gets `issue` (our command, with the idempotency key) and `start` (a Temporal workflow);
  - it never catches an error.
- **Keys:**
  - a command's idempotency key is `uuidv5("<automation>:<item key>")`. Before handling it, the helper looks for an
    earlier append under that key or its `:0` variant (commands that record several events);
  - a workflow's id is `<automation>:<item key>`, started with `USE_EXISTING` on conflict and `REJECT_DUPLICATE`
    on reuse. An "already started" error counts as done. A retry after a stall starts a new id with the attempt number (ADR-032, decision 4).
  - **Added 2026-09-29 (PLAN 15.4):** work that can be done again on the same item passes its attempt:
    `issue(decider, command, { attempt })` and `start(type, args, { attempt })` key it `<automation>:<item key>:<attempt>`
    (`workKey`). Without it, a second declined attempt's stock return was silently skipped as a repeat of the first.
  - **`src/shared/alerts.ts`** (ADR-032 decision 6): `alert({ code, severity, message, details })` writes one JSON line to
    stderr, best-effort; a sink can be passed.
- **An external automation's workflow** calls the outside system in an activity, using the provider's official
  SDK.
  - A business answer (paid, declined) is a result, and the workflow issues our command for it through an
    activity, with the idempotency key.
  - A technical error (network, 5xx) is thrown, so Temporal retries it by the workflow's configuration.
  - An answer that arrives later, by webhook, would come in through a translation route. None is proven yet, so
    the skill doesn't teach it.
- **External systems are mocked after the real provider's published API and SDK**, in `mocks/<system>/`: a small
  Node server, a Dockerfile and a compose service.
  - It serves only what our SDK calls, and it answers the provider's documented sandbox test values.
  - The host is config, so pointing at the provider's sandbox or production is a config change.
  - The loop builds the mock in the external automation's job.
- **Tests run Temporal in a container** (a `temporalio/temporal` dev server), reached through
  `@temporalio/testing`'s `createFromExistingServer` (ADR-030: real engines in containers). The time-skipping
  binary isn't used: nothing of ours waits on long timers.
- **`GET /health/processors`** returns every processor's status (`consumer.status()`), so a blocked automation is
  visible now. PLAN 15.4's screen builds on it.
  - With external automations it also reports **Temporal** (`watchTemporal`): `reachable` (`null` until the first
    check), the error, `checkedAt`, and this process's worker (`starting`, `running`, `restarting` with why,
    `stopped`). It's checked in the background every `TEMPORAL_HEALTH_INTERVAL_MS` (default 5000), each check
    within the call deadline (Temporal's `GetSystemInfo`), so health answers at once. Asking on each request made
    health take the whole deadline while Temporal was down (5.5 s a request).
  - Temporal down shows within one interval, whether or not any work is waiting. The worker's own state can say
    `running` through an outage (the SDK keeps polling), so `reachable` is the answer about Temporal itself.

**Why:**
- **Only one new engine.** Everything else is the library's processor, a read model and idempotent appends.
- **The whole system runs locally** (ADR-030). Tests use the same engines as production.
- **A mock that follows the real API** means the code that calls it is the production code. Only the host changes.

**Alternatives considered:**
- **A separate worker process from day one.** Rejected for now: a second entry point and image, with no load to
  justify them.
- **Temporal's time-skipping test server.** Rejected as the default: it's a binary downloaded outside containers,
  and we have no long timers to skip.
- **Our own mock payload shapes.** Rejected (Gary): a real provider's shapes make the example realistic, and make
  the gateway swap a config change.

**Consequences:**
- The scaffold gains Temporal services in compose, the SDK packages, `automations.ts`, `temporal.ts`, the
  automation and Temporal test harnesses, and an `automations` array in `index.ts`.
- The loop's scope check allows `src/workflows.ts` (the worker's workflows; append-only, checked by
  `18-workflows-append-only`), `mocks/<system>/`, and a mock's compose service.
- The export (emcli) queues an automation's job after the jobs for its to-do list and the commands it issues.
- `build-automation` is rewritten around the helper.


### ADR-034: The restaurant domain's payment gateway is Braintree (a commercial directive)

**Status:** Accepted, 2026-09-28 (Gary). A commercial directive, not a technical preference.
**Date:** 2026-09-28

**Context:** PLAN 15.3 mocks the payment gateway after a real provider's API. Stripe was chosen first. Gary's
company is based in the Isle of Man, and Stripe doesn't serve the Crown dependencies (Isle of Man, Jersey,
Guernsey). Gary wants the example domain aligned with a commercial gateway he can actually use. The Isle of Man
developer community recommends Braintree (PayPal).

**Decision:** the restaurant domain pays through **Braintree**, and the gateway mock follows Braintree's API and its
official Node SDK (`braintree`).

**What Braintree changes in the design** (researched 2026-09-28):
- **The card is tokenized in the customer's browser.** Braintree's Drop-in UI, with a tokenization key, turns it
  into a single-use **payment method nonce**, valid for 3 hours.
  - `placeOrder` takes the nonce, and `paymentInitiated` carries it to the Payment Requester, which reads it from
    the trigger event.
  - It isn't card data, and it's dead after use. It never goes on a read model or screen.
- **The sale's answer is synchronous.** `transaction.sale({ amount, paymentMethodNonce, orderId, options: {
  submitForSettlement: true } })` answers with `submitted_for_settlement`, `processor_declined` (a processor text
  such as *Do Not Honor*), `gateway_rejected` or a validation error.
  - The Payment Requester's workflow issues `markOrderPaid` or `markOrderPaymentFailed` itself.
  - Braintree's transaction webhooks cover only ACH and SEPA. There's **no card webhook**, and no translation
    slice.
- **No idempotency key.** The activity combines Braintree's own guards:
  - it searches for a transaction by `orderId` before charging;
  - a nonce can be used once;
  - duplicate checking (on by default: the same amount, order id and card within 30 s → `gateway_rejected`).

  A duplicate or "nonce already used" rejection means searching again, not a decline, **while that search can still
  find our own charge**. A "nonce already used" with nothing for this order after a few attempts (3; search may lag
  behind a charge) means the nonce was spent on something else: a decline, "payment method already used", so the
  order's stock goes back. Retrying it forever would hold the order and its stock until the workflow gave up (found
  by 15.3's end-to-end case 7, a real nonce used on two orders).
- **The amount** is a decimal string (`"12.00"`), as in our model. The currency comes from the merchant account.
- **The mock** answers the sandbox's documented test nonces (`fake-valid-nonce`,
  `fake-processor-declined-visa-nonce`, …), and the model's scenarios use them.

**Added 2026-09-29 (PLAN 15.4, ADR-032): how the payment step reads Braintree's failures.** Taken from the Node SDK
(`braintree` 3.40.0: `http.js` maps HTTP status codes to errors; `validation_error_codes.js`; `transaction.js`),
then **checked against Braintree's sandbox** the same day (restaurant-orders `e2e/sandbox-probe.mjs`; its results
are in that project's `e2e/README.md`). A decline's `kind` and Braintree's `code` go on `orderPaymentFailed` (below).

| What happened | How Braintree says it (sandbox-checked ✅) | The step's answer | `kind` |
|---|---|---|---|
| Charged | `result.success` ✅ | paid | |
| Hard decline (expired card, closed account) | `processor_declined`, `processorResponseType` **`hard_declined`** (2004 Expired Card) ✅ | declined, with Braintree's text and code | `declined-hard`: another card is needed |
| Soft decline (insufficient funds, Do Not Honor) | `processor_declined`, **`soft_declined`** (2001, and 2000) ✅ | declined; the same card may work later | `declined-soft` |
| A gateway rule | `gateway_rejected` for `avs`, `cvv`, `fraud`, `risk_threshold`, `three_d_secure` | declined | `declined-hard` |
| Card network unavailable | status **`failed`**, code **3000**, `soft_declined` ✅ | declined as "card payments couldn't be completed, please try again", **not as the card's fault**. The failed sale **spends the nonce** ✅, so only the customer can try again | `gateway-unavailable` |
| Nonce already used | validation **91564** ✅ (not 93107, the PaymentMethod API's code, which the step first checked) | search again; decline after 3 attempts, "payment method already used" | `payment-method-unusable` |
| Nonce unknown or expired (after 3 hours) | validation **91565** ✅ | declined, "please pay again" | `payment-method-unusable` |
| Keys wrong or expired | `AuthenticationError` (HTTP 401) ✅ | retried up to `PAYMENT_GATEWAY_AUTH_ATTEMPTS` (default 3), then `ApplicationFailure.nonRetryable` type `PaymentGatewayAuthentication`: stalls, `configuration` | (a stall, not a decline) |
| Not permitted (merchant account suspended, a feature off) | `AuthorizationError` (403); merchant-account validation codes | as a 401, type `PaymentGatewayAuthorization` | (a stall) |
| SDK too old | `UpgradeRequired` (426) | non-retryable at once, `PaymentGatewayUpgradeRequired`: `configuration` | (a stall) |
| Braintree busy or down | `TooManyRequestsError` (429), `ServerError` (500), `ServiceUnavailableError` (503), `GatewayTimeoutError` (504) | thrown; Temporal retries; `unavailable` if the retries run out | (a stall) |
| The network (refused, reset, DNS, timeout) | `UnexpectedError`, "Unexpected request error…" / "Request timed out" | thrown and retried. The charge may have gone through, and the search-first finds it | (a stall) |
| Anything else | | thrown and retried; `unknown` if the retries run out | (a stall) |
| The restaurant gave up on a stall (ADR-032) | | `orderPaymentFailed` by *Give Up Payment* | `abandoned` |

- **The failure event carries `kind` and `code`** (Gary, 2026-09-29). `orderPaymentFailed` keeps one event type,
  because the Stock Returner and the kitchen react the same way to every failure. But the customer's next step
  differs by `kind` (another card; the same card later; try again; pay again; the restaurant's fault). The order's
  screen and any reporting (decline rate against our own failures) read it from `kind`. `code` is Braintree's
  (`2004`, `3000`, `91564`, …) and `reason` stays the text.
- **A 401 or 403 is retried a few times first, in every environment** (Gary). The sandbox's authentication proved
  unreliable: a wrong private key was sometimes accepted, and correct keys once got a 401. Production may have a
  brief one too, for example while switching to new keys. Retrying a truly bad key costs about 3 s before the
  stall and the critical alert; not retrying a passing 401 stalls a good payment and raises a false alert. One
  behaviour everywhere, so the production path is the tested path. `PAYMENT_GATEWAY_AUTH_ATTEMPTS` can be set to 1
  where brief auth failures are proven not to happen. Branching on the environment was rejected for that reason.
- **The merchant account sets the currency**, not the sale. The restaurant's sandbox account began in EUR; a GBP
  merchant account was added, and the step passes `BRAINTREE_MERCHANT_ACCOUNT_ID` on every sale, so the currency is
  chosen, not the account's default.
- **Braintree's duplicate check covers the retry budget:** its window is set to 600 s (the default is 30), longer
  than a payment's retries (about 5 minutes). The search before every charge remains the main guard. Where each
  setting is in the control panel: the manual, §21.7.
- **Our deadline, not the SDK's.** The SDK waits 60 s by default (`config.js`), longer than the activity's
  30 s `startToCloseTimeout`. The gateway is configured with `BRAINTREE_TIMEOUT_MS` (default 20000), below it.
- **The mock follows the sandbox's test amounts.** The amount decides the answer: 2000.00–2999.99 give a processor
  decline with that code and its soft/hard type, and 3000.00 gives a `failed` 3000. It answers 91564 and 91565 as
  the sandbox does. Switches give 401, 403, 426, 429 and 5xx, so every row can be reached end to end.

**Why:** examples should match providers the business can contract, so the demo code is usable for real. It's also a
simpler design: a synchronous answer needs no webhook and no signal.

**Alternatives considered:**
- **Stripe.** It has an `Idempotency-Key` header and signed webhooks. Set aside because it isn't available in the
  Crown dependencies.
- **Paddle.** It's checkout-only (the customer pays on Paddle's page) and documents no idempotency key. Set aside.

**Open:** Gary confirms Braintree's availability for an Isle of Man merchant account with Braintree. Third-party lists
include the Isle of Man, Jersey and Guernsey, but Braintree's own country page couldn't be read.

**Consequences:**
- A 15.1 model amendment: `paymentMethodNonce` on `placeOrder` and `paymentInitiated`; the Payment Requester
  relates-to `markOrderPaid` and `markOrderPaymentFailed`; the gateway lane's `paymentReceived` and the *translate
  payment result* slice are removed.
- ADR-032 gains a point: paying again after a decline is the customer's action, with a new nonce.
- Any later third-party provider is checked for Isle of Man availability first.


### ADR-035: The customer pays again after a decline

**Status:** Accepted, 2026-09-29 (Gary, PLAN 15.4c), **for the restaurant demo** (ADR-036). A digital-products shop
leaves all of this to its merchant of record's checkout.
**Date:** 2026-09-29

**Context:**
- A decline is a business answer (ADR-032). The order is `PAYMENT_FAILED` and its stock has gone back.
- Often the customer can do something about it:
  - use another card (`declined-hard`);
  - add funds and use the same card (`declined-soft`);
  - simply try again (`gateway-unavailable`);
  - enter the card again (`payment-method-unusable`).
- Every sale that reached the bank spent its nonce (Braintree's sandbox, 2026-09-29). Paying again always needs a
  new nonce from the customer's page. Gary: when something is actionable, the customer gets another chance.
- **Braintree's browser UI, researched 2026-09-29:**
  - **Drop-in is deprecated from 1 October 2026:** no fixes after that, and unsupported (processing may stop) from
    1 October 2027. Braintree says to move to its JavaScript SDK (`braintree-web`).
  - **Hosted Fields** (in `braintree-web`) are Braintree-hosted iframes for the card number, expiry, CVV and postal
    code, styled by us, and eligible for PCI SAQ A (the lightest). Not deprecated.
  - **No official React component for card entry.** `@paypal/react-paypal-js` has `BraintreePayPalButtons` (the
    PayPal button only). The community wrappers (`braintree-web-drop-in-react`, `react-braintree-fields`) are
    unofficial and unmaintained.
  - **Neither UI knows about our decline.** Our charge runs on the server later, in the Payment Requester's
    workflow, so the page learns the answer from the order (its status, `kind` and reason), not from Braintree's UI.

**Decided (Gary, 2026-09-29): paying again takes the stock afresh.** A declined order's stock has already gone back,
and a customer whose card is accepted meanwhile has priority. Holding stock for a declined customer would need a
hold that expires, which is a timer (rejected, ADR-030). If the dish has sold out, the customer is told so plainly.

**Decided (Gary, 2026-09-29), after comparing Amazon ("Payment revision needed": the same order, retry or change
the payment method) and food delivery (the basket kept, another card chosen):**
- **The same order.** Paying again is a command on the declined order (*Pay For Order Again*, with a new nonce).
  - It keeps the order's id, dishes, total and history.
  - It records `paymentInitiated` (attempt n) and `stockDeducted` under the ordering rules. A sold-out dish is
    refused by name, and the customer can cancel or order again without it.
- **Every attempt is shown on the order, newest first:** the card (type and last four digits, taken from
  Braintree's transaction; `card` on `orderPaymentFailed`), the `kind`, and the reason. From that, the customer
  knows whether to change card or add funds.
- **The message and actions follow `kind`:**

  | `kind` | Message | Actions |
  |---|---|---|
  | `declined-hard` | another card is needed | pay with another card; cancel |
  | `declined-soft` | add funds or use another card | pay again; cancel |
  | `gateway-unavailable` | not charged; try again | try again; cancel |
  | `payment-method-unusable` | enter the card again | enter card; cancel |
  | `abandoned` | our problem, not charged | pay again; cancel |
  | a stall | taking longer than usual; nothing to do | none |

- **At most 5 payment attempts per order** (against card testing). After that, the order offers only *Cancel* and
  "please contact the restaurant".
- **The customer can cancel** an order that is awaiting payment (*Cancel Order*), but not while a payment is in
  progress or stalled.
- **No time limit on an unpaid order.** It holds no stock, so no timer is needed.
- **Stock goes back at a decline, on purpose, to show a compensating action.** The real-world best practice is
  Amazon's: hold the stock for a limited time while the customer revises payment. It is **deliberately not
  followed** in this demo.
- **The order page follows the order live** through the event feed.

**Leaning:**
- **Card entry uses Hosted Fields**, wrapped in one small React component of the kit's (`CardFields`: create on
  mount, `tokenize()` → nonce, tear down on unmount), not Drop-in and not a community wrapper. We lean on Braintree
  for the card fields, their validation and 3D Secure; we own only the component around them.
- **The order's screen shows the decline by `kind`,** with the next step in plain words, and a *Pay again* action
  where one is possible (not for `abandoned`, which the restaurant decided).
- **Pay again** is a command on the same order (e.g. *Retry Order Payment* with a new nonce). It takes the stock
  again under the same rules as placing an order, and starts a new payment attempt (ADR-032's attempt-numbered
  workflow id). **Alternative:** a new order with the same dishes, which reuses `placeOrder` whole but loses the
  order's history.

**Open:** where the card component lives in the kit's `web/` (15.5).


### ADR-036: Selling digital products: a merchant of record with a hosted checkout (the restaurant stays a demo)

**Status:** Accepted, 2026-09-29 (Gary): **Paddle**, with Dodo Payments as the alternative (PLAN Phase 16). Conditions
still to confirm with Paddle: onboarding as an Isle of Man business, the fee at Gary's price, and payout in GBP.
The product is a web app sold as a subscription with seats, so Paddle's quantity-based seats fit, and seat
assignment is our own domain logic.
**Date:** 2026-09-29

**Context:**
- **How the scope grew.** The aim was to invest in the `build-automation` skill. That grew into Temporal as the
  workflow engine, and then into calling a payment provider ourselves.
- **Why Braintree, and what it cost us.** Braintree was chosen on a fellow engineer's recommendation, for its Isle
  of Man availability (ADR-034). It is a gateway for merchants who build their own checkout. So we took on the
  charge in our own workflow, searching before charging, reading declines by kind, our own card component,
  "pay again", and duplicate handling (ADR-032 to ADR-035).
- **What Gary actually needs.** He will most likely sell **digital products**: no stock, no reservation, nothing
  to return.
- **What software vendors typically do.** They use a **hosted checkout from a merchant of record (MoR)**. The MoR
  is the legal seller, so it handles:
  - card entry, 3D Secure, and declines, where the customer tries another card inside its checkout;
  - fraud, receipts, refunds and chargebacks;
  - **sales tax and VAT everywhere**, which matters for digital goods sold to UK and EU consumers.

  It then tells us by signed webhook that the product was paid for, and we deliver it.

**Decision (Gary, 2026-09-29):**
- **The restaurant is a demo.** It shows automations, Temporal, compensating actions (stock returned) and
  redriving stalls: the kit's teaching example.
  - It is **rounded out, not extended**.
  - It is labelled a demo in the manual and PLAN: "not how a digital-products vendor would take payments".
  - It deliberately returns stock at a decline, to show a compensating action. The real-world best practice,
    Amazon's time-limited reservation while the customer revises payment, is not followed.
- **Digital products use an MoR with a hosted checkout.** Its integration is small:
  - *start checkout*: open the MoR's checkout in the page;
  - *payment completed*: the webhook, translated into our event (a translation slice);
  - *fulfil the order*: an automation that delivers the licence or download.

**The providers, researched 2026-09-29** (Gary's criteria: Isle of Man availability, merchant of record, tax,
webhooks, fees, React-based UI support):

| Provider | Isle of Man seller | MoR and tax | Checkout UI and React | Webhooks | Fees (published or reported) | Notes |
|---|---|---|---|---|---|---|
| **Paddle** | ✅ Paddle supports sellers everywhere except a sanctions list, and the Isle of Man isn't on it ([help](https://www.paddle.com/help/start/intro-to-paddle/which-countries-are-supported-by-paddle)) | ✅ MoR; global sales tax and VAT included | ✅ overlay or **inline** checkout (Paddle.js, npm `@paddle/paddle-js`, typed); an **official Next.js/React starter kit** ([PaddleHQ/paddle-nextjs-starter-kit](https://github.com/PaddleHQ/paddle-nextjs-starter-kit)); page events such as `checkout.completed` and `checkout.payment.failed`. The customer retries a decline inside Paddle's checkout | ✅ signed; `transaction.completed`, `transaction.payment_failed`; a webhook simulator | 5% + 50¢ per transaction, all-in (the 50¢ weighs on cheap items) | Established (since 2012); sellers of software and digital products are reviewed at onboarding |
| **Dodo Payments** | ✅ explicitly listed, with Jersey and Guernsey ([accepted countries](https://docs.dodopayments.com/miscellaneous/accepted-countries-and-territories)) | ✅ MoR; tax in 190+ jurisdictions | ✅ overlay and inline checkout SDK with React support ([overlay checkout](https://docs.dodopayments.com/developer-resources/overlay-checkout)) | ✅ `payment.succeeded` and others | about 4% + 40¢ (reported; to confirm) | Young company (2024); less track record |
| **Freemius** | ✅ listed ([supported countries](https://freemius.com/help/documentation/selling-with-freemius/supported-countries/)) | ✅ MoR | a JavaScript checkout; no official React component found | ✅ | around 7% (reported) | Built for WordPress plugins and SaaS; narrower fit |
| **FastSpring** | not confirmed ("anywhere in the world" in its marketing) | ✅ MoR | popup checkout, no-code links; no official React component found | ✅ | about 5.9% + 95¢ (reported); fees kept on refunds | Established; higher cost |
| **Lemon Squeezy** | ❌ not in its bank-payout list ([supported countries](https://docs.lemonsqueezy.com/help/getting-started/supported-countries)) | ✅ MoR | overlay checkout | ✅ | 5% + 50¢ | **Acquired by Stripe** (July 2024, not PayPal). Sellers are being moved to Stripe Managed Payments ([2026 update](https://www.lemonsqueezy.com/blog/2026-update)), which runs on Stripe, and Stripe doesn't serve the Isle of Man |
| **Polar** | ❌ not listed; payouts via Stripe Connect Express ([supported countries](https://polar.sh/docs/merchant-of-record/supported-countries)) | ✅ MoR | checkout links and an embed | ✅ | 5% + 50¢ (reported) | |
| **Stripe Managed Payments** | ❌ Stripe doesn't serve the Crown dependencies | ✅ MoR | Stripe's | ✅ | | |
| **PayPal Checkout** | ✅ PayPal serves the Isle of Man | ❌ **not an MoR**: we remain the seller, and VAT is ours | ✅ official React components (`@paypal/react-paypal-js`), PayPal's buttons and card fields | ✅ | PayPal's rates | See below |
| **Braintree** (ADR-034) | ✅ in use | ❌ not an MoR | Hosted Fields; no official React component; Drop-in deprecated from 1 October 2026 | card sales answer at once; no card webhook | Braintree's rates | What the restaurant demo uses |

**PayPal Checkout and Braintree: the difference.** Both belong to PayPal, and neither is a merchant of record:
- **Braintree** gives us our own merchant account and a gateway to integrate: we build the checkout (ADR-034).
- **PayPal Checkout** is PayPal's own quicker product: its buttons and card fields, where PayPal is the processor.

Either way the business stays the seller, and VAT on digital goods is ours to handle. That's why neither is the
leaning for digital products.

**The stack stays a client-side React SPA** (Gary asked, 2026-09-29, whether Paddle's Next.js starter means moving to
Next.js with SSR):
- Paddle.js (`@paddle/paddle-js`) is a browser library, so its checkout runs in our Vite React SPA. The starter is a
  reference only, and its server parts (the webhook, creating a checkout, reading a subscription) are our backend's
  slices.
- SSR needs a running server, so it would rule out plain S3 hosting. Next.js's static export works on S3, but
  without SSR or API routes. A logged-in app gains little from SSR, so the SPA stays on S3 and CloudFront (14.8).

**Why Paddle:**
- it meets every criterion, including the Isle of Man;
- it has the most established MoR track record;
- its official React starter kit gives the most UI leverage;
- its checkout handles declines, 3D Secure and retries itself, which removes ADR-035's customer-side work
  outright.

Dodo Payments is the alternative: it explicitly lists the Isle of Man and its fees are lower, but it's younger.

**Subscriptions, seats and licences (researched 2026-09-29; Gary's most likely model: a customer subscribes for a
number of seats for its employees, alongside one-off purchases):**

| | Paddle | Dodo Payments |
|---|---|---|
| One-off payments | ✅ | ✅ |
| Subscriptions | ✅ Paddle Billing: trials, pause, cancel, one-time charges on a subscription ([subscriptions API](https://developer.paddle.com/api-reference/subscriptions/overview)) | ✅ monthly, annual and custom intervals; free or paid trials ([subscriptions](https://docs.dodopayments.com/features/subscription)) |
| Seats | ✅ the **quantity** of a subscription item; changing it is prorated (`proration_billing_mode`); multi-seat plans plus add-ons. The customer portal changing quantities is claimed in marketing, not yet confirmed in the docs. Quantity can't change during a trial | ✅ **add-ons** with quantities (up to 10 per product); four proration modes. Seat changes go through our UI and the API, not the customer portal |
| Failed renewals | ✅ automatic retries, recovery (Paddle Retain) | ✅ retries and dunning, an optional grace period (`past_due` for 1–30 days), then `on_hold` |
| Licence keys | ❌ **not built in** (Paddle Billing): we generate and verify them on `transaction.completed`, ourselves or with Keygen ([Keygen + Paddle](https://keygen.sh/integrate/paddle/)) | ✅ **built in** ([license keys](https://docs.dodopayments.com/features/license-keys)): one key per seat (`subscriptions.quantity`), valid while the subscription is active and disabled when it ends; a seat change disables the old keys and issues new ones; an activation limit per key; public activate, validate and deactivate endpoints (no secret key), meant for desktop apps and plugins |
| Lifecycle webhooks | ✅ subscription and transaction events | ✅ `subscription.active`, `renewed`, `past_due`, `on_hold`, `plan_changed`, `cancelled`, `expired` |

- **Which seat model matters.**
  - **A web app:** a seat is a user in our system. The provider bills for the quantity, and **assigning seats to
    employees is our own domain logic** (invite, assign, revoke, limit to the quantity). That is a good fit for
    event modelling, and both providers serve it equally. Paddle's older platform and track record count for more
    here.
  - **Installed software (desktop, plugins):** Dodo's built-in per-seat keys and activation limits save building
    a licence server. With Paddle we'd add Keygen or our own.
  - One caveat for Dodo: a seat change **reissues every key**, so each employee must enter a new key. That's
    awkward for a team product; to test.
- **So the leaning holds, with a condition:** **Paddle** for a web app with seats, or **Dodo** if the product is
  installed software needing licence keys. To settle in 15.4d once Gary knows which kind of product he'll sell.

**To confirm before Accepted:**
- Gary's onboarding with Paddle, as a business in the Isle of Man selling his kind of digital product;
- the fee on his typical price, because the fixed 50¢ weighs on cheap items;
- payout to an Isle of Man bank account in GBP.

**Consequences:**
- ADR-035 (the customer pays again) applies to the demo only. An MoR's checkout does this for a digital-products
  shop.
- The kit gains a **hosted-checkout pattern** for `build-automation`:
  - a translation slice for the MoR's signed webhook;
  - a fulfilment automation, internal or through Temporal.
- Stall and redrive (ADR-032) still apply to fulfilment's outside calls.
- ADR-034 stays: Braintree for the restaurant demo.



### ADR-037: The licensing model: seats bought by an organisation and assigned to people, with roles alongside

**Status:** **Accepted, 2026-09-30 (Gary).** Decisions 1–5 and 8 as written, with decision 2 revised for roles (admin
and engineer; the owner controls billing; admins invite); decision 6 (trials) after the sandbox tests in 16.2b;
decision 7 with the 14-day grace period, whose Paddle setting can only be checked in the live dashboard (the sandbox
has no Payment Recovery). **Seat types** (web portal and mobile, priced differently) are recorded
below, with Gary's answers. Accepted decisions feed the model (16.3).
**Date:** 2026-09-30

**Context:**
- **The licensing model is ours** (PLAN Phase 16). Paddle bills a **quantity** of seats, and takes the payment, the
  tax and the declines (ADR-036, `docs/case-studies/paddle.md`). Who may use the app is our own domain.
- **The vendors fall into two families** (`docs/case-studies/seat-licensing.md` §1):
  - **A, seats follow membership** (Slack, Linear, Notion, GitHub): every member is billed, and there's no limit;
  - **B, seats are bought and then assigned** (Figma, Zoom, Polar): the customer buys N seats, and admins give
    them to people.
- **Polar**, a merchant of record with seats built in, is B. It separates the customer (who pays) from members
  (who use), with pending, claimed and revoked seats.

**Decision:**

1. **Family B: an organisation buys seats, and its admins assign them to people** (roles are separate, decision 2).
   - The seat count is Paddle's subscription quantity. Assigning a seat is ours alone and never calls Paddle.
   - **The seat count we enforce is the one Paddle confirms** (`paddle.md` §8), so a failed charge never gives
     seats away.
2. **Roles: admin and engineer; seats: web and mobile. Roles and seats are separate** (Gary, 2026-09-30; separated
   2026-10-01). The roles become the sign-in roles when authentication is built.
   - **A role says what someone may do; a seat (licence) says whether they may use the web portal or the mobile
     app at all.** They're assigned and released separately, and can change at different times.
     - An admin works in the web portal, so normally needs a web seat.
     - An engineer works in the mobile app, so normally needs a mobile seat.
   - **Access** = a role, **and** a seat of the matching type, **and** a subscription in good standing. A read model
     works this out; no event records it.
   - **Only assigning a seat needs a free one** (of its type). Assigning a role uses no seat.
   - **A person can hold several roles and both seat types** (admin and engineer, web and mobile), each seat paid
     for. Each role and each seat is its own assignment.
   - **Seat events:**
     - `seatWasAssigned`: `organisationId` (id), `userId`, `seatType`, `assignedAt`, `assignedBy`, `actedAs`;
     - `seatWasReleased`: `organisationId` (id), `userId`, `seatType`, `releasedAt`, `releasedBy`, `actedAs`.
   - **Owner is a role** (Gary, 2026-10-01; replaces "a mark on one admin"): `roleId: owner`, recorded with the
     generic role events below.
     - **It grants billing and uses no seat:** checkout, buying and removing seats, the payment method, cancelling.
       Billing isn't the licensed product, and the owner needs it **before any seat exists** (Paddle's checkout comes
       before the subscription).
     - **It's assigned when the organisation is activated,** by the system, to the person who activates it
       (`organisationWasActivated.activatedBy`). To use the web portal, the owner is also an admin with a web seat,
       assigned when the subscription starts.
     - **Exactly one owner per organisation.** The owner role can't be removed except by handing it over, and the
       new owner must already be an admin.
     - **A hand-over uses the generic role events** (Gary): one command records `userWasRemovedFromRole` (owner, the
       old owner) and `userWasAssignedToRole` (owner, the new owner) **together, in one append**, so there are never
       zero or two owners. There's no separate hand-over event. The old owner keeps their other roles and seats.
   - **Only the owner controls billing** (Gary, 2026-09-30): buying and removing seats, the payment method, and
     cancelling. So no one else can run up the bill.
   - **Admins invite people and assign bought seats** (Gary, 2026-09-30). Invitations spend nothing, because they
     use seats already paid for, so the owner isn't the only way to add an engineer. When the seats run out, the
     offer to add more goes to the owner (decision 4).
   - **Later roles and seat types fit the same pattern:** they're values in the same events, not new events.
   - **Two generic events for every role** (Gary, 2026-10-01): `userWasAssignedToRole` and `userWasRemovedFromRole`,
     never one event per role.
     - They carry `organisationId` (their id), `userId`, `roleId`, then `assignedAt` / `removedAt`, `assignedBy` /
       `removedBy`, and `actedAs` (customer, platform or system).
     - **No `seatType`** (Gary, 2026-10-01): a seat is a separate concept with its own events (above). This replaces
       the earlier choice to record the seat on the role event.
     - An automation's own actions (the owner's admin role and web seat when the subscription starts; an accepted
       invitation's roles and seats) are `actedAs: system`.
   - **Roles and the auth system** (Gary, 2026-10-01):
     - **Licensing decides admin and engineer,** and the seats. Seats are checked against what's been bought, and
       roles are part of the same membership story. If the auth system were the source, roles and seats could drift
       from what licensing allows and bills.
     - **Auth follows.** An automation sets the matching role in the auth system, which only enforces sign-in. Its
       "role assigned" and "role removed" are side effects, downstream, as with Paddle.
     - **Signing up is auth's event.** Licensing reacts to it (activating an organisation, accepting an
       invitation). Auth's events sit in their own lane as external events, named neutrally until an auth provider
       is chosen, then translated like Paddle's.
     - **The platform admin is auth only:** it uses no seat and belongs to no organisation.
     - **Registration on first visit, with no provider hook** (Gary, 2026-10-01):
       1. the person signs up on the provider's own page, then comes back to our app with a token (OIDC with
          PKCE);
       2. "Get Started" sends `registerUser`, whose `sub` and `email` come from the token, which our backend's
          single token check verifies against the provider's JWKS (issuer, audience, expiry, `email_verified`);
       3. that check is the only auth-aware code, the same for every OIDC provider.

       There's no Cognito Lambda or Supabase hook, and no registration is lost: a failed call is simply sent again,
       made safe by "one user per `sub`" (`sub` is the command's tag). Until Gary chooses Cognito or Supabase Auth,
       **`mock-oauth2-server`** (a container, ADR-030) stands in, for building and for the end-to-end journey.
     - **Our own user, linked by `sub`** (Gary, 2026-10-01):
       - auth's sign-up carries `sub` (the auth system's permanent id for the person) and the email;
       - an automation then records our own `userWasRegistered`, with our `userId` and the `sub`;
       - every licensing event refers to `userId`, never `sub`, so changing auth provider changes only that link,
         and our own properties (name, phone, …) extend our user;
       - **one user per `sub`**, so a repeated sign-up notification registers no one twice;
       - `sub` is unique only within one sign-in provider: if more than one is ever accepted, the link carries the
         provider too;
       - platform staff are users as well, in no organisation.
     - **The owner is whoever holds the owner role:** given at activation, and moved only by a hand-over (above).
       There's no `ownerId` on the organisation.
   - No billing-only role for now: it's a later addition if a customer asks.
3. **An invitation holds its seats while it's pending,** as with Polar and GitHub Team.
   - **It names what it offers** (Gary, 2026-10-01): `memberWasInvited` carries `roleIds` and `seatTypes` (lists),
     with `email`, `invitedBy`, `invitedAt`, `expiresAt` and `actedAs`. It needs a free seat of each type offered.
   - **Accepting it** (`invitationWasAccepted`) **assigns what it offered automatically:** an automation records one
     `userWasAssignedToRole` per role and one `seatWasAssigned` per seat type (`actedAs: system`).
   - Withdrawing it, or letting it expire, frees its seats. `invitationHasExpired` repeats the `roleIds` and
     `seatTypes`, so the history shows what was freed.
   - It lasts **7 days** and can be sent again.
   - **Expiry is a recorded event** (Gary, 2026-10-01): an unanswered invitation is recorded as having expired after
     7 days, rather than being worked out from its date each time. That frees its seat, shows in the organisation's
     history, and lets the admin who sent it be told. **A workflow started with a delay records it** (revised
     2026-10-02, ADR-042; it was a scheduled automation that scans for invitations past their date): sending the
     invitation starts a workflow due at its `expiresAt`, which records the expiry only if the invitation is still
     open.
   - **The 7 days are a configured value** (Gary, 2026-10-02): `invitationExpiryWasConfigured`, projected to
     `LicensingSettings`, as the grace period is (ADR-041).
4. **At the limit, assigning a seat is blocked,** with an offer to add seats, made to the owner.
   - Adding seats is our screen: Paddle's preview first, then the update with `prorated_immediately`.
   - **Which Paddle answer confirms a seat change** (Gary, 2026-10-01):
     - **Our own changes:** Paddle's reply to our update. The update only returns once the charge succeeds, so the
       automation that made it records the new seat count straight away.
     - **Changes made outside our app** (in Paddle's dashboard, for example by our team): Paddle's
       `subscription.updated` webhook, translated into the same event, so the count we enforce never drifts from what
       Paddle bills.
     - The webhook for our own change then matches the count already recorded, so it records nothing new.
   - Figma-style requests and automatic purchase are left for later.
5. **Removing seats takes effect at the next billing period** (Gary, 2026-10-01; replaces "at once, with Paddle's
   credit"):
   - **No credit:** the customer keeps the seats they've paid for until the renewal.
   - **Paddle is updated at once with `do_not_bill`,** so its quantity drops with no credit or charge, and the next
     renewal bills the lower number. Nothing has to be timed to land before the renewal. *(To confirm in the
     sandbox, PLAN 16.4: `do_not_bill` on a decrease outside a trial.)*
   - **We record `seatDecreaseWasScheduled`** (per seat type, the new count, effective at the renewal). Our
     enforced count keeps the paid-for number until then.
   - **The renewal applies it, with no timer:** `subscriptionWasRenewed` (from Paddle's completed renewal) is the
     trigger, and `seatsWereRemoved` records the lower count.
   - **While it's pending:** the decrease can't be scheduled below the seats in use (assigned or held by
     invitations), and no seat can be assigned beyond the new count. People are released first, by an admin; a seat
     change never changes anyone's roles or seats.
   - **The owner can withdraw it before the renewal:** the quantity is put back in Paddle (`do_not_bill`), and
     `seatDecreaseWasWithdrawn` records it.
6. **Trials: a free trial with a card, 14 days** (Gary, 2026-09-30, after the sandbox tests in 16.2b):
   - **Through Paddle's checkout at £0, with the card saved.** At the end Paddle charges automatically and the
     subscription becomes active. A trial is treated as active, with a banner showing its end date.
   - **The trial starts with both seat types,** at least 1 web seat (the owner) and at least 1 mobile seat. Paddle
     requires it: a trial can't add or remove items, every item on it must share the same trial period, and a
     price's minimum is 1 seat (a minimum of 0 is refused). So every seat price has a 14-day trial version, and the
     mobile seats can be removed after the trial if the customer wants none.
   - **Seat numbers can change during the trial at no charge** (`do_not_bill`, the only mode Paddle allows then).
   - **The trial is free** (Gary, 2026-10-01). Nothing is charged for the trial period. The first bill is taken when
     the trial ends and pays for the **first period after the trial**, in advance, as every later renewal does.
     **It's for the seats held when the trial ends** (confirmed in the sandbox 2026-10-01: £36 for 2 web + 2 mobile
     after web went 1 → 2 during the trial, not the £24 shown at checkout), and our trial screen says so.
   - **A trial is offered, not required** (Gary, 2026-10-01): "Choose How to Start" offers a 14-day free trial or
     **"Buy now"**, which uses the standard prices, is charged at checkout, and makes mobile seats optional. One
     translation names the start from Paddle's status: `trialing` → `trialWasStarted`, `active` →
     `subscriptionWasStarted`. "Buy now" also serves an owner subscribing again, with no second trial.
   - **The trial has events of its own** (Gary, 2026-10-01), so Paddle's ambiguous events have context, and so we
     know who's trialing and how many convert:
     - `trialWasStarted`, then `trialWasConverted`;
     - **or `trialWasCancelled`:** the owner cancels during the trial, access lasts to its end, and nothing is
       charged;
     - **or `trialConversionFailed`:** the first charge fails, then the 14-day grace, then converted or ended.

     The numbers (trialing now, converted, cancelled, failed to convert, conversion rate) are a `TrialFunnel` read
     model for the platform admin, never counts on events.
   - **The conversion has no event of its own:** Paddle sends `subscription.activated` (the same as a recovery)
     and a `subscription_recurring` transaction (the same as a renewal). The translation records
     `trialWasConverted` when our organisation is still trialing.
   - **Trial seats are capped** (our rule; Paddle has none), so a trial can't grow to hundreds of seats and then be
     billed for them. **The cap values are configuration, to be set later.**
   - **Not chosen:** a cardless trial (easier to start, but fewer convert, we'd have to chase a card before day 14,
     and Paddle still calls it early access), and our own trial outside Paddle (we'd keep the clock and handle
     conversion, which this ADR avoids).
7. **A failed renewal: a 14-day grace period** (Gary, 2026-09-30; Paddle's settings to confirm in 16.2b):
   - **full access while `past_due`**, with a banner for owners and admins linking to Paddle's page to update the
     payment method, as Paddle recommends;
   - **Paddle's recovery window is set to 14 days**, and at its end Paddle **cancels** rather than pauses, so that
     there's one way to end. Then every seat's access ends together: a failed renewal ends the subscription, it
     doesn't take seats away one by one;
   - **Paddle keeps the time, not us.** We keep no timer of our own: `past_due` means access with a banner,
     `canceled` means access ends, and a recovered payment clears the banner;
   - **why 14 days:** most failed renewals recover in the first week (Paddle's retries and emails fall on about days
     1, 3, 5 and 7), and a replacement card arrives in 7–10 days. Paddle's default of 30 days would give a lapsed
     team a month free;
   - **yearly plans could have 30 days** (more money at stake, and a finance team may need to approve a new card),
     but only if Paddle allows a window per plan. Otherwise 14 days for everyone;
   - **seat changes are blocked while `past_due`** (proposed), until the payment recovers.
8. **After cancellation:**
   - access ends at the paid period's end (`scheduled_change.effective_at`);
   - the organisation and its data are kept, and owners can still sign in to subscribe again;
   - how long data is kept is Gary's decision (terms and privacy), not the model's.

**Seat types: web portal and mobile (Gary, 2026-09-30):**
- **The requirement:** the platform will have web portal users and mobile users, and **the two kinds of seat cost
  different amounts**.
- **Why it's in the model from the start:** a seat's type is part of the model's events (seats bought, a seat
  assigned), so it's cheap to include now and costly to add to recorded events later. Prices can wait.
- **Every seat rule applies per type:**
  - an organisation buys a number of web seats and a number of mobile seats;
  - assigning a seat names its type, and is blocked when that type's seats are all taken (decision 4);
  - removing seats can't go below that type's seats in use (decision 5);
  - an invitation holds a seat of the type it offers (decision 3).
- **Gary's answers (2026-09-30):**
  - **The two are separate.** A web seat doesn't include mobile use.
  - **One person can hold both,** a web seat and a mobile seat, and the customer pays for both.
  - **At least one web seat, always.** Much of the platform's configuration is done in the web portal. So a
    purchase has at least one web seat, and mobile seats are optional.
  - **The first person gets a web seat automatically.** Whoever signs up and pays for a block of seats becomes the
    owner, in the admin role, and is given a web seat as soon as the purchase is confirmed.
- **What follows from the answers:**
  - **Checkout:** the web seat price has a minimum of 1; the mobile seat price can be left off or added later.
  - **The owner's admin role and web seat** are assigned by an automation reacting to the purchase being confirmed (Paddle's
    `subscription.created`, translated), not by a person.
  - **The web seat count can never reach 0:** the owner holds one, and seats in use can't be removed (decision 5).
    Likewise, the last owner's web seat can't be revoked.
  - **Managing the organisation needs a web seat,** because it's done in the web portal. That's the admin role
    (decision 2), and the owner is an admin.
- **How it fits Paddle:** one subscription with **two price items**, a web seat price and a mobile seat price, each
  with its own quantity. Paddle supports several items on one subscription, each with a quantity (its guide *Add or
  remove items from a subscription*). 16.2b tries it in the sandbox, including adding the mobile item to a
  subscription that started with web seats only.

**Platform admin: our own staff (Gary, 2026-09-30):**
- **A third role, held by someone from Gary's team,** who helps customers with platform issues and setup. It
  **belongs to no organisation**: admin and engineer are the customer's roles, and platform admin is ours.
- **It holds no seat and isn't billed.** Seat counts, the seat limit and Paddle's quantities count only admins and
  engineers.
- **It works across organisations, both inside and on licensing** (Gary): setup and configuration inside a customer's
  organisation (the web portal), and licensing support (for example extending a trial, fixing an invitation, or
  replaying a failed Paddle webhook).
- **What follows for the model:**
  - **Every event records who acted,** and whether it was the customer's person or platform staff, so an
    organisation's history shows what our team did in it.
  - **Platform staff act through the same commands** as the customer's admins where one exists, marked as platform
    staff, rather than through a copy of each command. Actions only staff can take are a chapter of their own,
    "Platform Support", modelled after the customer's chapters.
  - **Signing in as platform staff** is part of authentication, like the other roles (decision 2).
- **Open, for later:** whether a customer must allow our team in (a consent or an "allow support access" switch), and
  whether the customer's admins are told when our team acts. Both are trust and terms questions, not model shape.

**Alternatives considered:**
- **Family A, seats following membership:**
  - It's the smoothest sale: no limit, no admin step.
  - But every join and leave becomes a Paddle update, and an increase charges the card at once, so a declined card
    would block a person joining.
  - Laravel Spark does it on Paddle. It stays possible later as automatic purchase (decision 4).
- **Removing seats at once, with Paddle's prorated credit** (the first choice, replaced 2026-10-01):
  - It's the simplest, with nothing pending.
  - But a customer loses seats they've paid for until the renewal, in exchange for a small credit that Paddle's
    portal labels confusingly ("Renewal").
  - Removing at the next period needs no timer either, because the renewal event applies it (decision 5).
- **Owner as a mark on one admin** (the first choice, replaced 2026-10-01): the owner then had no access of their own
  before the subscription started, and billing permissions hung on a flag rather than a role that auth can enforce.
- **A dedicated `ownershipWasHandedOver` event:** clearer to read in the history, but Gary preferred the generic role
  events, recorded together in one append.
- **Recording the seat type on the role event:** briefly chosen, then replaced by separate seat events, because a
  role and a seat are different concepts with different timelines (decision 2).
- **Keeping a branch's alternative outcomes in the same chapter:** replaced by one flow per chapter (ADR-038).
- **Locking at once on a failed payment** (GitHub): a card expiring would lock out a whole team, when Paddle
  recovers most failed renewals in the first days.

**Consequences:**
- **Our events** are named in the model (`supply-hub-v1/licensing`, 16 one-flow chapters, ADR-038). Paddle is in
  the owner's very first flow, because the trial starts at Paddle's checkout with a card. Assigning roles and seats
  to people never calls Paddle; only buying or removing seats does.
- **The automations** call Paddle to change the seat count. **The translations** turn Paddle's webhooks into the
  confirmations (16.4).
- **Each rule becomes a spec in the model:**
  - assigning is blocked at the limit;
  - the count can't go below the seats in use;
  - the last owner can't leave;
  - access checks the subscription's state.
- **The invitation's expiry** is a time-based automation, the kit's first.

### ADR-038: In process modelling, a chapter is one flow, with no branching

**Status:** **Accepted, 2026-10-01 (Gary).** Clarified the same day: the rule belongs to the second phase (process
modelling), not to storming.
**Date:** 2026-10-01

**Context:**
- **Event modelling has two phases, and both have their place** (Gary):
  1. **Storming:** a fast, collaborative brain dump. One chapter (or a few, by area) holds every event in the
     system, alternatives and failures included, so that nothing is missed. Speed over structure.
  2. **Process modelling:** the storm's events are split into individual process flows, one chapter each. Each flow
     is then fleshed out with commands, read models, screens and automations (slice mode).
- **The licensing model** (16.3) stormed into two chapters (Organisation, Subscription), each holding several
  outcomes: a seat change confirmed or declined; a renewal that fails, then recovers or ends; a cancellation that's
  scheduled, then withdrawn or completed. That's right for a storm. It moved into process modelling on 2026-10-01.
- **The event modelling standard** for process flows is one timeline per workflow, each flow told on its own.

**Decision:**
0. **Storm first, then split.** Storming may put every event in one chapter. Process modelling begins by splitting
   the storm into the chapters below, and slice mode works on those.
1. **In process modelling, a chapter tells one flow,** read left to right, with no branches. It's named for that flow ("Owner starts a
   trial", "A seat increase is declined").
2. **An alternative or failure outcome is a chapter of its own** (declined, expired, withdrawn, failed, ran out). It
   starts from the step the outcomes share, which reappears at its start.
3. **A rule that refuses a command is a specification on its slice** (Given/When/Then with `then error`), never a
   branch on the timeline.
4. **The happy paths come first,** then the alternative chapters, numbered in that order.
5. **Events are scoped by context, not by chapter.** The same event can appear in several chapters of one context
   (`userWasAssignedToRole` in "Owner starts a trial", "Admin invites a member" and "Admin changes a member's roles
   and seats"). The kit builds it once, in `src/contexts/<context>/Events.ts`. Within one chapter a repeat is an
   `element copy`, but only when the fact happens again (a second assignment). An automation's trigger is a
   `reacts-to` link to the original, not a copy (emcli exports the trigger from the link). Across chapters it's a separately added element with the same name, and it must keep exactly the
   same fields. (In 16.3 one field catalogue was used for every chapter. emcli doesn't check this yet: `ISSUES.md`.)
   *(ADR-059, 2026-10-09: this holds within a context only. Another context never copies or redefines the event; it
   reads the owner's published read model, or translates its published event.)*

**Alternatives considered:**
- **Alternative outcomes beside the decision, in one chapter,** kept into process modelling: fewer chapters, but
  each one mixes stories, and failure paths get less attention than the happy path. (In a storm it's the right
  thing to do, so the skill keeps it there.)
- **One flow per chapter from the start, even while storming** (briefly in the skill, 2026-10-01): it slows the
  collaborative brain dump, which needs speed more than structure.
- **Separate contexts per flow:** wrong, because the flows share one consistency boundary (the seat count, the
  membership), which DCB keeps by context.

**Consequences:**
- **More, shorter chapters:** the licensing model went from 2 chapters to 16 (9 flows and 7 alternatives).
- **The event-model skill** teaches both phases:
  - `storming.md` storms freely, and its wrap-up leads into process modelling;
  - `method.md` "Chapters" gives the rule for process chapters;
  - `review.md` flags a process chapter with two outcomes of one step, but never a storm chapter.
- **Same-named events across chapters must stay identical.** Until emcli warns about drift, keep one field catalogue
  per context.

### ADR-039: What flows into an automation: its trigger, its to-do list, and data inputs

**Status:** **Accepted, 2026-10-02 (Gary)** for the model, the completeness rule, and data inputs in
`build-automation`. **Proposed** for polling's runner and for external data inputs in the builder, which are proven
with their first slices.
**Date:** 2026-10-02

**Context:**
- **Automations come in two kinds:** triggered by an event (event-driven), or run on a schedule with no trigger
  (polling).
- **An automation gathers data from read models and passes it into the command, so the command is deterministic.**
  Those read models may be ours, another chapter's, or stand for an outside system's API.
- **The tools had gaps:**
  - emcli let any read model link to an automation, but **completeness skipped every mapped field**. A command
    could map `OrganisationOwner.ownerUserId` with no link to that read model at all.
  - `build-automation` read the one inbound read model as "the to-do list", so a data input would be mistaken for
    it.
  - A data input can itself be a list, so "the list read model" can't mark the to-do list.

**Decision:**
1. **An automation's inputs, in the model:**
   - its **trigger**: an event that `reacts-to` it (event-driven only);
   - its **to-do list**: a read model marked **`--todo-list`**, exported as `todoListElement: true` (the
     eventmodelers format's own flag; a flag, not a new element type, because prooph board's card types are fixed).
     There's at most one. *A polling automation had to have one; since ADR-042 (2026-10-02) it's a Temporal
     Schedule, and a list of our own is optional (the Paddle sweep's list is Paddle's event stream);*
   - **data inputs**: every other read model that `relates-to` it, a list or not, ours or another chapter's. One
     marked **`--external <System>`** (exported `context: EXTERNAL`, `externalSystem`) stands for an outside API;
   - a polling automation's **`--schedule`**.
2. **The rule** (Gary): every field of the command an automation issues comes from its trigger, a read model linked
   to it, `derived:` (a value it works out), or `webhook:` (a translation only). Never `user-input` or `session:`.
   If the trigger doesn't carry a value, a linked read model must. **`emcli completeness` enforces it as an ERROR.**
   It also reports a polling automation with no to-do list or two to-do lists (ERROR), and an event-driven
   automation with no trigger (WARNING). *An event-driven automation with a command and no to-do list was a
   WARNING until 2026-10-02: the list is optional (ADR-040).*
3. **In the kit:**
   - `act` gets `read(readModel, key)`, which folds a data input live from the event store, as the item is, so it's
     current;
   - a missing value throws, and the processor retries the event; *changed by ADR-051 (2026-10-07): the item waits,
     and the data input's event is a trigger too, so nothing blocks the items behind it;*
   - an external data input is fetched in an activity, through the provider skill;
   - polling stays blocked as unproven until its first slice. *(Translations: ADR-040.)*
4. **A to-do list whose closing event comes later** sits before the automation, opened by its events, with a copy
   after the closing event ("… settled") that adds it, so no link points backwards (as restaurant-orders' "stock to
   return").

**Alternatives considered:**
- **A new element type `todo-list`:** clearest in the model, but prooph board has no such card, and every builder and
  schema would need a new type. The eventmodelers format already has the flag.
- **The list read model is the to-do list:** ambiguous when a data input is a list too.
- **Data carried only on the to-do list's items** (lookups folded into the list): possible for our own read models,
  but it can't express an outside API or another chapter's read model, and it hides the dependency the model should
  show.

**Consequences:**
- The model shows exactly where an automation's data comes from, and a missing link is an error before the loop
  sees it.
- `licensing` chapter 1: its four internal automations got to-do lists, `OrganisationOwner` is a data input, and the
  check found the translation's missing processor type.
- emcli has 10 new tests (371 in all); the kit has a `read` test in `automations.tests.ts`, proven in `licensing`
  (13 of 13).

### ADR-040: Receiving another system's webhooks: an inbox on the event store

**Status:** **Accepted, 2026-10-02 (Gary)** for the design; proven in PLAN 16.4 (Paddle).
**Date:** 2026-10-02

**Context:**
- **Paddle delivers webhooks more than once, and out of order.**
  - A specific event and its `subscription.updated` often share one `occurred_at`.
  - `subscription.created` can be missing, with `subscription.activated` arriving instead. *(2026-10-02: it's
    missing for every purchase made at Paddle's checkout; a trial started there sends `subscription.trialing`. A
    start is whichever of `trialing`, `activated` and `created` arrives first.)*
  - `activated` means a trial conversion or a recovery, depending on our state (`paddle.md` §11b).
- **The kit had a `synchronous` translation mode** (decide inside the webhook request), blocked as unproven. It
  relies on Paddle's retries for failures and keeps no raw payload.
- **Gary asked:**
  - whether the ordering check needs a read model of what's been applied, kept immediately consistent;
  - whether this is an inbox pattern.

**Decision:**

```
 Paddle ── POST /webhooks/paddle ──▶  WEBHOOK ENDPOINT (thin; no business logic)
                                       1. verify Paddle-Signature ............ bad → 401, nothing recorded
                                       2. append  paddleNotificationReceived    (Paddle lane, raw payload)
                                            tags: subscriptionId, paddleEventId
                                            idempotency key = Paddle event_id  (redelivery → no-op)
                                       3. 200 OK at once ...................... 5xx only if the append fails
                                                   │
                     ┌─────────────────────────────┴───────────────────────────────┐
                     │ EVENT STORE = THE INBOX: durable, de-duplicated, replayable │
                     └─────────────────────────────┬───────────────────────────────┘
                                                   │ the processor's checkpoint: resumes after a crash
                                                   ▼
                     TRANSLATION (event-driven; a "list of one": the notification is the item)
                       classify by Paddle's type + OUR state
                         (trialing / payment failed / active → conversion, recovery, renewal …)
                       issue our command, idempotency key = paddleEventId
                                                   │
                                                   ▼
                     OUR COMMAND'S DECIDER (DCB), e.g. startTrial, recordSeatsChange
                       decision state = our events for that subscription
                                        (each carries paddleEventId, paddleOccurredAt)
                       • older paddleOccurredAt than the last applied → STALE
                       • the same fact already recorded (created + activated) → ALREADY DONE
                       • otherwise → our business event (+ paddleEventId, paddleOccurredAt)
                       conditional append: nothing new for this subscription since the read,
                       else decide again → immediately consistent, no race
                                                   │
                     ┌─────────────────────────────┴─────────────────────────────┐
                     ▼                                                           ▼
     our business event (trialWasStarted, …)             paddleNotificationSkipped {paddleEventId, reason}
       → read models, other automations                    stale | already done | failed (poison, + alert)

 SAFETY NET (facts, not the checkpoint): "Untranslated notifications" = received with no outcome event
 (business or skipped) for its paddleEventId → a live read model on the ops page; alert if one is old.
```

1. **A thin endpoint is the inbox's door.** It verifies the signature (401 if bad), then appends
   `paddleNotificationReceived` with the raw payload, tagged `subscriptionId` and `paddleEventId`, with Paddle's
   `event_id` as the idempotency key (ADR-006), so a redelivery is a no-op. It answers 200 at once (5xx only if the
   append fails). There's no business logic in it.
2. **The event store is the inbox:** durable, de-duplicated, replayable, and visible in the model's Paddle lane.
3. **The translation is an event-driven automation that keeps no to-do list** (Gary: a "list of one"): the
   notification is the item.
   - **This isn't a special kind** (Gary, 2026-10-02). An event-driven automation keeps a to-do list or none. An
     automation is classified by three questions: what starts it (an event, or a schedule), whether it keeps a
     to-do list, and where the work is done (here, or in another system).
   - **Keep a list unless** the work is done here, at once, from the one event, the trigger's id is unique per
     event (a notification's id, not an entity's), and nobody needs to see it waiting. Without a list the work is
     done once per trigger id. Polling and external work always keep a list: a stall has to be recorded somewhere.
   - emcli reports nothing either way: it can't tell an event's own id from an entity's, so the choice is the
     modeller's. The build skill takes the form from the slice (a linked to-do list, or none). It runs after the 200, classifies from Paddle's type plus our own state, and issues our
   command with the idempotency key `paddleEventId`.
   - **Crash safety** is the stored notification plus the processor's checkpoint: it resumes and works every missed
     notification, idempotently.
   - A stored list would add visibility and per-item retry, not crash safety. The kit's `defineAutomation` gains a
     list-less form for this.
4. **Ordering is decided in our deciders, under DCB's append condition.**
   - Every event recorded from Paddle carries `paddleEventId` and `paddleOccurredAt`.
   - A decider ignores an update older than the last applied one for that subscription (last writer wins), and
     treats the same fact by two routes as already done.
   - The append condition makes the check immediately consistent, with no separate read model. An async read model
     would race; if a projection were ever used for it, it would have to be inline or live.
5. **`paddleNotificationSkipped {paddleEventId, reason}`** records what was ignored, and why: stale, already done,
   or **failed**. A poison notification is skipped after its retries, with an alert, so it can't block the ones
   behind it.
6. **A safety net from the facts:** "Untranslated notifications" (received, with no outcome event for its
   `paddleEventId`) is a live read model with an age alert. It verifies the checkpoint without depending on it.

**Named patterns:**
- the idempotent receiver (Enterprise Integration Patterns);
- the transactional inbox;
- last writer wins by timestamp.

**Alternatives considered:**
- **A synchronous translation in the webhook request:** simpler, but no stored payload, failures lean on Paddle's
  retries, and the builder mode is unproven.
- **The notification as a nudge, with Paddle's API as the truth:** ordering can't go wrong, but it's an API call per
  webhook (rate limits, outages). Kept as a **fallback** for stale or ambiguous notifications.
- **A separate inbox table:** a second store beside the event store, for no gain.
- **A resequencer** (buffer and reorder by sequence): heavier. Paddle gives timestamps, not sequence numbers, so
  last writer wins is enough.

**Consequences:**
- One more event per webhook (`paddleNotificationReceived`), and each translated or skipped item closes with an
  event.
- Translations reuse the automation builder. The `synchronous` mode is superseded for webhooks.
- The pattern is general: any provider's webhooks (the auth system's, if ever) follow it, with that provider's
  signature check in its provider skill.

**Revised 2026-10-02 (Gary): the translation keeps a to-do list.** Points 3, 5 and 6 above, and the diagram's "list
of one" and "safety net", are superseded by this:
- **"Untranslated notifications" is the translation's to-do list**, not a separate read model beside it: opened by
  `paddleNotificationReceived`, closed by the outcome (our event, or `paddleNotificationSkipped` as stale or already
  done). It was a to-do list in all but name, so the same thing was modelled twice; and somebody needs to see the
  work waiting, which by the rule above means keeping a list.
- **A notification the translation gives up on stays on the list, marked failed** with its error, so the operations
  page shows what needs fixing. Giving up (after 5 attempts: record the skip, alert, move on) is available to any
  automation, with or without a list.
- **The cost, accepted:** the list is updated by the translation's own processor, so it no longer checks the
  checkpoint independently. A stuck or lagging processor shows on `GET /health/processors`, not on the list.
- **Each chapter that translates a notification** closes the list with its own event, in a copy of the list after it
  (ADR-039 point 4).
- **Replaying a failed notification** needs a retry command that records a new attempt (ADR-032's pattern), since
  the item's key is used by the skip. Not modelled yet.
- The list-less form stays in the kit for work that fits the rule of thumb. Nothing uses it yet.

**In the kit (2026-10-02):**
- `defineAutomation` with a `key` instead of a `todoList` is the list of one. It has its own processor and
  checkpoint, and an optional `giveUp` (attempts counted in the kit, since the app started).
- `src/shared/inbox.ts` is the door: `configureWebhookInbox`, with the provider's `verify` and `toEvent`.
- The kit's JSON parser (`configureJsonBody`) keeps the raw body of `/webhooks/…` requests for the signature check.
- A signed notification that can't be read answers 400 and raises an alert, so the reader is fixed before the
  provider stops retrying.

### ADR-041: What feeds the inbox: Paddle's webhooks, its API, or both

**Status:** **Accepted, 2026-10-02 (Gary)**: webhooks first, with a fetch of Paddle's event stream behind them.
The decision is under "Decided" below; the fetch and the kit's polling automation are still to be built.
**Date:** 2026-10-02

**Context:**
- **ADR-040 assumed webhooks are how Paddle's facts reach us.** Paddle calls us, so our state depends on its
  deliveries arriving.
- **Gary's question:** is that reliable enough? Or should we call Paddle's REST API for everything we need, so the
  integration is in our control?
- **The weakness of a webhook is that a missing one can't be seen.** `UntranslatedNotifications` lists what we
  received and haven't translated. It says nothing about what never arrived: our endpoint down for longer than
  Paddle retries, a destination disabled or misconfigured, an event type not subscribed to.
- **What we know of Paddle's delivery** (`docs/case-studies/paddle.md`): a failed delivery is retried 60 times over
  3 days live (3 times in 15 minutes in the sandbox), and notifications can be replayed for 90 days.
- **ADR-040 already kept a fallback:** on a stale or ambiguous notification, fetch the subscription from Paddle's API
  ("the notification is a nudge").

**The options:**
1. **Webhooks only** (ADR-040 as it stands): fastest, least to build; blind to a delivery that never arrives.
2. **The API only:** we ask Paddle on a schedule and after our own actions (a checkout completing in the browser, a
   seat change we made). We're in control, and nothing depends on Paddle reaching us.
   - It's slower by the polling interval, unless the screen that waits triggers a fetch.
   - It needs something on a schedule (polling isn't proven in the kit yet), and it's bounded by Paddle's rate
     limits.
   - Paddle's API being down stops it, as Paddle not delivering stops webhooks.
3. **Both:** the API is how we know we're complete, and webhooks only make it fast. A scheduled reconciliation
   reads what Paddle says happened and records anything we don't have.

**What doesn't depend on the answer:** the inbox, the translation, its to-do list and the deciders. Whatever feeds
it records `paddleNotificationReceived` under Paddle's event id, so a webhook and a fetch of the same event are one
item. The decision is only about the door: the webhook endpoint, a poller, or both.

**Found, 2026-10-02** (`docs/case-studies/paddle.md` §7b):
- **Paddle has an event stream, `GET /events`:** every event of the last 90 days, with the same `event_id` and
  payload as the webhook, readable in ascending id order from a checkpoint (`after=<event_id>`), 200 a page.
- **It doesn't depend on webhooks:** the sandbox has no notification destination, and its 156 events are all
  there. (*First recorded as 1,850: that was Paddle's `estimated_total`, which isn't reliable.*)
- In the sandbox, ascending id order was also `occurred_at` order (not a documented guarantee).
- The rate limit is 240 requests a minute per IP address.
- Webhooks: answer within 5 seconds; retried 60 times over 3 days live; no order guaranteed; duplicates possible.
  The documentation doesn't say what happens to a destination that keeps failing.

**Decided (Gary, 2026-10-02): webhooks first, and a fetch of Paddle's event stream behind them.**

1. **Two feeders, one inbox.** The webhook endpoint records `paddleNotificationReceived` as in ADR-040. A **fetch**
   reads the event stream after our checkpoint and records each event the same way. Both use Paddle's event id as
   the idempotency key, so the same event by both routes is one item. Order isn't guaranteed across the two, and the
   deciders already handle that. The inbox, the translation and its to-do list are unchanged.
2. **The checkpoint** is the last event id the fetch has paged through, recorded as our own event
   (`paddleEventsWereFetched`). It isn't the newest id received by webhook: gaps lie before that.
3. **What starts a fetch:**
   - the app starting (our own downtime is the likeliest reason a webhook was missed);
   - every webhook received (it fills any gap before it);
   - the browser reporting that the checkout completed (`checkoutWasCompleted`), so the owner doesn't wait on a
     webhook. **A short burst, not one fetch** (revised 2026-10-02): Paddle creates the subscription a moment after
     the payment, so one fetch may be too early. The "Paddle Checkout Watch" fetches at about 2, 5, 15, 30 and 60
     seconds and stops as soon as the trial shows (a to-do list of checkouts awaiting Paddle; timers in a workflow,
     ADR-042). **Each try runs the sweep now** (Gary, 2026-10-07), rather than fetching itself: one place fetches
     and records the checkpoint, and a try during a sweep queues one more run;
   - a webhook and the watch run the sweep through its schedule's trigger (`scheduleWatch.trigger`), best effort:
     the webhook's after its 200 (the scaffold's `afterRecorded`), and a failed trigger fails neither;
   - **a scheduled sweep,** about every 15 minutes, as the backstop: a Temporal Schedule (ADR-042);
   - as a principle, **before any action of ours that would harm a customer.** Nothing in the model needs it
     today: we never act against a customer on our own clock. Access ends only when Paddle's own cancellation
     arrives (`subscriptionHasEnded`).
4. **An event that starts a waiting period carries the date it ends** (Gary): `trialEndsAt`, `periodEndsAt`,
   `graceEndsAt`, `expiresAt`, `effectiveAt`. The dates are for the customer's screens ("your trial ends on…", "pay
   by…").
   - Where Paddle states the date, it's taken from Paddle's payload.
   - **`graceEndsAt` comes from a value we configure** (Gary): `configureGracePeriod` records
     `gracePeriodWasConfigured`, projected to `LicensingSettings`. The translation reads it as a data input
     (ADR-039) and sets `graceEndsAt` = Paddle's failure time + the configured days. It's recorded once at setup
     (14 days), and it must match Paddle's Payment Recovery window, which is what actually cancels the
     subscription.
5. **The sweep is a polling automation whose to-do list is Paddle's event stream after our checkpoint** (revised
   2026-10-02, Gary): an item is an event we haven't recorded yet, and recording it closes it. Each run fetches
   once, which covers every customer.
   - **Nothing is tracked as overdue.** A fact that's late arrives on a later sweep, and knowing it's late
     wouldn't change what we do.

**What the fetch covers, by scenario:**

| Scenario | Who starts it | If the webhook is lost | Harm from the delay |
|---|---|---|---|
| Owner starts a trial, or buys now | us (checkout on our page) | the fetch when the checkout completes | none |
| Owner changes seats, or cancels from our screen | us (our call to Paddle) | Paddle's reply to our call confirms it (ADR-049: a decisive answer is recorded at once, and the webhook repeats it) | none |
| The trial converts; a renewal succeeds or fails | Paddle, on a date we know | the sweep after that date | none |
| The grace period runs out | Paddle, on a date we know | the sweep after that date | none: access ends when Paddle's cancellation arrives |
| The owner cancels in Paddle's portal | the customer, unannounced | the next sweep | low: it takes effect at the period's end |
| A payment recovers during the grace period | Paddle or the customer, unannounced | the next sweep | low: a stale "payment failed" banner until then. Access isn't removed, because only Paddle's cancellation ends it |
| A refund or chargeback | Paddle, unannounced | the next sweep | medium; not modelled yet |
| A change made in Paddle's dashboard | us, outside the app | the next sweep | low |

A fetch isn't per event type: it reads everything after the checkpoint. So an unannounced change whose webhook is
lost is delayed by at most one sweep, never lost.

**Alternatives considered:**
- **A to-do list of dated facts with an overdue alert** (`PaddleFactsDue`: one item per organisation, moved by
  each event that starts a waiting period, closed by `subscriptionHasEnded`; an item past its date with nothing
  from Paddle raises an alert). Dropped: the sweep fetches everything whether or not anything is due, so the list
  wouldn't drive the fetch, and the alert needs a margin to tune and fires when Paddle is merely slow.
- **A workflow that waits until an item is due** (a timer per expected fact, no schedule): it leaves unannounced
  changes waiting for some other fetch, and adds a new workflow shape. The sweep covers both, with the polling
  automation invitation expiry needs anyway.
- **The webhook as a nudge only:** the endpoint records nothing itself and always fetches. The inbox would then be
  in Paddle's order, with one writer. But every webhook would depend on Paddle's API answering, and the endpoint
  built in ADR-040 would be thrown away.
- **The API only, on a schedule:** in our control, but the owner waits up to one interval after checkout.
- **Webhooks only:** a missing one can't be seen.

**Still to verify,** with a notification destination set up: that a delivered webhook's `event_id` is the
stream's, and how soon an event is in the stream.

**Consequences:**
- The webhook endpoint, Paddle's signature check and reader (16.5), and the sandbox capture go ahead as planned.
- To build: the fetch (a provider call), and the kit's polling automation (ADR-039), which invitation expiry needs
  too. Until then the model's chapter for the sync stays at storm level.
- Four events gained their end dates (`trialWasConverted`, `renewalPaymentWasRecovered`: `periodEndsAt`;
  `renewalPaymentFailed`, `trialConversionFailed`: `graceEndsAt`).
- A new small flow in the model: the grace period is configured (`configureGracePeriod`, `LicensingSettings`).

### ADR-042: Timed work runs on Temporal: a Schedule, a timer, or a start delay

**Status:** **Accepted, 2026-10-02 (Gary).** The kit's helpers are proven by their own tests; each shape's skill
section is a draft until its first slice is built and the end-to-end run passes (PLAN 16.6).
**Date:** 2026-10-02

**Context:**
- **Some work is started by time, not by an event:** a sweep of Paddle's events every 15 minutes (ADR-041), a few
  fetches in the minute after a checkout, an invitation that expires 7 days after it's sent (ADR-037).
- **ADR-039 named "polling" automations** (a schedule that scans a to-do list) and left their runner unbuilt.
- **We already run Temporal** for external work (ADR-031), with a client, a worker, workflows and activities.
- **Temporal recommends Schedules over its cron jobs.** A cron job is a property of one workflow run. A Schedule
  has its own identity: it can be updated, paused, triggered and backfilled without touching running work, and it
  has overlap policies.
- **Temporal's guidance on which tool:** a Schedule for recurring or calendar-based starts; a timer inside a
  workflow for a relative delay within one piece of work; a start delay for one start at a known future time (not
  a Schedule limited to one run).

**Decision:**

| Need | Temporal's tool | Ours |
|---|---|---|
| Recurring, for the whole system | a **Schedule** | the 15-minute Paddle sweep |
| A relative delay inside one piece of work | a **timer in a workflow** | the burst of fetches after a checkout |
| One start at a known future time | a workflow with a **start delay** | an invitation's expiry |

1. **A polling automation is a Temporal Schedule** that starts a workflow, whose activities do the work.
   - **As code:** its id is the automation's name. It's created when the app starts, and updated if it exists
     ("create, and on already-exists, update": listing schedules is eventually consistent, so check-then-create
     can race between two instances). It's never edited by hand in Temporal's UI.
   - **Overlap:** a run still going when the next is due means the next is skipped. A manual trigger during a run
     queues one more, so a burst of triggers is one extra run.
   - **Catch-up window: about a minute.** Temporal's default is a year, so after an outage every missed run would
     be due. For a sweep, one run covers everything missed.
   - **No pause-on-failure.** A failed run raises an alert, and the next run tries again.
   - **"Run now" is the same schedule, triggered** (the app starting, a webhook received): one code path.
   - **State stays in our events,** not in Temporal's "last completion result": the sweep's checkpoint is our own
     event, and it only moves forward.
   - **Activities are idempotent:** Temporal doesn't guarantee an earlier attempt has finished.
   - A scheduled run's workflow id is the schedule's id plus Temporal's timestamp (not our `<automation>:<key>`).
   - **A to-do list of our own is optional.** The Paddle sweep's list is Paddle's event stream.
2. **Watching for an outside fact is a workflow with timers:** an event-driven, external automation with a to-do
   list. Its workflow tries at growing intervals, stops as soon as the item is closed, and stops anyway after the
   last attempt. Nothing is recorded as stalled: something else (a webhook, the sweep) brings the fact.
3. **Work due at a known time is a workflow started with a delay:** an event-driven automation starts it when the
   date becomes known, due at that date. When it wakes it acts only if the item is still open. No scanning, and
   it's exact.
4. **A length of time that is ours to set is a configured value** (Gary): an event, projected to a settings read
   model, read by the processor that needs it (`gracePeriodDays`, `invitationExpiryDays` in `LicensingSettings`).

**Alternatives considered:**
- **Temporal cron jobs:** legacy; no pause, update or overlap control.
- **A timer in our own process:** not durable, and it would run once per app instance.
- **A scheduled scan for every dated thing** (invitation expiry as a sweep over a list): late by up to one
  interval, and it needs the list-scanning form of polling. A start delay is exact and simpler.
- **One long-running workflow per entity:** Temporal's advice when the interval differs and changes per entity.
  Ours don't.

**Consequences:**
- The kit gains `ensureSchedule`, `triggerSchedule`, a start with a delay, and `defineSchedule`.
- `build-automation` gains a draft section per shape. Each is distilled once its first slice is built and the
  end-to-end run passes (Gary: distil on solid ground).
- ADR-039's "polling must have a to-do list" is relaxed; ADR-037's and ADR-041's timed work is revised to these
  shapes.
- Tests trigger a schedule and use short delays: they never wait real minutes.

### ADR-043: A system setting is seeded by a setup command, issued once when the app first starts

**Status:** **Accepted, 2026-10-02 (Gary).** Built and proven by the kit's own tests. The skill section is a draft
until its first slice is built.
**Date:** 2026-10-02

**Context:**
- **A length of time that is ours to set is a configured value** (ADR-042, Gary): an event, projected to a settings
  read model, read by the processor that needs it. So far: the grace period (14 days) and the invitation expiry (7
  days).
- **The value must exist before anything needs it.** A processor that reads a data input and finds none waits until
  it's there (ADR-039), so an unset grace period would block the translation at the first failed payment.
- **Nobody is at a screen when the system is set up,** and the platform admin's settings screen comes later.

**Decision:**
1. **A setup command** is a command the system issues itself, once, when it's set up. In the model, its value is
   mapped **`config:<NAME>`**: it comes from the deployment's configuration, and the field's example is the default.
   Its other fields are worked out (`derived:"setup"`). It needs no screen and no automation to issue it, and
   `emcli completeness` asks for neither.
2. **The app issues it when it starts,** before it serves, under the idempotency key `setup:<command name>`. So
   it's issued **once, ever**: the first start records the configured value, and every later start does nothing.
3. **After that, the event is the truth.** A changed environment variable changes nothing. To change the setting,
   the command is issued again, through its route, or later the platform admin's screen.
4. **A value the command's rules refuse stops the app from starting,** saying which setup and why. The app never
   runs half set up.

**Alternatives considered:**
- **A default in the read model** when no event exists: nothing to seed, but the setting wouldn't be a recorded
  fact, and the default would live in code.
- **Re-applying the environment on every start** when its value differs: a deploy would silently undo a change a
  person made through the screen.
- **A setup script a person runs:** a manual step that can be forgotten, and the first failed payment would find the
  translation blocked.
- **A scheduled or polling automation:** nothing recurs; it's one command, once.

**Consequences:**
- The kit gains `src/shared/setup.ts` (`defineSetup`, `runSetup`, `configInt`, `configText`) and a `setup` list in
  `src/index.ts`, run before the app serves.
- emcli gains the `config:<NAME>` mapping. A setup command's every value must be configured or worked out.
- `build-state-change` gains a draft section: a command with a `config:` field also gets `setup.ts`.
- Until the platform admin's screen exists, a setting is changed by calling the command's route.
- When that screen arrives, the same command has two sources for its value (the deployment at setup, the screen
  afterwards). How the model shows both is settled then.

### ADR-044: Another system's browser library in a screen: behind a module of ours, with a mock

**Status:** **Accepted, 2026-10-03 (Gary).** Its open question was settled on 2026-10-02 (the inline checkout, and
decision 7's rule). Built and proven for Paddle's checkout by the module's own tests and Paddle's sandbox
(`licensing/web/e2e/paddle/`), including a checkout paid by hand; a slice the loop builds is still to come. The
skill sections are drafts until then.
**Date:** 2026-10-02

**Context:**
- **The owner pays in Paddle's checkout, opened from our page by Paddle.js** (ADR-036), a library Paddle serves from
  its own CDN. It's the first part of a screen that belongs to another system. A card form, a map or a sign-in
  widget would be the same kind of thing.
- **A screen is built from the model alone** (`build-screen`): a form per command, a view per read model, inside the
  slice's folder. It has no place for another system's library, its configuration or its tests, and the commit
  check rejects anything outside the slice's folder and its pages.
- **Everything must run with no account at the other system** (ADR-030): the tests, `npm run dev:mock`, and the
  end-to-end mock run.
- **What the page sees is not a fact** (ADR-041): access is granted from Paddle's own events, never from the page's.

**Decision:**
1. **The library sits behind a small module of ours,** `web/src/providers/<name>/`, the web's counterpart of
   `src/providers/<name>/`. A slice's component calls the module and never the library. The provider's skill holds
   the module; the first screen that needs it creates it, with its tests, and later screens share it.
2. **The module has a mock, and the mock is the default.** In `mock` the library isn't loaded: the module sends one
   request to the other system's mock (ADR-030), which makes happen what the real one would. For Paddle,
   `POST /mock/checkouts` completes the checkout and adds the trial's events to the mock's stream (the ones Paddle
   sent for a real checkout: `subscription.trialing` and `transaction.completed`), so the mock run goes end to end. In a component's tests and in `dev:mock`, MSW answers that request from the slice's
   `handlers.ts`.
3. **The page sends our backend one thing from the library: that it happened, and its id.** The module answers
   "completed, for this transaction" or "closed". The page reports that with a command of the model
   (`reportCheckoutCompleted`), which only starts the fetch of Paddle's events. Seats, amounts and status are never
   sent on from the library. *(Revised 2026-10-02: the page may **show** what the library reports, since only Paddle
   knows the tax for the buyer's country. The module passes it to the page for display, `onSummary`.)*
4. **In the model,** the command's field is mapped `derived:<the library> <its event> <its field>`
   (`derived:Paddle.js checkout.completed data.transaction_id`), the screen's mockup binds the button as the
   command's form, and the slice's notes say what's opened (which prices, how many). No new element type and no new
   mapping kind.
5. **Configuration is Vite's environment,** `VITE_<NAME>_…`, and holds only what's public: the environment, the
   client-side token, the ids of prices under our own names. A secret is never a `VITE_` variable.
6. **A screen commit may include the provider's module** (`web/src/providers/<name>/`), and its tests run with the
   slice's (the `web-scope` and `web-tests` checks).
7. **Paddle's checkout is shown inline, and what arrives is still checked** (Gary, 2026-10-02):
   - **Inline:** Paddle's form sits in our page and shows only the buyer's details and the payment. It has no list
     of items, so an ordinary buyer can't change the seats or remove one (the overlay lets them, and nothing locks
     it). Our page draws the summary beside it.
   - **A trial that still arrives without a web seat is refused:** it isn't started on our side, it's cancelled at
     Paddle at once (nothing has been charged), and the owner is told to start again. The page can't prevent this
     alone: the client-side token and the price ids are public, so a checkout can be opened with other items from
     outside our page. In the model: `refuseTrial`, `trialWasRefused`, an automation that cancels it at Paddle, and
     `refusedTrialWasCancelled` (licensing's chapter 24).

**Alternatives considered:**
- **Paddle.js used directly in the slice's component:** nothing to share between screens, no one place for the
  mock, and every component's test would have to fake a script loaded from a CDN.
- **A mock in the browser only** (MSW, no mock server): the page would work, but nothing would make Paddle's events,
  so the end-to-end mock run would stop at the checkout.
- **Our backend creates the transaction and the page opens it by id:** an extra call and slice before the checkout.
  It doesn't lock what the buyer can change in Paddle's overlay (16.2b), and we take the seats from Paddle's event
  either way.
- **Paddle's hosted checkout by redirect:** the buyer leaves our app, and the page it returns to still has to run
  Paddle.js.
- **Paddle's overlay:** less to lay out, and first built. But it lists the items with + and − and a bin icon, and
  Paddle.js has no setting to lock them.
- **Putting a removed item back from our script** (`checkout.items.removed`, then `Checkout.updateItems`): it reacts
  after the fact, and the buyer sees the item vanish and return.
- **Accepting a trial without a web seat and flagging it:** Paddle refuses adding an item during a trial, so the
  owner couldn't be given a web seat until the trial ended.

**Consequences:**
- `provider-paddle` gains the module (`checkout.ts`) and what Paddle.js sends; `build-screen` gains a draft section
  and one row in its table of where a field comes from; the commit checks accept `web/src/providers/<name>/`.
- The project's `web/package.json` needs the library's loader (`@paddle/paddle-js`); a slice never adds it.
- The mock Paddle gains a checkout that makes events, so it holds state: subscriptions as well as the stream.
- The "Choose How to Start" screen needs a place for Paddle's form and our summary of what's being bought.
- Our calls to Paddle gain "cancel now", proven in the sandbox on a trial.
- **Open:** what the owner sees after a refusal, and closing the checkout's to-do item on it, change chapter 1's read
  models; they're settled when chapters 1 and 24 are planned. The same rule for "Buy now" would need a refund, and
  isn't decided.

### ADR-045: Another system's event has a slice of its own: the endpoint that records it as it arrives

**Status:** **Accepted, 2026-10-05 (Gary).** From Gary's answer (2026-10-05): a webhook's event is recorded as an external
event, read into a read model, and turned into our events by a processor, with no command of ours in front of it.
Built in emcli and the kit; not yet built by the loop.
**Date:** 2026-10-05

**Context:**
- **ADR-040's inbox** records another system's notification as an event (`paddleNotificationReceived`), and a
  translation turns it into ours. In the model the event sits alone in the other system's lane, with fields from its
  payload (`webhook:`).
- **A slice with only an event was "mixed"** (a storm leftover) to emcli, which the hand-off refuses to plan and the
  export treated as a state change with no command. So nothing could build the endpoint.
- **Event Modeling's translation** is exactly this: an external event, a to-do list, an automation, our command.
  The external event has no command of ours: it is a fact another system tells us.

**Decision:**
1. **An event is marked as another system's** (`emcli element update <event> --external <System>`, the flag read
   models already use for an outside system's data). Its fields are mapped `webhook:<path in the payload>`.
2. **Its slice is an external event slice** (`sliceType: external`, exported `EXTERNAL_EVENT`) when it has that
   event and no command, read model or automation of ours. A copy of the event in another chapter shows the same
   fact and stays unplanned: only the original's slice is external, so the endpoint is built once.
3. **The loop builds its endpoint:** `build-automation`'s section "An external event" (a draft): the slice's
   `inbox.ts` from the provider skill's reader and signature check, wired with `configureWebhookInbox`, with tests
   from saved real payloads. Recording it is all it does; the translation is other slices.
4. **A provider's shared code** (`src/providers/<system>/`) may be part of a slice commit, created by the first slice
   that needs it (the backend's counterpart of ADR-044's `web/src/providers/<name>/`).

**Alternatives considered:**
- **A command the other system issues** (`receivePaddleNotification`), shaped like ADR-043's setup command: a
  standard write slice, but a command of ours that no one of ours issues, and a decider with nothing to decide.
- **Building the endpoint with the translation's first slice:** the door and what's done with what comes through it
  are two jobs, and the to-do list or the automation would carry another system's signature check.

**Consequences:**
- emcli: the `external` slice type (classification, `--external` on events, recomputed on pull, the export's
  `EXTERNAL_EVENT`, the schema); its skill's slicing and hand-off rules.
- The kit: the loop's prompt routes `EXTERNAL_EVENT` to `build-automation`; `provider-paddle`'s endpoint section
  points at it; `slice-scope` accepts `src/providers/<system>/`.
- In the licensing model, chapter 1's `paddleNotificationReceived` is marked `--external Paddle`, and chapters 20
  and 24 show copies of it.


### ADR-046: Changing a slice: replace it before release, supersede it after

**Status:** **Accepted, 2026-10-06 (Gary).** Proposed and rewritten the same day after Gary's review: the first
version proposed a general rule (a slice with its own rules gets its own command) and amended a built slice in place,
and Gary rejected both. The "expand, switch, contract" consequence and the `job-scope` check were added before
acceptance.
**Date:** 2026-10-06

**Context:**
- **What happened:** in licensing, "assign owner role" and "assign owner admin role" shared one `assignRole`
  command.
  - The first fix renamed the built slice's command and queued a rebuild.
  - The change rippled into other slices: the automation that issues the command, and two slices' tests that post
    to its route. The loop blocked twice.
  - Amending a built slice cuts against slice independence: development should move forward by adding.
- **The event policy already exists** (ADR-017, ADR-018):
  - `Events.ts` only grows; "event shapes are frozen once deployed";
  - a released event changes only by a new version, for every change, breaking or not.
- **What was missing:**
  - the boundary between the flexibility of development and the discipline of a live event-sourced system;
  - what changing a *slice* means on each side of that boundary;
  - any enforcement: no check guarded `Events.ts`, and emcli removed any event that had no copies.

**Decision:**
1. **Released means deployed** (emcli's slice status `deployed`). A released slice's events are in a real event
   store, and ADR-017 and ADR-018 govern them.
2. **A built slice is never amended in place.** To change what it does, add a new slice. Whether that slice has
   its own command is a modelling judgement for the case at hand, not a general rule.
3. **Before release, the old slice may be deleted.** Its event may be deleted or changed too, if nothing else
   produces or reads it: its events were only ever development data, and the local database is reset after.
4. **After release, the old slice is superseded, never deleted:**
   - **Events:** never deleted; changed only by a new version (ADR-018).
   - **A command or read endpoint:** deprecated (marked so in the contract) and removed once its clients have
     moved to the successor's endpoint, which is a route of its own.
   - **An automation:** switched off when its successor goes in, since two would act on every trigger. Its to-do
     list carries the open items over.
   - **A projection:** keeps handling old events for as long as anything reads it.
5. **Enforced:**
   - **`events-append-only`:** a slice commit only adds to `Events.ts`. The loop never removes or changes an
     event; a deliberate pre-release removal is a model change, made outside the loop's slice commits.
   - **emcli:**
     - refuses to remove a released event, or a slice holding one;
     - warns when a removal before release takes built code with it;
     - an export holds back a built slice whose model changed, rather than re-queueing it for a rebuild in place.

**Alternatives considered:**
- **Amend in place, with a rebuild** (emcli's re-queue and the first version of this ADR). It's cheap, but the
  change ripples into the slices that use the old one, and it hides history. Rejected for built slices.
- **Supersede even before release, deprecating rather than deleting.** It's disciplined, but it leaves dead code
  and dead events in a system nobody runs yet. Rejected: before release, deleting is the flexibility development
  needs.
- **A general rule that a slice with its own rules gets its own command** (the first version). Rejected: it's a
  modelling judgement.

**Consequences:**
- **Kit:** the `events-append-only` check. The exception that let a renaming rebuild touch its callers is removed.
  The rules are distilled into the `plan-change` skill, which every project installs (this file isn't). A
  read-model test sets up its *given* by appending events (`app.given`), never through another slice's route, so
  deleting a command slice can't break a read slice.
- **emcli:** the removal guards; the export's hold-back for changed built slices; the `event-model` skill's rule.
- **Open:**
  - retyping a built read model, adding queries and changing a screen still re-queue a built slice; review them
    against this rule;
  - deleting a slice's code is done by hand until the loop has a job for it.
- **In licensing (before release):**
  - "assign owner role" and "owner role on activation" are deleted;
  - "assign organisation owner" (`assignOwnerRole`, `POST /assign-owner-role`) and "owner on activation" replace
    them;
  - `userWasAssignedToRole` lives on, produced by both role commands.
- **A change other slices use goes expand, switch, contract** (added 2026-10-06, after the second replacement):
  - **What happened:** "assign organisation owner" was replaced again, keeping its command's name
    (`assignOwnerRole`) but dropping `roleId` from its fields. "Owner on activation" issues that command through
    its type, so it no longer compiled, and the loop edited it in a commit of its own (licensing `1fc4905`).
    `slice-scope` checks one commit at a time, so it passed.
  - **The rule:** when a change alters something other slices use (a command's fields or name, an event's type):
    1. **Expand:** add the new slice under a new name. The old one stays.
    2. **Switch:** replace each user with a slice that uses the new one.
    3. **Contract:** delete the old slice once nothing imports it (before release), or deprecate it (after).

    Every step builds on its own, and no built slice is edited.
  - **Rejected: follow-on fixes made by hand** (a compile-only edit to the user, recorded). They were proposed
    and approved first, then withdrawn on review: a hand edit still amends a built slice, and the loop would have
    to stop half-way through the job.
  - **Enforced by `job-scope`:** while the loop has a job InProgress, no other slice's folder changes, in a commit
    or left in the working tree (`tsc-build` checks the whole tree). An extension's origin is the exception. A
    blocked job stashes its uncommitted work, so the next job starts clean.
  - `1fc4905` stays as the one exception, since a proper replay produces the same line.

---

### ADR-047: Background processors share two database connections per app: one listener, one lock holder

**Status:** **Accepted, 2026-10-06 (Gary).** Steps 1 and 1b are built (library Phases 20 and 21, kit PRs #176 and
#177) and proven in licensing. Step 2 waits on its trigger: a host that forces a transaction-mode pooler. Kit issue
#170 (closed).
**Date:** 2026-10-06

**Context:**
- **What happened:** licensing has 11 background processors (async read models and automations), and its app
  hung at startup on the template's pool of 20. Every connection was held, and the setup step waited for one
  forever.
- **Why:** each processor holds two pooled connections for as long as it runs:
  - **its lock:** `acquireProcessorLock` takes a session-level `pg_try_advisory_lock`, so the connection can't go
    back to the pool (`eventHandling/processorLock.ts`);
  - **its wake-up:** `PostgresEventStore.subscribe` takes a connection of its own and `LISTEN`s on it
    (`eventStore/PostgresEventStore.ts`).

  A request waiting on `afterLastWrite` (`waitUntilProcessed`) also takes a `LISTEN` connection of its own once
  the processor is slow.
- **The stopgap** (kit PR #169) sizes the pool from the processors (`poolSize`), and `startReadModels` refuses a
  pool too small for them. Startup is now correct, but the connections still grow with the model:
  - licensing is about a fifth of its model and holds 22 connections;
  - the whole model would hold roughly 60 to 90 for each running copy of the app, and more during a deploy, when
    old and new run side by side;
  - a small hosted Postgres (RDS, Supabase) allows about 60 to 100 connections in all.
- **A pooler can't absorb it.** PgBouncer in transaction mode can't carry a session's advisory lock or a `LISTEN`,
  so the library needs direct, session-mode connections (invariant 7 in the library's `CLAUDE.md`; the append path alone has `rowLocks()` for poolers).
- **A lost lock connection isn't noticed today.** Nothing listens for the lock client's `error`. A processor whose
  connection drops runs on, unowned, until its next checkpoint write fails the CAS ("lock may have been stolen"). An
  unhandled `error` on a checked-out `pg` client may even end the process. To verify in Phase 20.
- **How Emmett does it** (`emmett-postgresql`, read 2026-10-06):
  - **No `LISTEN`:** each consumer polls with one message source (`pullingFrequencyInMs`, `batchSize`) and passes
    each batch to all of its processors.
  - **Ownership is a lease row:** `emt_try_acquire_processor_lock` takes a *transaction-scoped* advisory lock only
    to claim the processor's row (`processor_instance_id`, `status`, `last_updated`). Another instance may take
    the row over once it's stopped, or `last_updated` is older than the lock timeout (300 s by default). Every
    checkpoint renews it. No connection is held.
- **How Axon does it:** the same pattern. Its token store's token claims have an owner and a timestamp, and
  another node may claim a token once the claim times out. A lease row is the established way to own a processor.
  A session lock held for the processor's whole life (ours) is the less common one.
- **What holding few connections doesn't fix** (found after step 1, researched for step 1b on Gary's questions):
  - every append wakes every processor at once, and each *borrows* a connection to read, then one to handle;
  - licensing's database still saw 13 connections for 11 processors.

  How the three references treat it:
  - **Emmett** reads once per consumer, from the earliest processor's position, and passes each batch to all its
    processors at once (`consumers.ts`; one failure fails the batch). Our reading of why: one read instead of N, a
    store-agnostic source with no `LISTEN`, and a batch per transaction. Its lockstep would undo the library's rule
    (Phase 19, ADR-031) that a blocked processor holds up only itself.
  - **Marten's async daemon** reads per projection, as we do. It caps the daemon at 4 concurrent event loads
    (`MaxConcurrentEventLoadsPerDatabase`) and 4 concurrent batch writes (`MaxConcurrentBatchWritesPerDatabase`),
    because an unbounded daemon "can drive the connection pool's high-water mark toward the total agent count even
    though only a handful of loads or writes are ever active at the same instant".
  - **Axon** reads once per processor (a coordinator hands its stream to the processor's segments), with thread pools
    per processor, so it caps a processor, not the app. Ownership is token claims (a lease, 10 s), and it handles a
    batch per transaction. On PostgreSQL without Axon Server, load grows with processors and segments; AxonIQ's answer
    is Axon Server, a separate product.

**Decision** (two steps, Gary 2026-10-06; the second only if the deployment needs it):

*Step 1, now:*
1. **One listener per event store.** `PostgresEventStore` opens one `LISTEN` connection when the first subscriber
   or waiter needs it, and closes it when the last one goes.
   - It listens on the event channel and the bookmark channel, and passes each notification to every subscriber in
     this process.
   - `subscribe` and `waitUntilProcessed` register with it, and no longer take a connection of their own.
   - **If it fails,** subscribers carry on at their poll interval, which they already have. The listener
     reconnects after a backoff, and clears the high-water-mark cache when it's back, since notifications were
     missed while it was down.
2. **One lock connection per consumer.** `createConsumer` holds every processor's session advisory lock on a single
   connection, a lock holder. A session can hold many advisory locks.
   - Each processor takes and releases its own key through the lock holder. Locking is unchanged: the same keys,
     the same `P:` namespace, still session-scoped.
   - **If that connection fails,** every processor whose lock it held is stopped at once, rather than left running
     unowned. The consumer's supervision (library Phase 19) starts them again after its backoff: a new connection,
     the locks taken again. The CAS checkpoint stays as the backstop.
   - **A processor started on its own** (`createProcessor` outside a consumer) keeps a connection of its own,
     through the same lock holder.
3. **Connections per app:** one for the listener and one for each consumer's locks, whatever the number of
   processors. Requests come on top. The kit sizes the pool from this, not from the processors.

*Step 1b, governors (Marten's caps; library Phase 21):*

4. **A store's subscriptions take turns at reading:** `maxConcurrentSubscriptionReads`, default 4. `read()` (requests)
   isn't capped.
5. **A consumer's processors take turns at handling** an event's transaction or a checkpoint move:
   `maxConcurrentHandling`, default 4.
   - A blocked processor's retry wait holds no turn.
   - Nested work in a handler borrows from the pool, not a turn, so a pool of 2 + the caps + 1 can't deadlock.
   - A slow handler holds its turn, so slow outside work runs on Temporal (ADR-033), not in the transaction.

*Step 2, only if the app must run behind a transaction-mode pooler:*

6. **Lease rows and polling only** (Emmett's and Axon's pattern), so nothing holds a session:
   - the bookmark row gains its owner and a lease expiry;
   - a processor claims the row under a transaction-scoped advisory lock;
   - every checkpoint renews the lease, and so does an idle processor, on a timer;
   - another instance takes the row over once the lease runs out. A crashed instance's processors therefore wait
     out the lease, which is seconds with a short one;
   - the shared listener goes, and every subscriber polls (consumer-level polling, as Emmett's, keeps the queries
     down).

   The checkpoint's `instance_id` and its version check (CAS) are already there.

**The deployment constraint:** the backend runs as a **long-running process with direct, session-mode connections**:
2 for the background work (step 1), plus the request pool. A transaction-mode pooler comes from serverless compute
(Lambda, Vercel functions, Workers), not from the database host. This backend can't be serverless anyway, since its
processors and the Temporal worker run continuously.

As of 2026-10-06, the mainstream managed Postgres hosts offer direct connections (RDS, Aurora, Cloud SQL, Azure,
DigitalOcean, Crunchy Bridge, Render, Railway, Heroku). Supabase and Neon offer a direct endpoint beside a pooled
one. **When the backend's host is chosen, check:**
- it gives direct connections, and how many on the tier chosen;
- whether they're IPv4 (Supabase's direct endpoint is IPv6 unless you buy its IPv4 add-on);
- whether it ends idle sessions (Neon's scale-to-zero, which must be off for this app).

If it can't give direct connections, step 2 is done before release.

**Alternatives considered:**
- **Lease rows now** (step 2 straight away). It's the established pattern, but it's about a phase more work. It also
  only frees the app from session connections if `LISTEN` goes too, so every processor would wait a poll interval.
  Deferred to when a host needs it.
- **Polling only, no `LISTEN`, with session locks.** It saves one connection, but every processor would wait a poll
  interval for new events and query the database on every poll. The shared listener costs one connection. Rejected
  for step 1.
- **Transaction-scoped locks around each batch.** No instance would own a processor between batches, so two
  instances could interleave its events. Rejected.
- **A bigger pool** (the stopgap). It grows with the model, and small hosted databases cap the total. Rejected as
  the answer; kept until Phase 20 lands.

**Consequences:**
- **Library:** Phase 20 (dcb-event-store PR #32, merged 2026-10-06).
  - **Tests:** 100 subscribers on one listener connection; a lost listener (polling carries on, then it
    reconnects); a lost lock connection (its processors stop and restart, and no event is handled twice); two
    instances (the second takes over when the first's lock connection goes).
  - **Building it found two faults on `main`:**
    - a terminated lock connection was an uncaught exception, which ends the app, and the processor ran on unowned;
    - `subscribe` held its read's connection and an open transaction while each event was handled, so processors
      catching up at once could deadlock a small pool.

    `subscribe` now reads a page and gives the connection back before yielding it.
- **Kit (PR after #175):**
  - `poolSize` is `CONSUMER_CONNECTIONS` (2) + one per processor + headroom. It's not a flat 2 plus headroom: a
    processor borrows a connection while it handles an event, and an automation's work borrows more inside it (a
    read of its to-do list, a command's append). So a pool smaller than the processors could still leave automations
    waiting on each other for good. `startReadModels` refuses a pool below 2 + processors + 1.
  - Read-your-writes waits share the store's listener (`waitUntilProcessed`'s `listener`).
  - **The fallback poll is 1 s** (`FALLBACK_POLL_MS`), not the library's 100 ms: the listener wakes processors on
    every append, and on its own loss and return.
- **Proven in licensing (2026-10-06):**
  - pool 23 (was 32);
  - all 305 tests and the owner chain (9/9) pass;
  - one connection holds all 11 locks, and one listens;
  - killing the lock connection: all 11 processors stopped ("lost its lock"), took their locks back on a new
    connection within about a second, the app stayed up, and the owner chain passed again.
- **Step 1b** (library Phase 21, PR #33; this kit's follow-up), after step 1 left 13 connections idle (each append
  woke every processor's read at once):
  - **Library, measured:** 30 processors handling a burst borrowed 42 connections at once uncapped, and 14 capped.
  - **Kit:** `SUBSCRIPTION_READS` and `HANDLING_TURNS` (4 each) are passed to the store and the consumer.
    `consumerConnections(n)` = 2 + min(4, n) + min(4, n), and `poolSize` adds 10 headroom: **20 for any app with 4 or
    more processors.**
  - **Licensing:**
    - pool 20 (was 23, and 32 before step 1); 305 tests pass;
    - the owner chain passed with at most 14 connections at once, its own requests included;
    - idle, 6 connections: the 2 held and the 4 reading turns, which the 1 s fallback poll keeps warm. That's 13 before
      the caps, and it no longer grows with processors;
    - killing the lock connection restarted all 11 processors within about a second, and the chain passed again.
- **Roadmap: Axon's model, part by part, each when its trigger arrives.** None conflicts with the caps.

  | Axon's part | Adopt when |
  |---|---|
  | Lease ownership (token claims; step 2 above) | The host forces a transaction-mode pooler, or segments arrive |
  | Segments (a processor's events split by a key, such as a DCB tag value, claimed by app instances) | A processor's lag keeps growing, or several app instances should share the work rather than stand by |
  | A batch per transaction | Commits limit throughput (a large rebuild, say) |

  Also kept for later: targeted wake-ups (the NOTIFY payload carries event types), and Emmett's one reader per
  consumer if the N reads ever become the bottleneck.
- **Hosting:** choosing the backend's host includes the deployment check above. It's an open point in PLAN Phase 16.

---

### ADR-048: An event's tags are part of its definition, and change by the compatibility rules

**Status:** **Accepted, 2026-10-06 (Gary),** after it was built and proven in licensing. Proposed the same day; Gary
agreed the plan and added the compatibility rule: a tag change is judged by its downstream impact on projections and
deciders.
**Date:** 2026-10-06

**Context:**
- **What happened:** in licensing, "untranslated notifications settled" blocked.
  - The to-do list `UntranslatedNotifications` is keyed by `paddleEventId`: a notification leaves it when an
    outcome tagged with that id arrives.
  - `trialWasStarted` carries `paddleEventId` as data but is tagged only with `organisationId`, so the trial's
    start never reached the document.
  - Tagging it meant changing a line of `Events.ts` (refused by `events-append-only`) and start trial's integration
    test, which checks the persisted tags exactly (refused by `extension-additive`).
- **ADR-040 already needed the tag:** its safety net is "received, with no outcome event for its `paddleEventId`",
  and its deciders read "our events for that subscription". So every outcome of a Paddle notification must be found
  by `paddleEventId`, and by `subscriptionId`. `trialWasRefused` and `refusedTrialWasCancelled` have the same gap.
- **Why it got through:** the model marks an event's tags as id fields (`idAttribute`), and only `organisationId`
  was marked. emcli couldn't mark an existing field as an id, and no check compares a read model's key with the
  tags of the events that feed it.
- **What the library does with tags** (dcb-event-store):
  - **a read** (a decision model's query, a projection's live read) finds an event that has **any** of a query
    item's tags, and one of its types (`tags && …`);
  - **an append condition** conflicts with an event that has **all** of the condition's tags (`tags @> …`);
  - **a read model** files an event under each of its `${key}=` tags (the kit's `readModels.ts`), and a live read
    model queries the store by that tag (ADR-022, ADR-023).
- **The references:**
  - **Axon 5** declares tags on the event's fields (`@EventTag`, resolved by `AnnotationBasedTagResolver` when the
    event is appended). So, as here, a tag belongs to the event's definition, and a change only reaches events
    appended after it.
  - **Emmett and Marten** file an event under one stream when it's appended, and never move a stored event: the
    same constraint as a stored event's tags.

**Decision:**
1. **An event's tags are part of its definition, declared by its id fields.** The build tags an event with every
   field the model marks as an id.
2. **An event recorded from another system carries that system's ids as tags.** For Paddle these are
   `paddleEventId` and, when known, `subscriptionId` (ADR-040).
3. **A tag change follows the compatibility rules, by who uses the tag.** Its users are:
   - every query whose item has one of the event's types and uses the tag's key: a decision model's
     `tagFilter`, and the append condition built from it;
   - a read model's key, lookup or query parameter, for a read model that handles the event.

   | The change | Its impact | So |
   |---|---|---|
   | **Add a tag** | No query loses the event. A query that uses the new key for the event's type now finds it: a decision folds more events, an append condition conflicts more often, a projection files the event under more documents. | **Compatible** when no such query exists. If one does, that slice's behaviour changes: replace it (ADR-046). |
   | **Remove a tag, rename its key or change its value** | Every query by the old tag stops finding the event: a decision silently loses state, a projection loses documents. | **Breaking:** expand (add the new tag), switch (replace each user to query it), contract (remove the old tag). |

4. **Before release,** a tag change is an event change (ADR-046): one commit to `Events.ts` made outside the loop,
   saying why. Each slice whose tests check the old tags gets a same-name replacement, and the other slices that
   hold the event are re-planned. Reset the local database: its events keep their old tags.
5. **After release, a stored event keeps the tags it was appended with.** Any tag change is a new version of the
   event (ADR-018), and a reader by a new tag can't find the old version's events by it.
6. **emcli:**
   - `element field set --id` / `--no-id` marks a field as an id. Like the other flags, it follows the element's
     copies and spec steps.
   - The export's hold-back (ADR-046) ignores an id flag on an event a slice doesn't produce, and on spec steps:
     those slices' code takes the event's tags from `Events.ts`, so their build doesn't change.
   - `completeness` warns when an event feeds a read model without its key as an id: the projection would never
     file it.

**Alternatives considered:**
- **Tags as a build rule only, not in the model** (how `organisationWasActivated`'s `userId` tag was built).
  Rejected: the model can't then check a read model's key against its events, which is how this got through.
- **File events under a read model's key read from the event's data** (Marten's and Emmett's identity from a
  field). Rejected: a live read model queries the store by the key tag (ADR-022, ADR-023), so the tag is needed
  anyway.
- **A new event version before release.** Rejected: before release an event may change in place (ADR-046).
- **Edit the producers' tests by hand in the event commit.** Rejected: it amends built slices (ADR-046's
  withdrawn "follow-on fixes").

**Consequences:**
- **The commit to `Events.ts` breaks the producers' integration tests** until the loop rebuilds them, since only
  their same-name replacements may change their tests.
- **Kit:** `plan-change` gets a row for tags and the impact check; `provider-paddle` and `build-state-change` say
  which ids an event is tagged with.
- **In licensing (before release):**
  - `trialWasStarted`, `trialWasRefused` and `refusedTrialWasCancelled` are tagged with `paddleEventId` and
    `subscriptionId` as well as `organisationId`;
  - their producers are replaced with same-name slices: start trial, refuse trial, record refused trial cancelled;
  - "untranslated notifications settled" is re-planned;
  - new extension slices in chapter 24 take a refused or cancelled notification off the to-do list.
- **The impact check, in licensing:** the only queries using the new keys are
  - `UntranslatedNotifications` (key `paddleEventId`), which the extension means to change;
  - skip paddle notification's "has outcome", which asks only for `paddleNotificationSkipped`.

  So the additions are compatible.
- **Proven in licensing (2026-10-06):**
  - the loop built all six slices with no blocks ($1.67);
  - each producer's same-name rebuild changed only its tag test;
  - 317 tests pass;
  - `e2e/paddle/settled-chain.sh` passes 14 of 14 against the running app: each outcome is recorded with both
    tags and leaves the to-do list, and a notification with no translation stays on it.
- **Open:** tags built before this rule without an id in the model (`organisationWasActivated`'s `userId`,
  `paddleNotificationReceived`'s `subscriptionId`) are declared in the model when their slices are next replaced.

### ADR-049: A decisive answer to our own call is a fact, recorded at once; the provider's event of it is a repeat

**Status:** **Accepted, 2026-10-07 (Gary),** after the sandbox proved the version match. Proposed the same day:
Gary asked why the refused trial's cancellation ignores Paddle's answer and waits for the webhook, then how the
answer and the webhook are deduplicated without a `paddleEventId`.
**Date:** 2026-10-07

**Context:**
- **What happens today, in licensing:**
  - the cancellation's workflow calls Paddle's `POST /subscriptions/{id}/cancel` (`effective_from: immediately`);
  - Paddle answers 200 with the subscription, `status: canceled`, and the workflow ignores it;
  - the to-do item closes only when `subscription.canceled` arrives through the inbox, about three seconds later.
- **The rule behind it was never decided.** It's one line of `provider-paddle`: "Never record a business event from
  the call's answer". The rest of the kit says the opposite:
  - **ADR-031/032 and `build-automation`:** "the workflow calls, then records the answer as a command". The
    restaurant's Braintree charge records `paid` or `declined` from the answer.
  - **ADR-041's table:** for a seat change or cancel we start, "Paddle's reply to our call confirms it".
- **What waiting costs:**
  - **the item stays open** until the webhook arrives, and indefinitely if it's lost. The fetch (Paddle Sync,
    chapter 21) isn't built;
  - **a screen can't confirm** the owner's own action from our state;
  - **an answer we asked for, and hold, is thrown away.**
- **The references:**
  - **Paddle's docs:**
    - they say to "use webhooks to keep your app in sync with Paddle", plus a periodic reconciliation through the
      API ("Provision access and handle subscription state");
    - they're silent on the answer to your own call;
    - delivery is at least once and in no guaranteed order: deduplicate by `event_id`, order by `occurred_at`
      ("Handle webhook delivery");
    - a cancel with `effective_from: immediately` answers `status: canceled` at once ("Cancel a subscription").
  - **In the sandbox (2026-10-02),** Paddle sends its event for a change made through the API too: our own calls
    come back as webhooks.
  - **The book (`publishCart`):** the command handler records the outcome of the external send itself, and its
    failure as `failPublication`. It doesn't wait for a later confirmation.
- **What the old rule guarded against.** Each concern is real, and each has a narrower answer:
  - **two writers of one fact** (the answer and the webhook): whichever arrives second must be recognised as the
    same change and skipped, "already done", as Paddle's duplicates are now (ADR-040);
  - **order:** an answer has no `event_id` or `occurred_at`;
  - **answers that only accept a request** and don't state its result: these are not decisive, and wait as before.
- **How the same change is recognised: proven in the sandbox (2026-10-07,** licensing
  `e2e/paddle/answer-vs-event.mjs`, two runs on fresh cardless trials, recorded in its README):
  - **the subscription's `updated_at` is its version.** Every answer and every event of one change carry the same
    `updated_at`, to the millisecond: 10 of 10 answers matched their events, none matched two, none was left
    without one. A cancel's two events (`subscription.updated`, `subscription.canceled`) share the answer's;
  - **a repeat of the same request changes nothing:** the same seat numbers answer the previous `updated_at` and make
    no event, and a second cancel is refused and makes no event. So a retried activity answers the version of the
    change it already made;
  - **Paddle's `occurred_at` is not the change's time:** it's about 200 ms after `updated_at`, so it can't be
    matched with an answer;
  - **the event can arrive before we record the answer:** it follows the change within a second, and the workflow
    records only after its activity returns. Either may be first;
  - **a request id of ours in `custom_data` doesn't work:** setting it is itself a change (a new version and event
    even for the same numbers), and it stays on the subscription, so later changes, Paddle's own included, carry it;
  - **matching on state alone isn't enough:** seats 1 → 2 → 1 leave two changes with the same numbers, and a late
    event of the first would look like the last.

**Decision:**
1. **A decisive answer to our own call is a fact.** It states the result: the entity in its new state (Paddle's
   subscription with `status: canceled`, the new item quantities, or a `scheduled_change`), or a business answer
   (Braintree's `declined`). The workflow records it at once as our command, through an activity, as
   `build-automation` already says.
   - It carries the provider's ids that the answer gives (Paddle: `subscriptionId`). It has no `paddleEventId`,
     since no event of Paddle's has arrived (ADR-048: "when known").
2. **Every event we record from a subscription's change carries its version:** Paddle's `updated_at`, as
   `paddleUpdatedAt`, whether it came from our call's answer or from Paddle's event (`data.updated_at`).
3. **The same change is recognised by (subscription, version), whichever report arrives first.** The command that
   records a report reads the subscription's events (by its `subscriptionId` tag) and compares versions:

   | The report's version, against the latest recorded | So |
   |---|---|
   | the same | **already done**: the other report of this change was first. From Paddle's event, `paddleNotificationSkipped` "already done", tagged with its `paddleEventId`, so it leaves the to-do list (ADR-048); from our answer, nothing more |
   | older | **superseded**: a later change is recorded, and it states the subscription as it is now. Skipped the same way |
   | newer, or none recorded | **a new change**: recorded |

   A retried activity's answer carries the version of the change the first try made, so it is "already done" too.
   This holds for facts that are the subscription's state (its status, its seats, a scheduled change), where the
   latest state supersedes an earlier one. A fact that a later state doesn't replace (a payment, a refund) comes from
   its own entity's events (`transaction.*`), never from a subscription's version.
4. **An answer that isn't decisive records nothing:** a timeout, a 429 or 5xx once the retries have run out, or an
   answer that only accepts the request. The fact comes from the provider's event (webhook or fetch), and ADR-032's
   stalls apply as before.
5. **What we didn't start comes only from the provider's events:** renewals, a failed payment, its recovery, the
   customer's portal, a change made in Paddle's dashboard. They carry a version too, so the same table orders them.
   ADR-041's fetch still covers a lost webhook, deduplicated with the webhook by `paddleEventId` in the inbox
   (ADR-040), as now.
6. **We don't put request ids of ours in `custom_data`** to match changes: setting it is a change of its own, and it
   stays on the subscription.

**Alternatives considered:**
- **Keep waiting for the provider's event** (today's `provider-paddle`). One writer per fact, but it throws away an
  answer we hold, leaves the item open while the webhook is lost, and contradicts ADR-031/032.
- **Record from the answer and ignore the webhook** for changes we start. Rejected: the webhook would then never be
  translated, and the to-do list of notifications would hold it until it gave up.
- **Two events: "requested at Paddle" from the answer, "confirmed by Paddle" from the webhook.** More honest about
  the source, but nobody acts on the difference: both mean the subscription is cancelled. A screen can show the
  source if needed (a field), without a second event.
- **Match on state alone** (the subscription is already cancelled; its seats are already those numbers). Enough for
  a cancel, which happens once, but not for seats: 1 → 2 → 1 makes a late event of the first change look like the
  last. Rejected in favour of the version.
- **Our request id in `custom_data`**, echoed by Paddle's event. It is echoed (8 of 8 in the sandbox), but setting it
  makes every call a change, and later changes carry the old id. Rejected.
- **Match on Paddle's `occurred_at`.** It's the event's time, about 200 ms after the change, and no answer has it.
  Rejected.

**Consequences:**
- **Kit:**
  - `provider-paddle`: the rule is replaced, with which of Paddle's answers are decisive, and the webhook of our own
    change skipped as "already done";
  - ADR-041's table: the row for changes we start says the answer records it, and the webhook repeats it;
  - `build-automation`: unchanged (it already says this); `plan-change`: unchanged.
- **Licensing (before release), chapter 24, planned with `plan-change` once accepted:**
  - the cancellation's workflow records the cancel from Paddle's answer: a new command and slice ("record refused
    trial cancelled at paddle"), and the automation replaced under the same name;
  - "record refused trial cancelled" (the translation's) replaced under the same name: a subscription already
    cancelled is skipped, "already done". Today a second cancellation would be recorded twice;
  - `refusedTrialWasCancelled` gains `paddleUpdatedAt`, and `paddleEventId` and `paddleOccurredAt` become optional
    (absent when the answer recorded it). An event change before release (ADR-046, ADR-048), checked by who uses
    the `paddleEventId` tag;
  - the mock keeps Paddle's versions: a change gets a new `updated_at` that its events carry, and a repeat answers
    the previous one and sends nothing.
- **Proven (2026-10-07,** licensing `trial-cancellation.sh`, 44 of 44): the item closes on the mock's answer, before
  any `subscription.canceled`; the webhook with the same `updated_at` is then skipped as "already done", and the trial
  is cancelled once. With the mock failing our cancel three times, Paddle's event first closes the item and our
  answer, when it comes, decides nothing (ADR-050): no second cancellation, no stall. A `not_found` still stalls, and
  the settled chain still passes. Built by the loop through expand, switch, contract; the replaced automation needed
  a second build, as a rebuild (emcli now queues a replacement so).

### ADR-050: A command may decide nothing: its intent already holds

**Status:** **Accepted, 2026-10-07 (Gary).** Gary: a decider can return an empty array, for idempotency and no-op
cases, instead of an invented event or a refusal; and the status code should tell the caller which it was.
**Date:** 2026-10-07

**Context:**
- **What we had:** dcb-event-store's `handle()` threw "Decider must return at least one event" (since its phase 2),
  although the same phase's `DeciderSpecification.thenNothingHappened()` tests a decider that returns `[]`. The kit
  read that rule as design, so a command whose intent already held had two ways out:
  - **a refusal:** licensing's ADR-049 plan had our cancel's answer, after Paddle's event of the same cancel, refused
    "Already cancelled", and the workflow taught to treat that refusal as done; refuse trial had "already refused"
    until its replacement (2026-10-07);
  - **an event:** where an event is really needed, it stays. `paddleNotificationSkipped` "already done" closes the
    notification's item on the to-do list (ADR-040, ADR-048), so it is a fact we need, not an invented one.
- **The references:**
  - **Emmett** (`handleCommand`): a decision of no events appends nothing and returns `newEvents: []`, the stream
    version unchanged.
  - **The decider pattern** (Chassaing): `decide` returns a list of events, and an empty list means nothing happened.
  - **Emmett over HTTP** (`emmett-expressjs`): `ResponseFromEvents` answers **204 whether or not events were
    appended** (a route may pass its own mapping). Its errors map `ValidationError` 400, `IllegalStateError` 403,
    `NotFoundError` 404, `ConcurrencyError` 412 (an `If-Match` mismatch), else 500. Its sample's `confirm` returns
    `[]` for a cart already confirmed, and the API answers **200 with the same body and the same ETag** first time and
    on the retry ("allows a client to safely retry confirmation"). So Emmett doesn't tell a no-op by status: the ETag,
    the **stream's version**, didn't advance.
  - **Ours differs there:** our ETag is a **global position**. On a no-op it's the position the decision was read at,
    which a client can't compare with anything it holds. So the ETag can't carry the signal; the status must.
  - **HTTP** (RFC 9110): **304 Not Modified is only for a conditional GET or HEAD** (a cache's copy is still valid),
    never for a command. A command whose intent already holds succeeded, so it's a 2xx. Stripe answers a replayed
    idempotent request with the original response.
  - **The codes in use before this ADR,** for commands: 204 (handled, events appended, `ETag` = the position), 201
    with the generated fields, 400 (validation), 404 (`NotFoundError`), 422 (`IllegalStateError`, the contract's
    `4XX` "Rejected"), 409 (`AppendConditionError`), 504 (`Prefer: wait` timed out), 500. A replay with the same
    `Idempotency-Key` answers what the original did. 204 also answers a CORS preflight, unrelated.
- **Fixed in the library** (dcb-event-store phase 22): a decision of `[]` appends nothing and throws nothing;
  `handleCommand()` returns `{ position, events }`; `handle()` keeps its signature.

**Decision:**
1. **A command whose intent already holds decides nothing:** its decider returns `[]`. A repeat of the same request
   (the same seats again, a cancellation already recorded) is a no-op, not a refusal and not an invented event.
   - **Refuse** (a typed error, 4xx) only when the intent can't hold: another capacity for a course that exists, a
     cancellation for a trial that wasn't refused.
   - **Record an event** only when it is a fact something needs: a Paddle notification's outcome that closes its
     to-do item stays `paddleNotificationSkipped` "already done".
2. **In the model, "nothing happens" is a `then` step of its own** (`SPEC_NOTHING`: `emcli spec step add … then
   nothing "Nothing happens"`), standing alone in `then`; the scenario's title says why (e.g. "our answer of a
   cancellation already recorded: nothing happens"). It's stated, not an empty `then`: a scenario not yet finished
   has an empty `then` too, and must never be read as a no-op (found in emcli's own test fixture, whose happy paths
   have empty thens). It's tested with `thenNothingHappened()` / `thenNothingAppended(expectResponse(200))`.
3. **Over HTTP, the status says which it was** (Gary):

   | Outcome | Code |
   |---|---|
   | a change recorded | **204**, `ETag` = its position (**201** with the generated fields), as before |
   | **nothing new: the intent already holds** | **200, no body**, `ETag` = the position the decision was read at |
   | refused | **422** (`IllegalStateError`), 404, 400, as before |
   | a concurrent write changed what the decision read | **409**, as before |

   - The route calls `handleCommand()` and answers by `events.length`.
   - Both success codes are 2xx, so a client that checks only for success is unaffected; one that cares reads the
     status. Unlike Emmett, a retry after a lost 204 answers 200: the status reports what this request did.
   - emcli's contract adds the 200 to a command that has a "nothing happens" scenario.
4. **Inside the app** (an automation's `issue`, a workflow's activity): a decision of nothing is done, like any
   success. No special case.

**Alternatives considered:**
- **304 Not Modified.** Rejected: it's for conditional reads, and caches and clients would misread it on a POST.
- **204 for both, as Emmett's default.** Simplest; but Emmett's client tells a no-op by an ETag that didn't advance,
  and ours can't (a global position). Rejected.
- **200 with a body (`{ "changed": false }`).** Redundant with the status. Rejected: one rule, read the status.
- **409 Conflict or 422.** Rejected: they say the request failed, so a retry after a lost response would look like an
  error.

**Consequences:**
- **dcb-event-store:** phase 22 (PR #34, Gary merges). Licensing links the library with `file:`, so the merge must
  be on `main` and built before licensing relies on it.
- **Kit:** `build-state-change`: `[]` for a repeat, `thenNothingAppended(expectResponse(200))` for a "nothing happens" scenario, the route
  through `handleCommand()` and the 200 answer; `plan-change`: model a repeat as "nothing happens"; `build-automation`:
  a decision of nothing is done.
- **emcli:** the `SPEC_NOTHING` step (`then nothing`), rendered on the board as NOTHING HAPPENS and exported; the
  contract adds the 200 (no body) to a command with such a scenario (emcli `6228bf3`).
- **Licensing:** ADR-049's plan models our answer of a cancellation already recorded as "nothing happens". Built slices
  that refuse a repeat are found and replaced when next touched (PLAN).


### ADR-051: An automation's item waits for a missing data input; it never blocks the items behind it

**Status:** **Accepted, 2026-10-07 (Gary):** "wait on its own, blocking is bad for business". Proven the same day:
licensing's two owner automations, rebuilt by the loop with `waitsFor`, moved past the trial with no owner that had
blocked them at event 26, and the owner chain passed (10/10), on that database and on a reset one.
**Date:** 2026-10-07
**Changes:** ADR-039 decision 3 ("a missing value throws, and the processor retries the event").

**Context:**
- **What happened:** licensing's owner chain failed "the owner is an admin once the trial starts". "Owner admin role"
  and "owner web seat" read the data input `OrganisationOwner` and threw "no owner of organisation … yet" for a trial
  whose organisation had no owner (an end-to-end script's organisation that never registered). ADR-031's fail fast
  blocked each processor on that event, retrying with a growing backoff, so **every later organisation's owner waited
  behind one item that could never succeed**.
- **The same in production:** a trial for an organisation we don't know (bad `custom_data`), or one whose owner is
  removed, stops every new owner getting their role.
- **Fail fast is right for a fault of ours** (the store unavailable, a bug): every item would fail the same way, and
  blocking shows it at once. **A missing data input is a fact about one item:** the items behind it are fine.
- **The references:**
  - **The book (Dilger, ch. 35):** a to-do item is worked when the processor has what it needs; an item stays on
    the list until then, and the list shows it.
  - **Axon** (sagas, Axon 4 and 5's stateful handlers): a process waits for its correlated events, each event moving
    it on; nothing retries in a loop.
  - **Emmett** workflows: state gathers inputs, and `decide` returns nothing until they're all there.
  - **Enterprise Integration Patterns' Aggregator:** wait for the correlated messages, complete when the set is.

**Decision:**
1. **An automation with a to-do list never throws for a missing data input.** `act` returns without acting: the item
   stays open on the list, visibly waiting, and the processor moves on to the next event.
2. **The event that supplies the data input is a trigger too.** When it arrives, the automation step reads the item
   (still open) and the data input (now there) and acts. Nothing is retried, polled or timed: the work is done by
   the event that makes it possible. In the model, that event `reacts-to` the automation as well as the opening event.
   In code it's the automation's **`waitsFor`** (`defineAutomation`): the processor reads it too, and runs only the
   automation step for it, for the open item under the list's key tag. The list needn't fold it (a list that does,
   folds it first), and `triggers` stay the events the list folds, so a typo is still caught.
3. **Order doesn't matter.** With the data first (the usual case: the owner is assigned before the trial starts),
   the opening event acts at once. With the item first, the data's event acts. Either way the command's idempotency
   key (`<automation>:<item key>`) makes a second run a no-op.
4. **An item that can never be worked stays on the list.** It's an open item with no owner, seen on the list's
   screen like any other; no alert (it's not a failure of ours). A business rule for it (expire it, refuse the trial)
   is a model decision when one is needed.
5. **Throwing stays for faults:** an error from the store, a decider's refusal that shouldn't happen, a bug. Those
   block, as ADR-031 says.
6. **Out of scope:** a list of one (a translation, ADR-040) has no item to wait on. It keeps `giveUp`, which records
   the failure and moves on after its attempts.

**Alternatives considered:**
- **Retry the item with a backoff, apart from the others** (a per-item retry queue). Rejected: a timer of our own
  (ADR-031 leaves retries to Temporal), and it polls for a fact an event will tell us.
- **`giveUp` on the owner automations.** Rejected: it records a failure and alerts for what is only waiting, and it
  gives up on an item that would succeed a moment later when the owner is assigned.
- **The to-do list opens the item only when the data is there** (the list folds the owner too). Rejected: the list
  would hold rows that aren't to-do items, and it hides the data input the model shows (ADR-039).
- **Skip the event (Emmett's `skip()`).** Rejected: the work is lost unless something runs it again, which is
  decision 2 anyway.

**Consequences:**
- **The scaffold's helper:** `waitsFor` on an automation with a to-do list; the processor's query adds those events.
  Three tests: an item waiting doesn't hold up the next; the data's event works it; with no open item it does
  nothing. **Adding an event to a running processor's query** only sees it from the bookmark on: an item already
  waiting before the deploy is worked by the next such event, or by hand.
- **`build-automation`:** a null data input returns without acting; its event goes in `waitsFor`.
- **emcli's `event-model` method:** an automation's data input whose event can come after the trigger links that
  event to the automation (`reacts-to`).
- **Licensing:** "owner admin role on trial" and "owner web seat on trial" replaced before release (`plan-change`):
  each also reacts to the owner's `userWasAssignedToRole`, and waits when there's no owner. The owner chain gets a
  case: a trial before its owner, then the owner, then the roles.

### ADR-052: A read model held by another system is marked external, and nothing of ours builds it

**Status:** Proposed, 2026-10-08 (Gary: the session as a read model, marked by a property, not by prose).
**Date:** 2026-10-08
**Builds on:** ADR-039 (an automation's outside data), ADR-045 (an external event).

**Context:**
- **The case:** licensing's chapter 1 starts with "sign up", the sign-in provider's page, recording `userSignedUp`
  (`sub`, `email`) in the Auth lane. "Get Started" submits `registerUser`, whose `sub` and `email` are mapped
  `session:`. On the board nothing joins the two: the information that flows from the event to the screen isn't
  shown, against event modelling's own rule (an event reaches a screen through a read model).
- **That read model isn't ours:** it's the session the provider returns (the ID token's claims). We never store or
  project it. The web app reads it from the session (`useSession()`).
- **emcli already has the property:** `externalSystem` (`--external <System>`), exported as `context: EXTERNAL`.
  `build-automation` reads it as an outside system's data, fetched in an activity. Nothing else did. An external
  read model in a planned slice would have had a GET route in the contract, the default type `database-projected`,
  and a projection built by `build-state-view`.
- **Prose is no build hint:** a description saying "not stored" reaches the loop only as text it may or may not
  follow. A property is in `slice.json`, and every builder reads it the same way.

**Decision:**
1. **A read model another system holds is an information card in that system's lane, marked `--external
   <System>`.** It's linked like any read model: what fills it (`userSignedUp` hydrates the session), and what reads
   it, a screen (`displays`) or an automation (`relates-to`, ADR-039).
2. **Nothing of ours builds it.** emcli gives it no route (and leaves it out of `api/openapi.json`) and no read model
   type, and it makes **no job**: a slice holding nothing else of ours is exported Done, with nothing queued.
   `build-state-view` skips one and builds the rest of the slice; it never blocks for it (a slice of another
   system's things is a valid model). `build-screen` never fetches one from our API: a screen gets its fields from
   that system's client (for the sign-in provider, the session, as its command's `session:` mappings already do).
5. **Open: whose Sign Up form it is** (Gary, 2026-10-08), decided by the sign-in provider ADR. With Cognito we'd
   probably build the form ourselves against its auth endpoint (Amplify.js); with a hosted page it's the provider's.
   So the Sign Up screen and `userSignedUp` stay unmarked. **If the form is ours,** "sign up" is planned, its screen
   gets a ui job, the form calls the provider's browser library (as with Paddle.js, `build-screen`), and
   `userSignedUp` is the provider's answer. **If the page is hosted,** the screen card is marked external then.
   Either way the session read model stays external. **Closed by ADR-054 (2026-10-09): the form is ours,** built on
   Better Auth's client; "sign up" is planned with a ui job. **Revised by ADR-057 (2026-10-09):** the form is the
   kit's (scaffolded), and its card is marked `--external Auth`, so the loop makes no job for it.
3. **The card says so on the board:** "External: held by <System>, not projected (the screen reads it from
   <System>)", or for an automation's input, "(fetched by the automation, not projected)".
4. **`emcli completeness` warns** about one in a planned slice that no screen or automation reads.

**Alternatives considered:**
- **The description says "not stored".** Rejected (Gary): prose isn't a property the builders read.
- **A new read model type** (`session`, `external`). Rejected: the type says how *we* keep a read model current; this
  one we don't keep at all, which is what `externalSystem` already says.
- **No read model** (the screen's command maps `session:` and that's all). Rejected: the board then hides where the
  values come from.

**Consequences:**
- **emcli** (`95b8609`, `d439ba8`): no job for it (`concernsOf`); `standardEndpoint` is undefined for it, so no route, in the card's enrichment or the
  export; the contract skips it; the export gives it no `readModelType`; the card's held-by wording; the completeness
  warning; the `event-model` method says how to model the session. 429 tests.
- **Kit:** one rule each in `build-state-view` and `build-screen`.
- **Licensing:** "Signed In User" (`sub`, `email`), `--external Auth`, hydrated by `userSignedUp` and displayed on
  "Get Started", in **its own state-view slice**, "signed in user", after "sign up" (Gary, 2026-10-08: in one slice
  it read as if Sign Up read the session; the screen creates the event, the next slice shows it). emcli
  (`9e41dab`): another slice's event makes no job on its own, so that slice exports Done with nothing queued.
- **The board (2026-10-08):** the card shows its held-by line; the Sign Up mockup's method toggles (checkboxes and
  CSS `:has()`, no script) work in the board's preview; the push re-queued no built slice.
- **Proven when:** the card shows on the board with its held-by line, completeness is clean, and the export re-queues
  no built slice.

### ADR-053: An external event says how it reaches us; an endpoint is built only for a webhook

**Status:** Proposed, 2026-10-08 (Gary: "receiving external events via a webhook is the special case, not the
general case"; "we need this flexibility in our loop, whether we want an endpoint to be built or not").
**Date:** 2026-10-08
**Changes:** ADR-045 (any external event without a command had a slice that builds its webhook endpoint).

**Context:**
- **The case:** licensing's chapter 1 starts with the person signing up with the sign-in provider. Gary's shape
  (agreed): "sign up" (our form only), then "user signed up" (`userSignedUp`, Auth's event: we start it, Auth records
  it), then "signed in user" (the session, an external read model, ADR-052), which "Get Started" reads.
- **`userSignedUp` is an external event,** but nothing of ours records it: it stays in Auth, and we see what it
  leaves behind, the session. Marking it `--external` made emcli infer an `external` slice, exported as
  `EXTERNAL_EVENT`, and the loop builds a webhook inbox for that (ADR-045). That rule came from Paddle, where a
  webhook is the way in.
- **A webhook is one way in, not the definition:** another system's event may be sent to us (a webhook), fetched (a
  poll), or left where it is.

**Decision:**
1. **An external event has an `intake`** (emcli `--intake`), how it gets into our event store:
   - **`webhook`:** it's sent to us and recorded as it arrives; its slice is `EXTERNAL_EVENT` and the loop builds the
     endpoint (ADR-045, unchanged). Paddle's `paddleNotificationReceived`.
   - **`none`:** it stays in its system. Nothing is built or recorded for it (no endpoint, no `Events.ts` entry); only
     an external read model may show it. Auth's `userSignedUp`.
   - **`fetched`** is left until a case needs it (Paddle Sync records the same event the webhook does).
2. **Unset builds nothing.** emcli's completeness warns until the model says; the event makes no job.
3. **Completeness errors** when an event left in its system feeds one of our read models, triggers our automation or
   command, or is given in one of our scenarios: we can only project, react to or test what we record.
4. **Built slices stay built:** every external event the loop built so far came in by webhook, so a built slice whose
   only difference is `intake: "webhook"` stays Done (emcli's fingerprint check, as for v5's prose). Another slice's
   copy or given of the event isn't affected by its intake.

**Alternatives considered:**
- **Infer it from the field mappings (`webhook:`).** Rejected: `webhook:` names where a value comes from in the
  other system's payload, which holds for the session too; it says nothing about whether we receive the event.
- **Keep webhook the default.** Rejected (Gary): it makes the special case the general one, and an endpoint gets built
  without anyone deciding it.
- **Don't mark `userSignedUp` external.** Rejected: it is Auth's event; the marker is what tells the board and the
  builders so.

**Consequences:**
- **emcli** (`2d3fae2`): `--intake`, `inferSliceType`, `concernsOf`, the export, completeness, the card's wording
  ("left in Auth (not recorded)", "recorded as it arrives (webhook)"), the pull, the schema; the `event-model` skill
  (slicing: choosing the intake; the sign-up shape). 436 tests.
- **Kit:** the loop's prompt and `build-automation` build the endpoint only for `intake: "webhook"`; `provider-paddle`
  names it; `plan-change` says how a change of intake goes.
- **Licensing:** `paddleNotificationReceived --intake webhook`; `userSignedUp --external Auth --intake none` in its own
  slice, "user signed up", between "sign up" and "signed in user".
- **Follow-up:** "start trial checkout" holds the "Choose How to Start" screen and Paddle's event in one slice; split
  it to the same principle through `plan-change`.

### ADR-054: Where the platform runs: hosting, database, sign-in, web app

**Status:** Accepted, 2026-10-09 (Gary). Proposed 2026-10-08. The analysis below was written before the decision
(the matrix, the shortlist, the Supabase working assumption); the Decision section is what holds.
**Date:** 2026-10-08
**Builds on:** ADR-037 (sign-in: OIDC with PKCE, one JWKS check, our own `userId`), ADR-052 point 5 (whose Sign Up
form it is).
**Decision matrix:** https://claude.ai/artifact/EArHLdWp3QLRFp7PPx2ufG (adjustable weights, costs, sources).

**Context:**
- **It started as the sign-in provider ADR.** Scored alone, Supabase Auth led, mainly because users sit in our own
  Postgres. That only holds when our database is Supabase. Supabase doesn't run long-running containers: its Edge
  Functions are short-lived Deno functions. So the provider can't be chosen apart from where everything else runs
  (Gary). This ADR covers the whole platform, and sign-in is one part of it.
- **What has to run** (licensing, checked in the code; the current state, not a constraint):
  - **The API and processors:** a Node/TypeScript container (Express). They need public HTTPS for Paddle's
    webhooks.
  - **The event store:** Postgres 16. `dcb-event-store` uses `LISTEN`/`pg_notify` (`PostgresEventStore.ts`) and
    `pg_advisory_xact_lock` (`lockStrategy.ts`, `projectionLock.ts`). **It needs a direct or session-mode
    connection:** a transaction-mode pooler drops LISTEN and session state. On Supabase, that's the direct
    connection (IPv6, or the $4 IPv4 add-on) or the session pooler (IPv4 on every plan).
  - **Temporal:** a 1.31 server and a TypeScript worker. Either Temporal Cloud (pay as you go, London region), or
    the server run ourselves on its own Postgres database.
  - **The web app:** a React + Vite SPA. It needs static hosting with a CDN, our domain and TLS.
  - **Mobile, later:** iOS and Android, using OIDC with PKCE.
  - **Around them:** DNS, certificates, email (sign-in and our own), secrets, logs, backups, CI/CD and
    infrastructure as code.
- **Gary's position:**
  - TypeScript front and back, Postgres and containers.
  - He knows AWS and CDK. That's a lean, and it counts as the matrix's familiarity weight, not a choice.
  - He's open to other platforms with strong features, and to mixes (AWS with Supabase for the database and/or
    sign-in).
  - Supply Hub's AWS setup is legacy, and is no reference.
- **Every option passes these gates:**
  - an Isle of Man company can contract with it (to confirm at sign-up);
  - every sign-in provider's tokens verify against a JWKS;
  - Android and iOS can sign in.
  UK/EU residency is an optional gate. US transfers are lawful under the UK extension to the Data Privacy
  Framework, so it's a commercial choice.

**The options, as whole stacks.**
- **Scores** are out of 100, under the default weights: familiarity and CDK 15, little to run 15, total monthly cost
  15, sign-in fit 15, leaving 10, residency 10, backups/recovery/exposure 10, local development 10, vendors 5,
  web/DNS/email 5.
- **The cost criterion counts the connections between the parts as well:** NAT, IPv4 addresses, and point-in-time
  recovery.
- **The exposure criterion asks** whether the database can be reached from the internet.

| Stack | Score | Monthly cost, 2k / 20k users | Main strength | Main cost |
|---|---|---|---|---|
| AWS + sign-in in our backend (Better Auth on RDS) | 86 | ≈$100 / ≈$170 | one vendor, users in our Postgres, the real sign-in runs locally | sign-in security is ours |
| AWS + Supabase Auth only | 85 | ≈$135 / ≈$200 | CDK for all we host; sign-in runs locally | users in a database we don't otherwise use |
| AWS compute + Supabase (database and sign-in) | 83 | ≈$110 / ≈$195 | managed database and sign-in in one; users beside the events | two vendors; the database is on the internet; outside CDK; point-in-time recovery $100/mo |
| All AWS (Fargate, RDS, Cognito) | 77 | ≈$100 / ≈$315 | one account, all CDK, database private | no real local Cognito; password hashes can't be exported |
| AWS + Auth0 | 76 | ≈$100 / ≈$165 | mature, UK region, free to 25k | steep price step after 25k; cloud-only |
| AWS + Clerk | 74 | ≈$125 / ≈$190 | best developer experience, native SDKs | users held in the US only; cloud-only |
| Google Cloud (Cloud Run, Cloud SQL, Identity Platform) | 64 | ≈$90 / ≈$150 | one vendor, strong mobile sign-in | new cloud; Cloud Run needs CPU always on for LISTEN and the worker |
| Fly.io (London) + Clerk + Cloudflare | 62 | ≈$80 / ≈$130 | simplest deploys | new tools, three or four vendors |

- **AWS stacks need no NAT gateway.** Their tasks sit in public subnets, each with a public IP (about $3.60), and
  RDS stays private.
- **Temporal is extra in every stack:** Temporal Cloud at about $5–20 a month at our volume (to confirm), or about
  $30–40 to run ourselves.

**What the matrix shows** (it informs the decision, it doesn't make it):
- **AWS for compute** leads every other base by about 15 points, and still by about 10 with the familiarity weight
  at 0:
  - ECS on Fargate. App Runner closed to new customers in April 2026; ECS Express Mode fills its role.
  - RDS, CloudFront, Route 53 and SES cover the other parts, all in CDK.
- **Local development (added at Gary's request) separates the sign-in options.**
  - **Run for real on a laptop, in the e2e journeys and in CI:** Better Auth (it is our backend), Supabase Auth
    (`supabase start`), Zitadel and Keycloak.
  - **Cloud-only:** Cognito, Clerk and Auth0. They need a stand-in locally (`mock-oauth2-server`, as now) plus a
    second test run against the cloud, as with Paddle's mock and sandbox. LocalStack's Cognito emulation needs a
    paid plan for commercial use since March 2026, and it isn't the real service.

**Working assumption and shortlist** (Gary, 2026-10-08; not decisions):
- **Our Postgres is Supabase's** (London), whichever sign-in we choose. The containers run on AWS (Fargate), and
  the web app on CloudFront.
- **The sign-in shortlist** is three, compared in the matrix's third tab. That tab uses the sign-in criteria plus
  "Deploys with CDK" (weight 5); "Fits the hosting" is narrowed to where users live and how many vendors there are.

  | | Supabase Auth | Better Auth | Cognito |
  |---|---|---|---|
  | Score | 88 | 83 | 72 |
  | Users live | `auth` schema in our database | its tables in our database | Cognito |
  | Runs locally, for real | yes (`supabase start`) | yes (it's our backend) | no (stand-in, plus a cloud run) |
  | Token claims (`userId`, roles) | a Postgres hook that can read our tables | our TypeScript | a Lambda |
  | Sign-in security (attacks, patching) | Supabase's | ours | AWS's |
  | Deploys | CDK + `supabase config push`; the hook as a migration | CDK only | CDK only |
  | Leaving | users and bcrypt hashes are ours | already ours | hashes can't be exported |
  | Extra cost at 20k users | $0 (included in Pro) | ≈$5 email | $150 (Essentials) |
  | Maturity | widely used | young; part of Vercel since July 2026; critical fixes in 2026 | long-running |

- **Supabase Auth's lead over Better Auth rests almost entirely on one criterion: who carries sign-in security.**
- **With either, the role-sync slices may shrink.** Supabase Auth's hook can read roles straight from our tables when
  it issues a token, and Better Auth writes to its tables in our database. ADR-037's four role-sync slices might
  then get smaller. This is to be worked out in its own ADR before we rely on it.

**What Supabase as our Postgres involves** (any sign-in choice; not yet proven):
1. **The connection.** The event store holds a `LISTEN` connection and advisory locks, so it needs the direct
   connection (IPv6, or the $4 IPv4 add-on) or the session pooler (IPv4, port 5432). Never the transaction pooler
   (port 6543).
2. **The network path.** The connection runs over the public internet with verified TLS (`sslmode=verify-full`);
   there's no private link below the Enterprise plan. To allow only our IP at Supabase, the tasks need a fixed
   outbound IP:
   - a NAT instance: CDK's `NatProvider.instanceV2`, about $4/mo, ours to patch, no failover;
   - or a NAT gateway: about $35–70/mo.
3. **The Data API.** Supabase publishes the `public` schema through its REST API. Our tables go in our own schema
   (through `search_path`), or the Data API is switched off.
4. **Connection limits.** Each compute size caps connections, so size each container's pool, plus its `LISTEN`
   connection, to the plan. Temporal Cloud avoids a second database.
5. **Deploys and migrations.**
   - **Read-model changes need no migration:** the app rebuilds a changed read model from the events at startup
     (`ensureProjectionsCurrent`), and the event store installs its own tables (`ensureInstalled`).
   - **Everything else goes through one TypeScript migration tool** (node-pg-migrate is the candidate): grants, our
     schema, the sign-in tables or hook. A CDK Trigger runs it as a one-off ECS task before the new version starts.
   - **Supabase's project settings sit outside CDK:** `supabase config push` from `supabase/config.toml`, or
     Supabase's Terraform provider. CDK for Terraform was deprecated in December 2025.
6. **Proving it:** point licensing at a Supabase project from a laptop and run the journey. That settles 1, 3 and 4
   before any AWS work. It needs Gary to create the Supabase account.

**Decision** (Gary, 2026-10-09):
1. **Two ways to deploy.**
   - **Our cloud** for customers who want it: AWS in London, deployed with CDK.
   - **On-premises** for customers who run the platform on their own infrastructure: the same containers from a
     package (Docker Compose, later Helm).
   - **Locally and in CI:** the on-premises shape.
2. **Postgres:**
   - **in our cloud,** RDS for PostgreSQL, in private subnets;
   - **on-premises and locally,** Postgres in a container.

   Supabase's working assumption is dropped: it would put the database on the internet, and it isn't there
   on-premises. Both are plain Postgres, so the event store, the read-model rebuilds and the migrations work the same
   on each.
3. **Sign-in is Better Auth, everywhere.**
   - **Its own small service:** the same repo, its own container, with its tables in our Postgres. It issues
     signed JWTs and serves a JWKS.
   - **The API checks tokens as ADR-037 says** (one JWKS check), so sign-in stays a separate system in the model
     (the Auth lane) and stays swappable.
   - **The same sign-in runs in our cloud, on-premises, on a laptop and in CI.** Locally it replaces
     `mock-oauth2-server`.
4. **The Sign Up form is ours** (ADR-052 point 5), built on Better Auth's client. (ADR-057: provided by the kit's
   scaffold, not built by the loop.)
5. **Around it:**
   - **Email:** SES in our cloud; any SMTP server on-premises, with Mailpit locally.
   - **Temporal:** Temporal Cloud or self-hosted in our cloud; always self-hosted on-premises.
   - **The web app:** CloudFront in our cloud; served from a container on-premises.
   - **No NAT gateway in our cloud:** tasks in public subnets with public IPs, and RDS private.
6. **Migrations.**
   - **Read models need none:** they're rebuilt from the events at startup.
   - **Everything else goes through node-pg-migrate:** grants, schema, and Better Auth's tables (generated by its
     CLI, then committed).
   - **How it runs:** as a one-off task before the new version starts. In our cloud, a CDK Trigger runs an ECS task;
     on-premises, an init container.

**Alternatives considered:**
- **Supabase Postgres + Supabase Auth.** Scored highest with Supabase as our Postgres, and Gary favoured it on
  2026-10-08. Rejected:
  - on-premises it means running Supabase's sign-in server (GoTrue) as well;
  - in our cloud the database is reachable from the internet, so it needs a fixed IP or reliance on TLS and a
    password, plus the Data API locked down;
  - its settings deploy outside CDK.
- **Cognito.** Rejected: AWS-only, so it can't go on-premises; no real local version; password hashes can't be
  exported. It was the all-AWS stack's weakest part.
- **Clerk, Auth0, WorkOS, Kinde.** Rejected: cloud-only, so not available on-premises (and Clerk holds users in the
  US only).
- **Better Auth inside the API process.** Rejected: it would blur ADR-037's boundary. A separate service keeps sign-in
  swappable and its model lane honest.

**Consequences:**
- **Security patching is ours, and multiplied.**
  - Vercel (owner since July 2026) fixes the library. We must ship each fix to our cloud and to every on-premises
    install.
  - So we need a security-release process: advisory alerts on `better-auth`, pinned versions, and a patch path for
    on-premises customers (PLAN 2b.2c).
  - Vercel's ownership brings funding but no guarantee. The MIT licence means we can always fork.
- **Sign-in security in operation is ours:** Better Auth's rate limiter (stored in Postgres, so it holds across
  instances), breached-password checks, and AWS WAF rate rules in our cloud.
- **On-premises customers will want their own SSO** (Entra ID, Okta). Better Auth's SSO plugin is young, so it gets
  checked early (PLAN 2b.2b).
- **On-premises shapes the deployment work (14.8):**
  - CDK covers only our cloud; on-premises gets a container package;
  - Temporal is self-hosted there;
  - SMTP replaces SES;
  - Paddle's webhook and API need internet access;
  - the mobile apps take a configurable server address.
- **Licensing:**
  - prove sign-in locally first (PLAN 2b.2a): Better Auth replaces `mock-oauth2-server`, with Mailpit, and journey
    case 1 signs up for real;
  - then the Sign Up form (ours), gap 2 (`userId` in the session) and the four auth role-sync slices. Whether
    Better Auth's tables in our own database simplify those slices gets its own ADR.
- **The matrix** (https://claude.ai/artifact/EArHLdWp3QLRFp7PPx2ufG) keeps the comparison, with the decision shown.

### ADR-055: Sign-in ships with the kit, configured by deployment

**Status:** **Accepted, 2026-10-09 (Gary).** Part 2 Accepted the same day. Proposed 2026-10-09 (Gary: "this will be deployed with the kit as well and should be configurable based
on the deployment type, cloud or on-premises").
**Date:** 2026-10-09
**Builds on:** ADR-037 (one JWKS check, our own `userId`), ADR-052 (the session is an external read model), ADR-053
(`userSignedUp` stays in Auth), ADR-054 (Better Auth everywhere, as its own service; two deployment shapes).

**Context:**
- **ADR-054 chose Better Auth for every deployment.** Every project the kit scaffolds needs it, so it belongs in
  the scaffold (`templates/root`), not only in licensing.
- **Licensing today** (checked 2026-10-09; PLAN's wording was ahead of the code):
  - **there is no `mock-oauth2-server`:** the web app's session stub (`web/src/lib/session.tsx`, `RequireSession`)
    asks the person to type `sub`, `email` and `userId`, and keeps them in the browser;
  - **the API checks no token:** `registerUser` takes `sub` and `email` from the request body;
  - **the model's session mappings:** `sub`, `email` (registerUser) and `userId` (activateOrganisation's
    `activatedBy`; gap 2).
- **Better Auth's official docs are the starting point for every file:**
  - installation;
  - the client;
  - the JWT plugin;
  - email;
  - email and password;
  - Express;
  - the PostgreSQL adapter;
  - cookies;
  - the CLI.

**Decision:**
1. **The sign-in service is part of the scaffold:** `auth/`, its own package, Dockerfile and container, in the same
   repo.
   - **Express 5,** with `app.all("/api/auth/*splat", toNodeHandler(auth))` mounted before any body parser, as the
     Express docs say, and `GET /health`.
   - **Its tables go in an `auth` schema in our Postgres:** `new Pool({ connectionString, options: "-c
     search_path=auth" })`, as the PostgreSQL adapter docs show.
   - **Email and password, with the email verified at sign-up:**
     - `requireEmailVerification`;
     - `sendOnSignUp` and `autoSignInAfterVerification`;
     - the email is sent without being awaited (the docs' timing-attack warning).
   - **The JWT plugin issues the token the API checks:**
     - its payload is `email` and `email_verified` (`definePayload`);
     - `sub` is Better Auth's user id;
     - the issuer and audience are `BETTER_AUTH_URL`;
     - tokens last 15 minutes and are signed with EdDSA keys;
     - the JWKS is at `/api/auth/jwks`.
   - **Rate limits are stored in Postgres,** so they hold across instances, and telemetry is off.
   - **`better-auth` is pinned to an exact version:** security releases are ours (ADR-054, PLAN 2b.2c).
2. **One setting chooses the deployment: `DEPLOYMENT=cloud | on-premises`.** Locally and in CI it's on-premises
   (ADR-054). `auth/src/config.ts` reads the environment, applies the deployment's defaults, and refuses to start
   if a required setting is missing.

   | Setting | cloud (AWS) | on-premises (also local and CI) |
   |---|---|---|
   | Email | SES, through nodemailer's SES transport with the task's IAM role | SMTP, `SMTP_URL` (Mailpit locally) |
   | Secure cookies | always | when `BETTER_AUTH_URL` is https |
   | Client IP for rate limits | the header CloudFront sets | `AUTH_IP_HEADER`, default `x-forwarded-for` |
   | How `/api/auth` reaches the service | a CloudFront behaviour (14.8) | the web container's reverse proxy (14.8); Vite's proxy locally |
   | Secrets | Secrets Manager, injected as environment variables | environment variables or `.env` |

   **The API's settings are the same in both:** `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AUTH_JWKS_URL`.
3. **The sign-in cookie is first-party; the API takes a bearer token.**
   - **Sign-in is served under the web app's origin at `/api/auth`.** The cookie docs warn that Safari blocks
     cookies from another domain and recommend a reverse proxy.
   - **The API stays on its own origin.** The web app sends `Authorization: Bearer <jwt>`, taken from
     `authClient.token()` (the JWT docs' recommended way) and cached until shortly before it expires.
4. **The API's token check is ADR-037's single piece of sign-in-aware code** (`src/shared/signIn.ts`).
   - It uses `createRemoteJWKSet` and `jwtVerify` from `jose`, as the JWT docs show.
   - It checks the issuer, the audience, expiry and `email_verified`.
   - The verified claims go on the request for routes to read.
   - An invalid or expired token gets a 401.
   - CORS allows the `Authorization` header.
   - **For now a request without a token passes, as before.** Which routes require one is part 2 below.
5. **The web app's session comes from Better Auth in live mode.**
   - `authClient.useSession()` gives `{ sub: user.id, email }`.
   - `RequireSession` shows a sign-in form (`authClient.signIn.email`), and signing out calls
     `authClient.signOut()`.
   - **Mock mode and the tests keep the stub,** so screens that are already built don't change.
6. **Migrations follow ADR-054 point 6.**
   - **Better Auth's tables** come from its CLI (`npx auth@latest generate`). They're committed as a node-pg-migrate
     migration in `auth/migrations/`, with its tracking table in the `auth` schema.
   - **Compose runs them as a one-off `auth-migrate` service** before `auth` starts (the init container). In our
     cloud the same image runs as the CDK Trigger's task (14.8).
7. **Compose adds three services:**
   - `mailpit` (SMTP on 1025; its UI and API on 8025);
   - `auth-migrate`;
   - `auth` (port 3001).
8. **What stays in the model:**
   - **Sign Up is our form** (ADR-052 point 5, ADR-054). "sign up" is planned with a ui job, and the loop builds it
     with a new provider skill, `provider-better-auth` (a draft until its first slice and the journey pass).
     **Revised by ADR-057:** the kit's scaffold provides Sign Up, Sign In and "check your email"; their cards are
     marked `--external Auth`, and the loop builds none of them.
   - **Signing in is scaffold:** it records nothing in our model.

**Part 2: Accepted 2026-10-09 (Gary).** The signed-in person's values come from the token; gap 2 is closed; an
`identity` context.
- **The rule: a value the model maps `session:<key>` comes from the verified token or the lookup, never from a body,
  a path or a query string.** It applies everywhere the mapping is used:
  - a command's field;
  - a read model's key (Gary: `GET /my-account`, with `sub` from the JWT, never `/my-account/{sub}`);
  - a query parameter, when a case needs one. emcli's query parameters map document fields today, so a
    session-sourced one needs its own marking then.

  **A route with any such value requires sign-in:** 401 without a valid token. The `session:` mapping is the marker:
  the model already says "the signed-in person's own", and the kit enforces it everywhere (Gary asked whether this
  generalises; it does).
- **Which keys come from where:**
  - **from the token:** `sub` (Better Auth's user id) and `email`;
  - **from the lookup:** any other key (`userId`). The API resolves it from the verified `sub` through **one read
    model the model marks `--session-lookup`.** That read model is keyed by `sub`, and its other fields are session
    keys (licensing: My Account gives `userId`).

  Better Auth knows nothing of our ids (ADR-037). A signed-in person the lookup doesn't know (signed up, not yet
  registered) gets **403, "register first"** from a route that needs such a key.
- **emcli:**
  - the API contract leaves `session:` fields out of bodies and paths, and marks those operations `bearerAuth` with
    their 401 and 403;
  - a read model keyed by a `session:` key is `GET /<read-model>`;
  - `--session-lookup`;
  - completeness errors at hand-off when a key has no lookup holding it.
- **Kit:**
  - `src/shared/signIn.ts` gains `requireSession(keys)` and `sessionOf(res)`, and `configureSignIn({ lookup })`;
  - `build-state-change`, `build-state-view` and `build-screen` follow the rule;
  - `plan-change`: moving a field onto or off `session:` changes the command's body, so it's "a change other slices
    use" when another slice issues the command.
- **Our own sign-in concerns get their own context, `identity`** (Gary, 2026-10-09).
  - **`identity` holds:**
    - our user (`registerUser`, My Account, the lookup);
    - later, the automations that copy roles to Auth (ADR-037);
    - the follow-ups to account changes (ADR-056).
  - **`licensing` keeps** organisations, seats, roles and billing, and refers to people only by `userId`.
  - **Better Auth's own data stays in its service** (the Auth lane, not a context of ours).
  - **A context is a chapter's** (emcli), so `identity` is its own chapter, "0. A person signs up and registers".
    Chapter 1 opens with copies of its events (ADR-038). The export's `originContext` tells the builder where an
    event comes from.
    *(Superseded by ADR-059, 2026-10-09: a context's events stay in it. Chapter 1 keeps no copy, and licensing learns
    who is registered from the session lookup.)*
  - **Each later sign-in flow gets its own chapter:** signing in and out, recovering a password, changing the email,
    a second factor, and sign-up's unhappy paths (ADR-056).
- **Licensing:**
  - "register user" and "my account" are rebuilt in `identity`, and the old ones deleted (only the UI called them, so
    this is safe before release);
  - "activate organisation" is replaced, with `activatedBy` from the lookup;
  - the journey no longer types a user id.

**Alternatives considered:**
- **Better Auth inside the API process.** Rejected in ADR-054, because it blurs ADR-037's boundary.
- **The sign-in cookie sent straight to the API** (the API reading Better Auth's session with `getSession`). Rejected:
  - every service would then depend on Better Auth's cookie;
  - the mobile apps can't use it;
  - the JWKS check is what ADR-037 decided.
- **`npx auth migrate` at the service's startup.** Rejected: ADR-054 chose one migration tool, run before the new
  version starts.
- **A separate flag for each difference** (`EMAIL_TRANSPORT`, `SECURE_COOKIES`, …) with no deployment type.
  Rejected: a deployment type sets them together, so an install can't end up half one shape and half the other.
  Each can still be overridden on its own.

**Consequences:**
- **Kit:**
  - the scaffold gains:
    - `auth/`;
    - `src/shared/signIn.ts`;
    - the web app's `auth-client.ts`, live session, bearer middleware and Vite proxy;
    - three Compose services;
  - the instructions gain:
    - the `provider-better-auth` skill;
    - a rule in `build-screen`;
    - a section in the manual.
- **Licensing** takes it through `kit-drift`.
  - Journey case 1 signs up for real once "sign up" is built: it reads the verification email from Mailpit, and
    waits on state with a deadline.
  - Case 3 types the user id until part 2.
- **Proven when:**
  - the services start;
  - a sign-up puts a verification email in Mailpit;
  - the API accepts the token and refuses a tampered one;
  - the journey passes 8/8 on the mock and the sandbox.
- **The cloud configuration is covered by tests only** until 14.8 deploys it.
- **Found while building (2026-10-09):**
  - **Better Auth skips its origin check when `NODE_ENV=test`** (`skipOriginCheck` defaults to `isTest()` in
    1.7.7).
    - That check is its CSRF protection, so a deployment configured with `NODE_ENV=test` would run without it.
    - `auth/src/auth.ts` sets `advanced.disableOriginCheck: false`, so the check always runs, and
      `server.tests.ts` proves it: a request with cookies from an untrusted origin gets a 403, and so does a
      redirect to one.
    - Recheck after every Better Auth upgrade (2b.2c).
  - **The client IP behind proxies.**
    - **The rule:** Better Auth trusts a single-value IP header, and walks a forwarded chain (`x-forwarded-for`)
      only for proxies named in `advanced.ipAddress.trustedProxies`. Otherwise every request shares one rate-limit
      bucket, and it logs a warning.
    - **Locally,** Vite's proxy sends a single `x-forwarded-for` (`xfwd`).
    - **On-premises,** the customer's reverse proxy goes in `AUTH_TRUSTED_PROXIES`.
    - **In our cloud,** a CloudFront Function must set `x-client-ip` from the viewer's address, overwriting any value
      the client sent (PLAN 14.8).
    - **Explained** in `docs/case-studies/reverse-proxies-and-client-ip.md`.

### ADR-056: The account security lifecycle (open)

**Status:** Proposed, open; the second factor is settled: one opinionated default for now (2026-10-09, below). Proposed 2026-10-09 (Gary: "we can defer these decisions until later … as long as we don't lose
record that we need to have these policies and decisions made in line with best practices and what configuration
options are available within Better Auth"). It is decided after ADR-055 is built in the kit and licensing
(PLAN 2b.2d).
**Date:** 2026-10-09
**Builds on:** ADR-054 (Better Auth everywhere), ADR-055 (sign-in in the kit).

**Context:**
- **ADR-055 builds only email verification at sign-up.** Everything else a person does with their account stays
  off until this is decided:
  - recovering a forgotten password;
  - changing the password or the email;
  - a second factor;
  - signing in without a password;
  - sessions;
  - deleting the account;
  - security notices.
- **The policy is the same for every customer; how it applies differs by app and by deployment.** Web and mobile
  need different mechanics. On-premises customers may sign in through their own SSO (PLAN 2b.2b), which brings its
  own MFA.
- **Recommendations follow NIST SP 800-63B and OWASP's authentication cheat sheets.** The options are Better Auth's,
  from its docs (options reference; email and password; email; users and accounts; the Two-Factor, Magic Link,
  Email OTP, Phone Number, Passkey, Have I Been Pwned, Captcha, Multi Session and OAuth 2.1 Provider plugins).

**The questions, Better Auth's options, and a recommendation for each:**

| Concern | Better Auth | Recommendation |
|---|---|---|
| Email verification at sign-up | `requireEmailVerification`, `sendOnSignUp`, `emailVerification.expiresIn` (default 1h) | **On** (ADR-055); `autoSignInAfterVerification` |
| Forgotten password | `sendResetPassword` (an emailed link), `resetPasswordTokenExpiresIn` (default 1h), `revokeSessionsOnPasswordReset` (default false), `onPasswordReset`; Email OTP can send a code instead | **An emailed single-use link, valid 1h, that ends every session.** The same answer whether or not the account exists. No reset by SMS (SIM swap) and no security questions. **Mobile gets an emailed code** (Email OTP), because a link opens the browser, not the app |
| Changing the password | `changePassword({ currentPassword, newPassword, revokeOtherSessions })` | **The current password is required, and every other session ends.** A notice is emailed |
| Changing the email | `user.changeEmail`, with `sendChangeEmailConfirmation` (confirmed at the current address first), then the new address verified | **Confirmed at the old address, verified at the new one, and the old one told.** Our `userWasRegistered.email` then goes stale, so our model needs an "email changed" follow-up |
| Password rules | `minPasswordLength` (default 8), `maxPasswordLength` (default 128); the Have I Been Pwned plugin | **At least 12 characters, no composition rules, breached passwords refused** |
| A second factor | the Two-Factor plugin: TOTP (an authenticator app); OTP through our own `sendOTP` (email or SMS); backup codes; trusted devices (30 days); lockout. Both methods can be on at once; passkeys come from the Passkey plugin | **Every method is built, and the policy is set per role** (Gary, 2026-10-09; see below). Backup codes with the app. SMS only if a customer insists: NIST restricts it, each message costs, and a provider must work for an Isle of Man company |
| Who must use which | our policy, enforced in the sign-in service's hooks from the person's roles, which reach Auth through the role-sync slices (ADR-037) | **The defaults: the owner uses a passkey (an app is allowed); admins and engineers use an emailed code.** Each customer can change the policy per role (below). SSO customers get MFA from their own provider |
| Without a password | Magic Link, Email OTP, Passkey (WebAuthn; works with Expo) | **Passkeys in the long run:** they resist phishing and fit biometrics on web and mobile. Magic links only on the web, if at all |
| Web and mobile | one server, one set of rules; mobile through the Expo client or the OAuth 2.1 Provider plugin (native apps: OIDC with PKCE, as ADR-054 assumed) | **The same policies, with different mechanics:** on mobile, codes instead of links, passkeys or biometric unlock, longer sessions that refresh |
| Sessions | `session.expiresIn` (default 7 days), `updateAge` (default 1 day); Multi Session; ending all sessions | **Set per app** (web portal, mobile); "sign out everywhere" in the account settings |
| Deleting the account | `user.deleteUser`, with `sendDeleteAccountVerification`, `beforeDelete`, `afterDelete` | **Its own ADR:** our events hold personal data (the email), so this needs a GDPR answer (crypto-shredding or redaction) |
| Abuse | `rateLimit` (stored in Postgres, ADR-055), the Captcha plugin, the 2FA lockout | **Rate limits on.** A captcha on sign-up only if bots appear |
| Security notices | hooks on sign-in, reset and change | **Email on:** the password changed, the email changed, 2FA turned off, a sign-in from a new device |

**The second factor: settled in principle** (Gary, 2026-10-09; the details are confirmed in 2b.2d):
- **Every method is built, and the policy is set per role.** The methods are:
  - an emailed code;
  - an authenticator app (TOTP) with backup codes;
  - a passkey;
  - SMS only if a customer insists (see the table).

  What a role must use is configuration, not code.
- **Each customer can change the policy for its own roles:**
  - in our cloud, per organisation;
  - on-premises, per install.
- **The defaults** (agreed):

  | Role | Default | Also allowed |
  |---|---|---|
  | owner | **a passkey** (Touch ID, Face ID, Windows Hello or a security key) | an authenticator app |
  | admin | **an emailed code** | a passkey, an authenticator app |
  | engineer | **an emailed code** | a passkey, an authenticator app |

  "Remember this device" lasts 30 days for every role.
- **Why:**
  - **An emailed code is enough for most people.** It stops a stolen or reused password, the commonest attack. It
    doesn't help if the inbox itself is taken, because the same inbox can reset the password; that's an acceptable
    trade for this data.
  - **People resist installing an authenticator app** unless the data is sensitive (Gary: as with the NHS app).
  - **The owner controls billing and handing over ownership,** so they need a factor that doesn't depend on the
    inbox. A passkey gives that with nothing to install, and it resists phishing.
- **Settled (Gary, 2026-10-09): start with the simplest default.**
  - **One opinionated default configuration,** the table above, set in the sign-in service. There's no per-customer
    policy for now: how a customer changes it, and where that's stored, come later. When they do, I recommend that
    customers may only tighten a default.
  - **The owner signs in with a passkey.** NIST counts a passkey as multi-factor on its own (the device plus the
    biometric), so the owner's passkey sign-in is their two factors. Better Auth's Passkey plugin provides it. Check
    how Better Auth records the sign-in method (for example, the Last Login Method plugin) when it's built.
  - **Enforcing by role still needs the roles in Auth,** which arrive through the role-sync slices.
- **Terms:** "TOTP" strictly means an authenticator app's time-based codes; an emailed code is an OTP.

**Each decision also says whether it differs by deployment** (ADR-055's `DEPLOYMENT`). For example, an
on-premises customer may turn password sign-in off in favour of their SSO.

**Sign-up's unhappy paths: each its own chapter, later** (Gary, 2026-10-09: "we do not model branching on a
chapter", ADR-038). Chapter 1 stays the happy path. What Better Auth 1.7.7 does today, as configured (checked in its
source), and what each chapter has to decide:

| Path | What happens now | To decide in its chapter |
|---|---|---|
| The email is never verified | The account sits in `auth.user` with `emailVerified = false`. Sign-in is refused (403). Nothing reaches our model or Paddle: there's no `userId`, no organisation, no checkout. It's never cleaned up | Remind them? Remove stale unverified accounts after N days (a scheduled job in the sign-in service)? |
| They try to sign in unverified | 403, and the link is sent again (`sendOnSignIn`, set 2026-10-09 so the sign-in form's message is true) | A "send the link again" button without signing in? |
| The link has expired (1 h, `emailVerification.expiresIn`) | Redirected to the `callbackURL` with `?error=TOKEN_EXPIRED`; **our screens don't show it yet** | A page that explains it and offers a new link |
| They sign up again with the same email | **The same "check your email" answer, with no email sent** (Better Auth's generic duplicate response, so addresses can't be probed). Someone who lost the first email is stuck until they try to sign in | `onExistingUserSignUp`: email "you already have an account" (with a sign-in or reset link), or resend the verification if unverified |
| They mistyped their address | "Sign up again" on the check-your-email screen; the mistyped account is left unverified | Covered by stale-account cleanup? |
| The email can't be sent (SMTP or SES down) | The send isn't awaited (timing attacks); the failure is only logged in the sign-in service | An alert (ADR-043's alerting?) and a resend path |
| Too many attempts | 429 from the rate limiter (stored in Postgres) | The message our screens show |
| Verified, but never registers, activates or starts a trial | A Better Auth user with no `userWasRegistered`, or a registered user with no organisation | Licensing's own onboarding chapters (reminders, an abandoned trial), not sign-in |

These sit with the rest of the account lifecycle above (reset, change of email or password, a second factor) in PLAN
2b.2d.

**Social sign-in (Google, Apple): later** (Gary asked, 2026-10-09: will this flow still work?).
- **Yes.** Better Auth stays the only issuer of the tokens our API accepts. Google or Apple are ways to sign in to
  Better Auth (`signIn.social`), and `sub` stays Better Auth's user id. So the JWKS check, the `session:` rule, the
  lookup and `/my-account` don't change.
- **A first social sign-in creates the account,** with the email already verified by the provider: there's no "check
  your email" step.
- **To decide when it's built:**
  - **account linking:** the same email through a password and through Google is one person; Better Auth links for
    trusted providers;
  - **Apple:** its private relay email, and the name sent only the first time;
  - **deployment:** an app registration per provider, with redirect URLs on the install's domain. On-premises
    customers need their own, and the client ids and secrets become per-deployment settings;
  - **mobile:** native Google and Apple sign-in hands Better Auth the provider's id token.
- **What would break it:** our API accepting Google's or Apple's tokens directly (several issuers). The design never
  does that.

**Decision:** open. Settled in PLAN 2b.2d, after ADR-055 is built and proven in licensing.

**Consequences, once decided:**
- **Each choice becomes a setting:** in `auth/src/config.ts` where it differs by deployment, otherwise in
  `auth/src/auth.ts`.
- **Each person-facing flow becomes a modelled screen,** for example:
  - "forgot password";
  - "change email";
  - "set up two-factor".
- **What a flow changes in our model** (for example, an email change) is modelled like `userSignedUp`, as Auth's
  event.

### ADR-057: A screen another system serves is marked external; the sign-in screens come with the kit

**Status:** **Accepted, 2026-10-09 (Gary: "scaffold it").**
**Date:** 2026-10-09
**Revises:** ADR-052 point 5, ADR-054 point 4, ADR-055 point 8 (Sign Up was to be planned with a ui job).
**Builds on:** ADR-039, ADR-044, ADR-052, ADR-053 (the other ways another system meets our model).

**Context:**
- **Planning licensing's "sign up" showed a gap.** Its Sign Up card has no contract: emcli's mockup check said "the
  mockup has nothing to bind to", because the screen sends no command of ours. The person acts on Auth directly from
  the browser, and the password must never pass through our API (ADR-037).
- **Gary asked whether a command to another system belongs behind a processor,** as event modelling usually has
  it. It does when *our system* tells another system to act. The ways another system meets our model, and where the
  kit covers each:

  | Interaction | Shape in the model | Kit | Example |
  |---|---|---|---|
  | We tell another system to act | to-do list → **processor** → the other system's API → our event recording the outcome | `build-automation`, provider skills, a Temporal activity | cancel the refused trial at Paddle; sync the owner's role to Auth |
  | We read another system | an **external read model** → processor (ADR-039, ADR-052) | the automation fetches it in an activity | Paddle Sync |
  | Another system tells us | an **external event**, by webhook or fetched (ADR-053) | the webhook inbox, a sync | `paddleNotificationReceived` |
  | A person uses another system's part of our page, then we record it | our screen → our command (`derived:`), the other system's widget in between (ADR-044) | `build-screen` + the provider skill | Paddle's checkout → `reportCheckoutCompleted` |
  | **A person acts on another system directly, with no command of ours** | **that system's screen → its event** | **this ADR** | **Sign Up → `userSignedUp`** |

- **A processor doesn't fit the last case:** our command plus a processor calling Better Auth's server API would send
  the password through our API, and it would rebuild what Better Auth's client already does.

**Decision:**
1. **A screen card can be marked `--external <System>`: that system serves it.**
   - **emcli:**
     - the export carries `externalSystem` on the screen;
     - an external screen makes **no ui job** (a slice holding only external things exports Done);
     - its mockup is **checked only as a document:** no contract, no "nothing to bind to";
     - it gets no page route;
     - its card says "served by <System> (the kit provides its screens), not built by the loop".
   - **The board still draws it, in the lane of the person who uses it** (screens sit in actor lanes), so the flow
     reads end to end: Sign Up → `userSignedUp` (Auth's lane) → Signed In User → Get Started.
2. **The sign-in screens come with the kit.** The scaffold provides:
   - Sign In, Sign Up and "check your email" (`web/src/lib/sign-in.tsx`, at `/sign-in` and `/sign-up` with real
     sign-in on);
   - the header with who is signed in and Sign out (`Layout.tsx`).

   They follow Better Auth's docs, through `signInService`. `next` carries the page that asked for sign-in through
   Sign Up into the verification link's `callbackURL`, and it only ever names a path on this site.
3. **Their mockups come from emcli's starters,** with the same headings, labels, buttons and links the scaffold
   renders (Gary: realistic sign-in mockups):
   - `element mockup <card> --starter sign-up | sign-in | check-email`;
   - `snippet add account-header --starter account-header`, which `--draft` imports at the top of a page.
4. **Extra things to ask at sign-up** (an organisation's name) belong on our own screen after it (Get Started), with
   our command.
5. **"External" here means "not this project's loop's to build".** The kit builds these screens once, as tested
   scaffold code. If a project needs a different sign-in screen, that's a change to the kit's scaffold (or the
   project's copy of it), never a loop job.

**Alternatives considered:**
- **An external command in Auth's lane** (`signUp`, marked external; the loop builds only the screen). It's the
  textbook state-change shape, but each project's loop would rebuild the same security-sensitive code. Kept in
  reserve for a project-specific screen that acts on another system directly.
- **Our command plus a processor.** Rejected: the password would pass through our API, and it rebuilds Better Auth's
  client.

**Consequences:**
- **emcli** (`42bf5ff`):
  - `concernsOf` and `screenFingerprint` skip external screens, and `checkScreen` skips their contract;
  - the card wording;
  - `--starter` on `element mockup`, and the `account-header` snippet starter;
  - `--draft` imports the header;
  - the `event-model` skill: "A screen another system serves".
  - 431 tests.
- **Kit:** the scaffold's sign-in screens and header; `provider-better-auth` says they're the scaffold's;
  `build-screen` says an external screen is never yours; manual §22.
- **Licensing:**
  - the Sign Up card is marked `--external Auth`, with the starter's mockup and the `account-header` snippet;
  - journey case 1 signs up for real at `/sign-up`, through Mailpit.

### ADR-058: Secure by default, callers that aren't people, and roles

**Status:** Point 2 **Accepted, 2026-10-09 (Gary)**. Point 1, revised the same day (endpoints by declaration), is
Proposed until proven in licensing (2b.2f step 3). Point 3 is ADR-060 (Accepted).
**Date:** 2026-10-09
**Builds on:** ADR-037 (roles: licensing decides, Auth follows), ADR-055 part 2 (the `session:` rule).

**Context:**
- **ADR-055 part 2 secures every route that uses the signed-in person's values.** A route without them (most reads,
  every command that takes only ids) still answers anyone.
- **Gary asked whether "this is a secure route" can be a marking in the model.**

**Proposed:**
1. **Secure by default:**
   - every route requires sign-in;
   - the model marks the exceptions `--public`:
     - another system's webhooks (they carry their own signature);
     - health;
     - the API document;
     - genuinely public reads (a price list).

   It's deny by default, as OWASP recommends.
2. **Callers that aren't people need an identity before (1) can be switched on:**
   - ops reads (`/untranslated-notifications`, which support and the journey use);
   - scripts;
   - any automation that calls a route over HTTP.

   Options:
   - a platform-admin role (ADR-037: "the platform admin is auth only");
   - a service token per caller;
   - internal routes that the public proxy never exposes.
3. **Roles in the model:**
   - "only the owner may cancel" is a property of the command (emcli already has unused Auth Groups and Cedar role
     properties on elements);
   - the API checks the role from the token or the lookup;
   - the roles reach Auth through the role-sync slices.

   How an endpoint checks permission (roles, claims, or roles mapped to permissions) is ADR-060.

**Point 2 revised (Proposed, 2026-10-09):**
- **Gary: the platform admin is a person, not a way for automations to call in.** They sign in like anyone, and may
  do business operations and sign-ins for customers. So the platform admin answers "people who run the platform",
  and callers that aren't people need something else.
- **The platform admin, a person:**
  - signs in through Better Auth like anyone, with the strongest second factor (ADR-056);
  - holds platform permissions in the role map (ADR-060), for example `notification:list` and `organisation:support`;
  - belongs to no organisation and uses no seat (ADR-037 stands there). They act in a customer's organisation by
    naming it (ADR-060 (3)), and the check allows it because the role has the permission, not because they're a
    member;
  - acts as themselves, never by impersonating the customer. The events record it with the existing `actedAs`
    (`platformAdmin`) and `assignedBy` / `activatedBy` their own `userId`, so the record shows who really did it;
  - **revises ADR-037's "the platform admin is auth only":** the role is now ours, not only Auth's. Licensing's roles
    are per organisation, so the platform admin's grant belongs to `identity`. The first is created by a setup
    command (ADR-043), later ones by another platform admin.
- **Callers that aren't people: none needed now** (Gary, 2026-10-09: "do we actually have a requirement?"). Checked in
  licensing:
  - our automations call commands in-process, so they never meet the HTTP check. The permission check is at the
    API's edge, for people; an automation records `actedAs: system`;
  - Paddle's webhook is declared by its intake (point 1 revised) and carries its own signature;
  - our code calls Paddle, never our own API;
  - the only callers over HTTP that aren't people are the e2e scripts polling `/untranslated-notifications`. They're
    tests, so they sign in as a seeded test platform admin, as the journey already signs up for real.
- **Deferred, with its trigger:** the first caller that isn't a person and isn't a test.
  - For a customer's integration with our public API, Better Auth's API keys (permissions per key, named as in the
    role map, expiry, rate limits; a key may belong to an organisation).
  - For our own code needing elevated rights in AWS, IAM roles assumed through STS. That's AWS's permission model for
    AWS resources, not our app's, and on-premises has no STS, so it isn't a fit for our API.
- **Internal-only routes** (the third option) are dropped: they hide a route rather than check it, and on-premises
  has no public proxy to rely on.

**Point 1 revised (Proposed, 2026-10-09): endpoints by declaration.**
- **Found:** emcli's contract gives every command a `POST` route and every read model (unless external) a `GET`
  route, and `build-state-change` always writes `route.ts`. So commands only automations issue (`/start-trial`,
  `/assign-role`, `/refuse-trial`, …) are open routes taking `actedAs` from the body: anyone can start a trial or
  become owner. Sign-in alone wouldn't close it, since any signed-in customer could still call them.
- **Gary:** control the endpoint per element, for commands and read models alike; automations call commands
  in-process. "Anonymous" is the well-known term for a caller who isn't authenticated. Webhooks are endpoints too, so
  they're controlled the same way.
- **No element gets an endpoint unless the model declares one, and the declaration says who may call it.** One
  property per element:

  | Element | Property | Endpoint | Who may call |
  |---|---|---|---|
  | command, read model | none (the default) | none: automations call it in-process | — |
  | command, read model | `--api <resource:action>` | yes | a signed-in person whose role (or the platform admin) holds the permission in that organisation (ADR-060) |
  | command, read model | `--api self` | yes | any signed-in person, acting only on their own data through session values (ADR-055 part 2: `/my-account`, `/register-user`) |
  | command, read model | `--api anonymous` | yes | anyone, not signed in (no case yet) |
  | external event | `--intake webhook` (ADR-053) | `POST /webhooks/<system>` | the other system, proven by its signature |

  - A read model's `--api` covers its queries.
  - **A webhook's caller is authenticated, as a system, not a person.** The kit's `configureWebhookInbox` checks the
    raw body against the system's signature (`verify` from its provider skill: Paddle's is an HMAC of a timestamp and
    the body with the destination's secret). A bad signature gets 401 and nothing is recorded, and the
    notification's id makes a replay record nothing new.
  - **Kit routes** that don't come from the model (`/health/*`, `/openapi.json`) are listed as such.
  - `--public` (the first draft) is dropped: "public" reads as anonymous, and most declared endpoints aren't.
- **Completeness:**
  - errors when a screen triggers a command, or reads a read model, that has no `--api`;
  - errors on `--api self` for an endpoint whose body or path takes an organisation id (self acts on the caller's own
    data only);
  - once the role map exists (ADR-060), errors on a permission it lacks, and warns on one no endpoint uses.
- **The contract and the catalogue** (ADR-060 point 5):
  - `api/openapi.json` holds only declared endpoints, with their `security` (bearer, or none for anonymous) and
    `x-permission`;
  - each webhook path has a signature security scheme (its header, e.g. `paddle-signature`) and `x-caller`.
- **A built slice gaining or losing an endpoint is a replacement before release** (`plan-change`, ADR-046).

**Decision:** points 2 and 3 settled (above, and ADR-060). Point 1 is decided when proven in licensing.

### ADR-059: A context's events are its own; other contexts read its published read models or its published events

**Status:** **Accepted, 2026-10-09 (Gary).** Proposed the same day (Gary: "I don't think we should be copying
events"), then amended (Gary: a read model may be copied across, marked external, as a placeholder for another
context's published API). Proven in licensing (2b.2e): journeys 8/8 on mock and sandbox.
**Date:** 2026-10-09
**Builds on:** ADR-038 (point 5: events are scoped by context), ADR-040 (translations), ADR-053 (an external event
says how it reaches us), ADR-055 part 2 (the session lookup).

**Context:**
- **2b.2a put `userWasRegistered` in `identity`,** then copied it into chapter 1 (context `licensing`). emcli was
  changed to allow cross-context copies, and the export's `originContext` tells the builder to import the event from
  identity's `Events.ts`.
- **Gary objected:**
  - events are a context's system of record (domain events);
  - to share, a context should publish integration events that others subscribe to, or expose read models that
    others observe through an API;
  - copying raw domain events is not best practice.
- **Research (2026-10-09):**
  - **Oskar Dudycz** (Emmett's author, [Internal and external events](https://event-driven.io/en/internal_external_events/)):
    - splits events into internal (private to a module) and external (public);
    - exposing internal events leaks the abstraction, couples teams, and is "the first step to the distributed
      monolith";
    - external events are designed on purpose: enriched so readers don't rebuild state, versioned, and published
      (with an outbox);
    - he prefers "internal and external" to "domain and integration", since both are business facts.
  - **Event Modeling** (Dymitruk; Dilger, *Understanding Eventsourcing*): another system's events reach us through
    the translation pattern (their event, a view or to-do list, an automation, our command, our event).
  - **DCB** (Axoniq, dcb.events): a consistency boundary is confined within a single context. DCB widens consistency
    across entities inside one context, never across contexts.
- **What licensing actually used (checked 2026-10-09):**
  - none of licensing's decisions read `userWasRegistered`;
  - "is this person registered?" is answered by identity's My Account through the session lookup (403 "Register
    first");
  - the copy survived only as a spec's `given`, a re-export in licensing's `Events.ts` for test seeding, and two
    draft slices (chapters 1b and 2) that define their own `userWasRegistered`.

**Decision:**
1. **A context's events are private to it.** No slice of another context:
   - decides on them;
   - projects them;
   - seeds its tests with them;
   - imports its `Events.ts`.
2. **Within a context, nothing changes (ADR-038).** An event shown again in a later chapter of the same context is
   the same system of record, so the copy is fine.
3. **Across contexts, one of two ways.**
   - **(a) The owner's published read model (the default).** The owner exports a query, in-process (as
     `readModelLookup` does for the session lookup), or over HTTP when it's a separate service. The reader observes
     the effects of the events, never the events themselves.
     - **On the board, the reader's chapter may show it as a copy of the owner's read model, marked
       `--external <owner context>`** (ADR-052's marking: nothing of ours builds it, and it makes no job). It's a
       placeholder for the owner's published API.
       - emcli marks it when the copy is made.
       - It shows only what the owner publishes: no field or event the origin lacks. To get more, the owner publishes
         more.
       - It never becomes an extension slice of the owner's projection.

       Completeness errors on either break.
     - **How the reader reads it** is settled at its first build:
       - a screen calls the owner's endpoint;
       - a decision or an automation calls a query the owner exports (as the session lookup does).
   - **(b) The owner's published external event, consumed by a translation**, when the other context must react to
     the fact or keep its own copy. The owner publishes an external event, designed and versioned as an API
     (ADR-017/018). The consumer translates it: a to-do list, an automation, its own command, its own event.
4. **How (b) is published is decided at its first real use:**
   - a public events module per context;
   - an outbox, even inside one event store;
   - versioning;
   - how the board draws the published event.

   Compare Emmett, Axon 5 and Marten first. The likely first use is the role sync: licensing's role assignments
   reaching identity's automations that tell Auth (ADR-037, ADR-058).
5. **Enforced:**
   - **emcli** refuses `element copy` of an event or a command across contexts, and marks a read model copied across
     as external to its owner. Completeness gives an error at hand-off for an existing cross-context event copy, for
     an event of the same name defined in two contexts, and for a read model copy that isn't external to its owner or
     adds to it.
   - **The commit-scope guard** rejects a file under `src/contexts/<a>/` importing `src/contexts/<b>/Events`.
   - **The build skills** never import another context's events.

**Alternatives considered:**
- **Cross-context copies with `originContext`** (2b.2a). Rejected: it's the shared-internal-event coupling the
  research warns against, and DCB's boundary would quietly span two contexts.
- **One context for everything to do with people and organisations.** Rejected: ADR-055 part 2 separated identity
  for good reasons (Auth's boundary, the account lifecycle).

**Consequences:**
- **Licensing:**
  - chapter 1 loses its "registered" slice and "Identity Events" lane;
  - Activate Organisation's spec loses its `given` (through `plan-change`, since the slice is built);
  - the re-export goes, and the tests seed the person through `testSignIn(lookup)`;
  - the drafts "owner was registered" and "invitee was registered" go.
- **PLAN:** the follow-up "chapters 1b and 2 copy identity's event" is superseded.
- **ADR-055 part 2:** "Chapter 1 opens with copies of its events" is superseded by this ADR.

### ADR-060: How an endpoint checks permission: roles, claims, or roles mapped to permissions (open)

**Status:** **Accepted, 2026-10-09 (Gary)**, to be proven in licensing (2b.2f). It settles ADR-058 point 3.
**Date:** 2026-10-09
**Builds on:**
- ADR-037: licensing decides roles (owner, admin, engineer) and Auth follows; access = a role, a seat and a
  subscription in good standing.
- ADR-055 part 2: who is calling comes from the token or the session lookup, never the request.
- ADR-058: secure by default.
- ADR-059 (a): another context's published read model.

**Context:**
- **ADR-058 makes every route require sign-in, but not what else a route requires.**
- **Gary's thoughts (2026-10-09, not yet refined):**
  - simple role-based checks;
  - a finer claims-based model;
  - or a hybrid: the endpoint names the claim it needs, and the check asks whether the caller's group has it. Tests
    then only need to check whether a group has a claim.
  - There's a sweet spot between putting only the group in the token and listing every claim (one per endpoint).
  - If the token carries only the group, the API needs a lookup from group to claim.
- **The question is really three questions:**
  1. What does an endpoint declare: roles, or a permission?
  2. What does the token carry: nothing beyond `sub`, roles, or permissions?
  3. In which organisation? A person is an admin of an organisation, not an admin everywhere.

**What others do (2026-10-09):**
- **Better Auth's access control** (organization plugin): `createAccessControl` takes statements, each a resource
  and its actions (`project: ["create", "update"]`). `newRole` gives a role its permissions, and
  `hasPermission` checks on the server against the member's role. A member can hold several roles, and roles are
  per organisation. The token holds the role, not the permissions. "Dynamic access control" stores roles per
  organisation in the database, so customers can define their own.
- **ASP.NET Core's policy-based authorization** and **Spring's authorities:** the endpoint names a policy or an
  authority, and code maps roles or claims to it. Endpoints never list roles.
- **Auth0 RBAC:** roles hold permissions, and it can put the permissions in the access token. It warns that tokens
  grow with them.
- **Entra ID:** it caps the groups in a token (200 in a JWT) and sends an "overage" claim instead, so the API must
  look the groups up. This is the size problem of listing everything in the token.
- **OWASP:** deny by default, check on the server on every request, and check the object (the organisation) as
  well as the function. Broken object-level authorization is OWASP API Security's top risk.
- **emcli already has the hybrid's shape**, unused here: `cedarAction` (`order:create`) and `cedarRoles` (each role
  and its scope, `Full access` or `Customer-scoped`), from another model.

**Options for (1), what an endpoint declares:**
- **A. Roles on the endpoint** ("owner, admin").
  - For: simplest; it reads well on the board.
  - Against:
    - who may do what is spread over every endpoint;
    - a new role means editing many endpoints;
    - tests grow as endpoints times roles.
- **B. A permission on the endpoint, and a role-to-permission map in one place (Gary's hybrid).**
  - The permission is `resource:action`, for example `subscription:cancel` or `seat:assign`. Several endpoints may
    share one, so the map stays short.
  - For:
    - the map is the single answer to "what may an admin do", and the place a new role is added;
    - testing splits in two. Each endpoint refuses a caller without its permission (generated from the model), and
      the map is checked as a table (role, permission, yes or no).
  - It's what Better Auth, ASP.NET, Spring and Auth0 do.
- **C. A policy language** (Cedar, attribute-based). For when rules depend on data ("only the engineer assigned to
  this job"). More than we need now, but B's permission names map straight onto Cedar actions if it's ever needed.

**Options for (2), what the token carries:**
- **i. Permissions.**
  - Against:
    - the token grows with the API;
    - it's stale until refreshed;
    - it shows the API's shape to every client.
- **ii. Roles per organisation** (Better Auth's `definePayload`), with the map in the API.
  - For: a small token, and a change to the map applies at once.
  - Against: a role removed stays in the token until it expires.
- **iii. Nothing beyond `sub`.** The API reads the caller's roles from licensing's published read model through the
  session lookup (ADR-059 (a)), already done on every signed-in request.
  - For:
    - always current: a removed admin is refused at once;
    - no role reaches the token, so the API doesn't depend on the role sync.
  - Against: a separate service that can't reach the lookup needs (ii).

**(3), the organisation:**
- **The check is "has permission P in organisation O".**
  - O comes from the caller's membership (the lookup), never from the request, as ADR-055 part 2 requires.
  - A request naming another organisation is refused: 404, so it doesn't reveal that the organisation exists.
- **Agreed (Gary, 2026-10-09): the token carries no organisation.** It says who the caller is (`sub`). Membership and
  roles come from the lookup, so:
  - a removed member is refused at once, with no stale token;
  - licensing stays the one source (ADR-037), and the API doesn't wait on the role sync;
  - on-premises serves one customer, so its organisation is implicit.
- **Several organisations per person, when it comes** (a contractor engineer working for two customers): the client
  names the organisation it acts in, in the path or a header, and the API checks membership and permission there
  through the lookup (404 if not a member). There's no active organisation in the token (Better Auth's
  `activeOrganizationId`), because switching would need a new token and the value goes stale.
  - This doesn't break ADR-055 part 2. That rule stops a request from saying *who* the caller is. Naming *which*
    organisation, checked on the server, is the object check.
- **The exception:** a service that can't reach the lookup would need a short-lived token with the organisation and
  its roles. It's a deployment choice for later.

**What permission doesn't cover:** a seat and a subscription in good standing (ADR-037) are business rules. They're
checked by the decider or a read model, and the person is told why. A missing permission is a plain 403.

**Recommended:**
1. **B with iii.**
   - Each endpoint names a `resource:action` permission (or is `--public`, or needs only sign-in, as `/my-account`
     does). Completeness errors on a planned endpoint with none of the three (ADR-058, secure by default).
   - One role-to-permission map.
   - The API reads the caller's roles through the session lookup.
   - The token carries roles (ii) only when a service that can't reach the lookup appears.
2. **The role sync still matters, but not for the API.** It carries roles to Better Auth for its own needs: the
   per-role second factor (ADR-056), its admin plugin, and SSO group mapping (2b.2b).
3. **Open for Gary:**
   - ✅ **The map lives in the model** (Gary, 2026-10-09): emcli holds the roles and their permissions, the export
     writes them, and the board shows them.
   - ✅ **Permission naming: `resource:action`** (Gary, 2026-10-09). Several endpoints may share one.
   - ✅ **Customer-defined roles: later** (Gary, 2026-10-09; Better Auth's dynamic access control is the likely
     route).
4. **emcli's legacy authorization fields go** (proposed 2026-10-09). They came from the earlier Supply Hub model
   (on Cognito and Cedar), and their 25 chapters are the only place they're set (412 values):
   - `cognitoGroups` lists roles on the endpoint (option A);
   - `cedarRoles` lists each role and its scope on the endpoint (option A, plus the organisation check that (3) now
     makes for every endpoint);
   - `cedarAction` is a permission in all but name.

   They become one neutral property, `permission` (`resource:action`), and the roles' permissions are held in one
   place (the map). Nothing names a vendor. The legacy values aren't lost: a one-off migration turns `cedarAction`
   into `permission`, and gathers `cedarRoles` and `cognitoGroups` into a draft map for review. The fields are
   removed only after it.

5. **A catalogue of every API capability and its permission** (Gary, 2026-10-09). It's generated from the model at
   every export, never written by hand:
   - `api/openapi.json` (ADR-029) gives each operation its `security` (sign-in, or none when `--public`) and an
     `x-permission` (`resource:action`);
   - `api/permissions.md` lists every endpoint (method, path, the slice and context), its permission, and the roles
     that hold it, then each role with its permissions. Endpoints that only need sign-in, and public ones, are
     listed too, so nothing is left out.

   Checks keep it true:
   - completeness errors on a planned endpoint with no permission, sign-in-only or `--public` marking, and on a role
     granted a permission no endpoint uses (a warning) or that doesn't exist (an error);
   - a test in the project compares the running API's routes with `api/openapi.json`, so a route the model doesn't
     know about fails.

**Decision:** Accepted as recommended, with the points marked ✅ and 5:
- each endpoint names a `resource:action` permission, is sign-in only, or is `--public`;
- one role-to-permission map, in the model;
- the API reads the caller's membership and roles through the session lookup, and the token carries only `sub`;
- emcli's `cognitoGroups`, `cedarAction` and `cedarRoles` are migrated, then removed;
- the catalogue is generated and checked.

