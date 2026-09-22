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
