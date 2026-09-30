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



### ADR-037: The licensing model: seats bought by an organisation, assigned by its admins

**Status:** Proposed, 2026-09-30 (PLAN 16.2). Each decision below is a recommendation for Gary. Decisions 6 and 7
wait on Paddle's lifecycle in the sandbox (16.2b). Accepted decisions feed the model (16.3).
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

**Decision (proposed):**

1. **Family B: an organisation buys seats, and its admins assign them.**
   - The seat count is Paddle's subscription quantity. Assigning a seat is ours alone and never calls Paddle.
   - **The seat count we enforce is the one Paddle confirms** (`paddle.md` §8), so a failed charge never gives
     seats away.
2. **Roles: owner, admin and member all hold a seat,** because they use the app.
   - The buyer becomes the owner. There's always at least one owner, and the last owner can't leave without
     handing over.
   - Owners and admins invite people, assign and revoke seats, and change the seat count.
   - No billing-only role for now: it's a later addition if a customer asks.
3. **An invitation holds a seat while it's pending,** as with Polar and GitHub Team.
   - Accepting it gives access. Revoking it, or letting it expire, frees the seat.
   - It lasts **7 days** and can be sent again.
4. **At the limit, assigning a seat is blocked,** with an offer to add seats (owners and admins).
   - Adding seats is our screen: Paddle's preview first, then the update with `prorated_immediately`.
   - Figma-style requests and automatic purchase are left for later.
5. **Removing seats takes effect at once, with Paddle's prorated credit.**
   - It's Paddle's default. The sandbox showed the credit going on the customer's balance, not back to the card
     (`paddle.md` §11). There's nothing for us to schedule.
   - **The count can't go below the seats in use** (assigned or invited): people are revoked first.
   - Our screen says plainly that the credit goes toward the next renewal, because Paddle's portal calls it
     "Renewal".
6. **Trials** (to confirm in 16.2b): a **free trial with a card, 14 days**. A trial is treated as active, with a
   banner showing its end date. A cardless trial is the alternative, because Paddle cancels it by itself when no
   card arrives. Whether seats can change during a trial is for 16.2b to settle.
7. **A failed renewal** (to confirm in 16.2b):
   - **full access while `past_due`**, with a banner for owners and admins linking to Paddle's page to update the
     payment method, as Paddle recommends;
   - after Paddle's recovery window (30 days), **cancel** rather than pause, so that there's one way to end.
8. **After cancellation:**
   - access ends at the paid period's end (`scheduled_change.effective_at`);
   - the organisation and its data are kept, and owners can still sign in to subscribe again;
   - how long data is kept is Gary's decision (terms and privacy), not the model's.

**Alternatives considered:**
- **Family A, seats following membership:**
  - It's the smoothest sale: no limit, no admin step.
  - But every join and leave becomes a Paddle update, and an increase charges the card at once, so a declined card
    would block a person joining.
  - Laravel Spark does it on Paddle. It stays possible later as automatic purchase (decision 4).
- **Removing seats at renewal** (Notion, Figma):
  - It avoids small credits.
  - But Paddle's `scheduled_change` can't express it, so we'd have to remember the change and make it at renewal: a
    to-do list item with its own failure handling (ADR-031, ADR-032).
- **Locking at once on a failed payment** (GitHub): a card expiring would lock out a whole team, when Paddle
  recovers most failed renewals in the first days.

**Consequences:**
- **Our events** (16.3 names them):
  - the organisation is created, and its owner is set;
  - seats are bought, and the seat count changes (both confirmed by Paddle);
  - a member is invited, accepts, or the invitation is revoked or expires;
  - a seat is assigned or revoked;
  - a role changes;
  - the subscription runs into payment trouble, recovers, or ends.
- **The automations** call Paddle to change the seat count. **The translations** turn Paddle's webhooks into the
  confirmations (16.4).
- **Each rule becomes a spec in the model:**
  - assigning is blocked at the limit;
  - the count can't go below the seats in use;
  - the last owner can't leave;
  - access checks the subscription's state.
- **The invitation's expiry** is a time-based automation, the kit's first.
