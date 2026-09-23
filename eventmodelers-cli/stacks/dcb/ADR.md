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
- **Path parameters:** a parameter named in the endpoint's `{…}` is a path parameter, so it is required and
  matched by equality: `eq`, or `contains` when its field is an array (`/students/{studentId}/courses` matches
  `subscribedStudents.studentId`). Every other parameter is a query-string parameter.
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
  - emcli rejects a query endpoint that another read endpoint's pattern also matches. For example,
    `/courses/{courseId}` would swallow `/courses/available`, so pick `/available-courses` instead.
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
- Stored queries cost an indexed `find`. Heavily filtered fields may need tuning beyond the indexes the runtime
  creates.
- Out of scope: OR predicates, full-text search, aggregates (counts, sums) and cross-read-model joins.
