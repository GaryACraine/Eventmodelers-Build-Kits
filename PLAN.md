# DCB Event Store Stack — Project Plan

> Living document tracking the creation of a custom Eventmodelers Build Kit stack based on the DCB (Dynamic Consistency Boundary) event store library.

## Reference Implementations

| Role | Location |
|------|----------|
| **Build Kit (source patterns)** | `eventmodelers-cli/stacks/node/` — the Emmett-based Node.js stack this kit was ported from |
| **DCB Build Kit (this project)** | `eventmodelers-cli/stacks/dcb/` |
| **DCB Event Store library** | `/Users/garyalexandercraine/Projects/dcb-event-store/` |
| **DCB example app (ported)** | `dcb-event-store/examples/course-manager-web-api-sliced/` — vertical-slice architecture |

## Key Architectural Differences: Emmett vs DCB

| Concern | Emmett (node stack) | DCB Event Store |
|---------|---------------------|-----------------|
| Consistency boundary | Fixed aggregate stream | Runtime-scoped tags (Dynamic Consistency Boundary) |
| Command handling | `CommandHandler` + `evolve`/`decide` on a single stream | `decider<Cmd, State>({ handlers, decide })` composing multiple `EventHandlerWithState` decision models |
| Event types | `Event<'Name', Data, Meta>` from `@event-driven-io/emmett` | `TaggedEvent` with `Tags.fromObj(...)` from `@dcb-es/event-store` |
| Event store | `getPostgreSQLEventStore()` from `emmett-postgresql` | `new PostgresEventStore({ pool })` from `@dcb-es/event-store-postgres` |
| Projections | `postgreSQLRawSQLProjection` + Knex SQL builder | `pongoProjection` (Pongo JSONB) |
| HTTP layer | `WebApiSetup` from `emmett-expressjs` | `getApplication`, `on`, `Created`, `OK`, `withETag` from `@dcb-es/event-store-express` |
| Validation | Manual in route | Zod schemas + `validateBody()` middleware |
| Read-your-writes | Not built-in | `preferWait` + ETag polling |
| Consumer/processor | Emmett `reactor` processor | `createConsumer` + `projectionToProcessor` |
| Tests (write slices) | `DeciderSpecification` (in-memory) | `ApiSpecification` with `MemoryEventStore` (no Docker) |
| Tests (read slices) | `PostgreSQLProjectionSpec` | Integration tests with `getTestPgDatabasePool` (testcontainers) |
| OpenAPI | JSDoc `@openapi` blocks + swagger-jsdoc | `@asteasolutions/zod-to-openapi` + programmatic registry |

## Phases

### Phase 12: Query Read Models (the spec's *when* is the read operation) ✅

> Was the top priority (recorded 2026-09-23), superseding 9.7, 9.11b and the 10.8 ports. **Done 2026-09-23**, so
> those items are open again.

**Goal:** let a read model answer a **where predicate**, meaning it filters its documents on their fields, not
only fetches one by primary key. The read slice's GWT spec carries the query: *given* supplies the events, *when*
is the read operation (the query and its parameters) and *then* is the documents it returns. The client contract
from ADR-022 still holds: the same URL and body whichever read model type serves the query.

**Findings (preliminary investigation, 2026-09-23):**
1. **Every read model is a keyed GET.** The course-enrollment read models are all
   `readModelRoute(…, "/…/:key")`, i.e. one path parameter, `reader(id)` and pongo `findOne({ _id })` or
   `readLive(key)`:
   - CourseDetails: `/courses/:courseId`
   - CourseSeats: `/courses/:courseId/seats`
   - StudentSubscriptions: `/students/:studentId/subscriptions`

   The only non-keyed read in the kit is the scaffold's imperative `course-list`, which pages through a whole
   collection with no filter. The Node kit is the same (`findById`, or `findAll({})`). No kit has a where
   predicate.
2. **Read specs are given events, an empty *when*, then the read model.** All 12 read specs in course-enrollment
   have `when: []`. `build-state-view` never reads *when* for read slices.
3. **The model can already hold a *when* step.**
   - emcli's `spec step add` accepts any step type in any phase, and `workspace export` passes *when* through.
   - Specs are local to emcli and render to markdown on `sync push`, so **prooph board needs no change**.
   - Missing: a step type that means "query", and a way to state an operator other than equality.
4. **Stored types can filter with the existing library.**
   - Fold-form stored read models are one pongo document per key.
   - Pongo's `collection.find(filter, { limit, skip, sort })` supports `$eq $ne $gt $gte $lt $lte $in $nin
     $elemMatch $all $size` over JSONB.
   - The collections have only the `_id` primary key index, so filtered fields need expression or GIN indexes.
5. **Live read models can serve some predicates, not all.**
   - A predicate on a **tag** (e.g. `courseId = c1`) is reachable through the DCB tag index, with the same
     union-read machinery as lookups.
   - A predicate on **folded state** (`freeSeats > 0`) means folding every entity per request, like a live list.
     So those queries are stored-only.
   - A query's supported types can therefore be narrower than its read model's.

**Design (ADR-023, settled 2026-09-23):**
- **The keyed GET is unchanged.** A read model can also declare named **queries**.
- **Model:**
  - A query lives on the read model element: `queries: [{ name, apiEndpoint, parameters }]`, on the origin, and
    copies inherit it.
  - Each parameter is a `Field` plus an `operator` (`eq` is the default, plus `ne gt gte lt lte in contains`) and
    a `mapping`, which is the document field as a dot path.
  - A parameter named in the endpoint's `{…}` is a path parameter.
  - A spec's *when* is one `SPEC_QUERY` step: the query's name, with example values.
  - *then* is the expected rows in order. An empty *then* means no matches.
- **Contract:**
  - `GET {apiEndpoint}?{named params}`, never a raw filter language. `limit` and `cursor` are reserved.
  - The body is always `{ data, cursor? }`, where each item has the keyed GET's document shape.
  - The status is 200, including an empty page, or 400 for a bad parameter. Never 404.
  - emcli rejects endpoints that another read endpoint's pattern would match.
- **Runtime:**
  - `queries: { name: { params, sort? } }`, declarative, with no predicate function.
  - Stored types use pongo `find`, with indexes created at startup. Adding a query doesn't trigger a rebuild.
  - **Live serves a query only if the query has a required `eq`/`in`/`contains` parameter with a `tag`.** That tag finds the
    candidate keys, each candidate is folded, and then every predicate, state ones included, is applied in
    memory.
  - Queries without a tag parameter (including a parameterless list) are stored-only.
- **Loop:** a query added to a Done read model re-queues it like a retype. It is additive, with `evolve`
  untouched.

**Tasks:**
- [x] **12.1 ADR-023, the read-model query contract.** Your three recommendations were accepted: a `SPEC_QUERY`
  step type, named parameters with an operator on each, and a paged body.
  - Refinements made while writing the ADR:
    - Queries are declared on the read model element, and specs reference them. That gives the endpoint a home,
      and two specs can't disagree about a query.
    - "State predicates are stored-only" became "live needs a tag parameter; any other predicate rides along".
- [x] **12.2 emcli** (emcli `c7694ec`, 156 tests, including 27 new ones):
  - `queries` on read model elements, declared on the origin and inherited by copies. Each parameter has an
    `operator`, a `mapping` and an optional `tag`, plus an optional `sort`.
  - New commands: `element query add|update|remove|list` and `element query param add|remove`. A rename carries
    through to the spec steps that run the query.
  - Endpoint collisions are rejected: `/courses/available` against `/courses/{courseId}`.
  - The `SPEC_QUERY` step (alias `query`) must stand alone in *when* and name a query of the linked read model.
    `--seed` copies the query's parameters.
  - Export writes resolved `readmodels[].queries` (explicit `operator` and `mapping`, `pathParameter: true`) and
    the `SPEC_QUERY` step. `eventmodeling.schema.json` is extended.
  - The build-kit bridge records each read slice's `queries` in `index.json`, and re-queues a Done slice with
    `addQueries` when its specs run a new query. Additions follow the specs while pending, and combine with a
    retype.
  - Export warns about an undefined path parameter, a query no spec uses, a spec naming an unknown query, and a
    live read model with an untagged query. `--read-model-type live-report` warns about the last one too.
  - Push renders queries in the element details, and pull preserves them.
  - Docs: USAGE.md ("Querying a read model") and CLAUDE.md.
  - **Finding:** the ADR's own example, `/students/{studentId}/courses` matched against
    `subscribedStudents.studentId`, needs `contains`. So path parameters and tag parameters accept `contains` as
    well as `eq`/`in`. It is still an equality match, and every matching document still has a tagged event.
    ADR-023 is updated.
  - Smoke-tested on a copy of the course-enrollment workspace. Adding a spec that runs `availableCourses` to the
    Done "course seats capacity" slice re-queued it with `addQueries: ["availableCourses"]`.
- [x] **12.3 Kit runtime.** A new `src/shared/readModelQueries.ts`, plus changes in `readModels.ts`:
  - `queries` in `defineReadModel`, validated when the read model is defined: reserved names, dot paths,
    operators, types, and a tag only on a required equality parameter.
  - The stored runner is one parameterised JSONB SELECT with keyset paging. The live runner collects candidates
    through the tag, folds each with `readLive`, then applies the predicates in memory.
  - `runtime.querier(readModel, name)` and `readQueryRoute(readModel, runtime, name, path)`. The route answers
    `{ data, cursor? }`, 400s bad input and is never 404.
  - `startReadModels` refuses to start a live read model with an untagged query, and creates the query indexes
    for the stored types.
  - Tests: 12 on real Postgres in `readModelQueries.tests.ts`, all passing. The full template suite passes
    (60 tests).
    - Every type returns the same pages for 13 cases, and cursor paging over HTTP gives the same order in all three
      types.
    - A **mirror test** runs every query over a grid of 40 parameter sets through both the SQL and the in-memory
      matcher, and gets identical results.
    - Also covered: the 400s, the empty 200, the live-start refusal, rejected definitions, and the indexes being
      created and used (checked with `EXPLAIN`).
  - **Finding:** pongo's `find` can't be the stored runner. In pongo 0.17 it compares ranges as text
    (`'10' < '9'`), doesn't reach into arrays along a dot path, and sorts by the database collation. The runtime
    writes its own SQL instead: typed comparisons, `COLLATE "C"`, and jsonpath lax mode for `contains`.
    - The in-memory matcher mirrors that SQL, and the mirror test enforces it.
    - The cases include 10 against 9, `"Banana"` sorting before `"apple"` (byte order), the string `"2"` never
      equalling the number `2`, and a missing field matching only `ne`.
    - ADR-023's semantics section is rewritten to match.
- [x] **12.4 The `build-state-view` skill.** Query sections added to the skill, with a small runtime change
  alongside:
  - **Step 0:** `addQueries` routes the slice to a new "Adding queries" section (A1–A6), which runs after a retype
    when both are present. In every case, the queries to build are the ones this slice's specs run that the
    definition doesn't declare yet. A declared query that no spec runs isn't built.
  - **Step 2:** new requirement 4 for live queries: a required tagged `eq`/`in`/`contains` parameter, and an
    event in `events[]` that carries both that tag and the key tag. Imperative projections can't serve queries.
  - **Step 3b:** a transcription table from `readmodels[0].queries` to `queries: { name: { path, params, sort } }`,
    with the emcli-to-kit type mapping. `queries` sits before `evolve`, so a later addition is a pure insertion.
  - **Step 6b:** one `describe.each(queryTypes(rm, "q"))("{slice title}: q (%s)")` block per query. *when*'s
    examples become the path and query string, and *then*'s rows are checked in order with `toMatchObject` on
    `res.body.data`.
  - The extension, retype (R2 checks live queries), files and checklist sections are updated.
  - **Runtime change (found while writing the skill):**
    - Keyed contract tests run every type, and `startReadModels` refused `withType(rm, "live-report")` once `rm`
      had an untagged query. So adding a stored-only query would have broken the existing tests, which are the
      proof that the change is additive. Now `withType` to live drops stored-only queries, and `queryTypes()`
      gives each query's types.
    - Queries now declare their own `path`, and `readModelRoute` mounts them all. Adding a query touches neither
      `route.ts` nor `index.ts`.
    - `SliceDependencies.readModels` includes `querier`. Template suite: 62 tests pass.
  - **Dry run:** on a copy of course-enrollment with the new runtime, following only the skill's A-steps:
    - `availableCourses` on CourseSeats (stored-only; its tests ran on database-projected and inline-projected);
    - `coursesForStudent` on CourseDetails (live, `contains` plus tag `studentId`, sorted by title; its tests ran
      on all three types).
    - All 99 tests pass. The `readModel.ts` diffs are pure insertions, and the only changed lines are the
      `route.tests.ts` imports gaining `queryTypes`.
- [x] **12.5 Commit checks.** *(Done 2026-09-23.)*
  - **`util/describe-blocks.cjs`** (DCB kit, merged next to the shared `find-slice.cjs` on install) lists the
    top-level describe blocks, with `.each(…)` arguments nesting one level of calls, so
    `describe.each(queryTypes(rm, "q"))(…)` is recognised both as a block start and as the end of the previous
    block.
  - **`extension-additive`** counts the extension's keyed block and its `"{title}: {query} (%s)"` blocks together.
  - **New `16-query-additive`**, for an InProgress `addQueries` slice that isn't an extension:
    - only its own `readModel.ts` and `*.tests.ts` change;
    - `readModel.ts` gains lines only inside the `queries: { … }` block (found by brace matching, and checked by
      new-file line number from the `-U0` hunks). The only removal allowed is a line re-added with `,`, and
      every `addQueries` name must be declared;
    - `route.tests.ts` must change, with a query block per added name holding ≥ one test per spec whose *when*
      runs it. Existing lines stay, except an import re-added with more names from the same module;
    - a `type:` line change without a `retype` block is rejected.
  - **`retype-scope`:** with `addQueries`, a commit that leaves the `type:` line alone is the queries commit,
    and query-additive governs it. A commit that touches the type line is still held to that one line, so a
    combined retype-plus-queries commit is rejected, matching the skill's "retype first, as its own commit".
  - **`spec-coverage` needed no change,** contrary to the 12.4 finding: it counts every `test(` in the file,
    whatever block it's in.
  - **Tests:** 18 new `node:test` cases in `stacks/dcb/tests/checks/query-checks.test.cjs`, plus the 5 existing
    retype-scope cases; all 23 pass. On the 12.4 dry-run diffs (CourseSeats `availableCourses`, CourseDetails
    `coursesForStudent`), checks 15, 16, 17 and 50 all pass, including CourseDetails with a `retype` block. The
    old retype-scope rejected that same diff.
  - Docs: ADR-023 "Tests and the loop", the build kit's CLAUDE.md check list, skill A4, and the manual's check
    table (which gains the missing retype-scope row too).
- [x] **12.6 Experiment on course-enrollment (Gary ran the loop).** *(Done 2026-09-23, branch
  `increment/t11-queries`.)*
  - **Kit update** (`69e295b`): the post-12.3 shared runtime, the new checks and util, the skill and the build
    kit's CLAUDE.md, copied over the project. `index.ts` needed no change. All 108 existing tests pass.
  - **Model** (`49bab61`, emcli):
    - `availableCourses` on CourseSeats (`/available-courses`, `minRemainingSeats` Int `gte remainingSeats`,
      stored-only). Two specs in the `course seats` slice: ≥1 returns c1 and c3 and skips the full c2; ≥3 returns
      no rows.
    - `coursesForStudent` on CourseDetails (`/students/{studentId}/courses`, `contains
      subscribedStudents.studentId`, tag `studentId`, sort `title`). Its two specs are in the **extension** `course
      details subscriptions`, where `subscribedStudents` exists, so the loop took both the plain path
      (query-additive) and the extension path (extension-additive).
    - Export re-queued both built slices as Planned with `addQueries`.
  - **Loop:** both slices built first time, and every check passed on the first commit:
    - `coursesForStudent`: 80 s, $0.83;
    - `availableCourses`: 68 s, $0.78.
    - Each commit adds a `queries` entry before `evolve` in the (origin's) `readModel.ts` and widens the import
      with `queryTypes`. Each appends one query block with a test per spec: `coursesForStudent` over all three
      types, `availableCourses` over the two stored types.
    - 118 tests pass (108 + 10). The loop recorded both patterns in `.build-kit/AGENTS.md`.
  - **Over HTTP on the dev DB:**
    - `/available-courses?minRemainingSeats=1` returns six courses in key order;
    - `/students/s1/courses` is served live (CourseDetails is `live-report`) and sorted by title;
    - a non-numeric parameter gets a 400;
    - `limit=1` returns a cursor, and following it continues at the next key.
  - **Latency.** Seeded through the command routes, then `runtime.querier` timed in-process: 300 calls after
    20 warm-ups, median, page limit 50. Datasets: 2k courses / 2k students / 10k subscriptions (14k events), and
    20k / 20k / 100k (140k events).

    | query (stored, after VACUUM ANALYZE) | 2k with index | 2k without | 20k with index | 20k without |
    |---|---|---|---|---|
    | `coursesForStudent` (GIN `jsonb_path_ops`, 5 rows) | 0.36 ms | 1.23 ms | 0.40 ms | 8.84 ms |
    | `availableCourses ≥500` (btree, 20 / 200 matches) | 0.32 ms | 0.94 ms | 0.50 ms | 6.58 ms |
    | `availableCourses ≥1` (96 % match, first page) | 1.27 ms | 1.18 ms | 8.39 ms | 8.23 ms |

    - **Selective queries:** the indexes keep them flat as the table grows (22× and 13× at 20k).
    - **Unselective queries:** an unsorted query orders by `(_id COLLATE "C")`, and no index has that order
      (the primary key uses the default collation). So Postgres filters and sorts every match to return 50.
      With an index on `(_id COLLATE "C")`, the first page drops from 8.2 ms to 0.41 ms, because Postgres walks
      key order and stops at 51 rows. Deep pages stay O(offset) (2.3 ms after c5000): the cursor predicate is
      the 4-tuple row comparison, and its constant columns can't be an index condition. → 12.6b.
    - **Right after a bulk load (2k):** the GIN index had 10,648 tuples in its fastupdate pending list, and each
      table had 10,000 dead tuples. The planner seq-scanned `coursesForStudent` (1.26 ms) until VACUUM (0.36 ms).
      At 20k, autovacuum kept up (1,147 pending) and the index was used. This matters after a rebuild
      (truncate + replay) → 12.7 docs.
  - **Live against stored** (CourseDetails, `coursesForStudent`, 5 rows):
    - 0.39 ms stored against 14.1 ms live at 20k. At 2k, live was 27 ms.
    - Keyed GET: 0.21 ms stored against 2.6 ms live.
    - All 50 compared pages are identical live and stored (deep equality; only JSONB key order differs).
    - The live query doesn't grow with the table, because the tag narrows the candidates. Its cost is round
      trips: 22 event reads, 79 statements (BEGIN / DECLARE / FETCH / ROLLBACK for each), and 1.4 ms of it is
      database time.
    - The 2k store is slower because the store reads through `DECLARE CURSOR`, which Postgres plans with
      `cursor_tuple_fraction = 0.1`. On a small events table that plan loses to the GIN tag index: 22 FETCHes
      took 10 ms against 0.4 ms at 20k. With `cursor_tuple_fraction = 1.0` on the session, 2k live drops to
      14.4 ms. This is a dcb-event-store finding (the read path's cursor planning), not a kit one.
- [x] **12.6b Key-order index for unsorted queries.** *(Done 2026-09-23.)*
  - **The problem:** a query without `sort` returns rows in key order. When most documents match (courses with ≥1
    free seat), Postgres had to find every match, sort them all by key, and discard all but 51. That's O(table)
    for every page (7.8 ms at 20k courses). No index had that order: the runtime orders keys by bytes
    (`COLLATE "C"`, to match the live runner and the cursors), and the primary key uses the default collation.
  - **`queryIndexStatements`** adds `(_id COLLATE "C")` for every unsorted query.
  - **`buildQuerySql`** sends an unsorted query's cursor as `(_id COLLATE "C") > $key`. An index on the 4-tuple
    with its constant columns was tried too. It served the first page, but not the cursor: Postgres folds the
    constants, so deep pages still read from the start (2.3 ms). A cursor that isn't unsorted-shaped (forged)
    keeps the full row comparison, so the SQL still matches the in-memory order exactly.
  - Sorted queries already seek, in both directions, through their tuple index (checked at 20k: 0.07 ms deep
    page), so they're unchanged.
  - **20k courses, `availableCourses`, before → after:**
    - ≥1 first page: 7.82 → 0.50 ms;
    - ≥1 page after c5050: 3.47 → 0.40 ms;
    - selective (≥500) and empty (≥995) results: unchanged (~0.4 ms, still on the field index).
  - **Tests:** a new mirror test compares SQL and in-memory pages after every cursor position, plus forged
    cursors, for every query. Another checks the key-order index exists and that a cursor page's plan has an
    `Index Cond` on it. The template suite passes: 64 tests (62 + 2). ADR-023 is updated.
- [x] **12.7 Docs.** *(Done 2026-09-23.)*
  - **New manual §12, "Increments t11 and t12: querying read models":**
    - 12.1: what a query is (the route, named parameters with operators, sort, `{ data, cursor? }`, 200/400) and
      which types serve it (stored: all; live: only with a tagged parameter);
    - 12.2: modeling the two t11 queries with emcli, where their scenarios go (the extension that brings the
      filtered field), and export's `addQueries` re-queue;
    - 12.3: the loop's additive commits and the query test blocks;
    - 12.4: the curl checks, paging and a 400;
    - 12.5: the indexes, the 20k measurements with and without them, live against stored, t12's key-order index,
      the `VACUUM ANALYZE`-after-a-rebuild note, and how to choose.
  - Sections 12–17 became 13–18, and every anchor and `§` reference was renumbered.
  - **Updated elsewhere in the manual:**
    - §1 now mentions queries;
    - §11.6's live limits allow tagged queries;
    - the troubleshooting row covers a live query without a tag;
    - the command reference gains `element query add` / `query param add` and the `when query` step;
    - the known limits correct "Done slices can't be re-queued" (retypes and added queries can be) and add the
      query scope limits.
  - ADR-023 already carried the design; 12.6b added its index notes.

---

### Phase 11: Read Model Types ✅

> Was the top priority, superseding 9.7, 9.11b and the 10.8 ports. **Done 2026-09-23**, so those items are open
> again.

**Goal:** let a read model choose how it is kept up to date, and build each type in the DCB kit. Some business
users need a read model that is consistent the moment a command returns; eventual consistency isn't acceptable
for them. dcb-event-store's **inline projections** solve this: they run inside the append transaction. They hold the
append's advisory locks while they run, so every append of their events gets slower. Use them sparingly.

The DCB kit (`stacks/dcb`) builds only async projections today. The Emmett kit (`stacks/node`) already builds
inline projections (`projections.inline([...])`), so this phase is about the DCB kit.

| Type (emcli `readModelType`) | DCB mechanism | Consistency | Write cost | Status |
|---|---|---|---|---|
| `database-projected` (the default when the field is absent) | `pongoProjection` run by a consumer, with a bookmark and `preferWait` | eventual | none | ✅ built today |
| `inline-projected` | the same `Projection`, passed to `new PostgresEventStore({ inlineProjections })` | immediate | lock hold on every append of its events | 11.1–11.6 |
| `live-report` | nothing stored: fold events per request, with one union read for lookups | immediate | two reads per query | 11.7 |

**Library behaviour (`event-store-postgres/src/eventStore/PostgresEventStore.ts`):**
- A throw in an inline projection rolls back the append, so a bug in the projection fails the command.
- `ensureInstalled()` registers inline projections as type `'i'` and runs their `init`. `pongoProjection.init`
  then re-registers them as `'a'`, which looks cosmetic.
- `rebuildProjection()` handles inline projections: it deactivates the projection, replays through a temporary
  consumer, then reactivates it.

**Rebuild hypothesis:**
- **Extensions:** expected to work unchanged. The fingerprint changes, and `ensureProjectionsCurrent` rebuilds
  the projection at startup, before any append.
- **Greenfield:** differs. A new inline projection has no consumer to read from the beginning, so on an app that
  already has history it would never see the earlier events. The first time `ensureProjectionsCurrent` sees an
  inline projection must trigger a replay.

#### Tasks

- [x] **11.1 (emcli)** Add `inline-projected` to `readModelType`: the schema, the domain type, export, and the
  `element update` validation and help. `--copy-of` inherits the origin's type, and a copy whose type differs from
  its origin's is rejected. `workspace export --build-kit` warns when one event type feeds three or more inline
  read models. Add tests, and update `USAGE.md` and `CLAUDE.md`.
- [x] **11.2 (kit)** `build-kit/CLAUDE.md` switchboard: both projected types go to `/build-state-view`.
  `live-report` → `request-feedback` (Blocked: not supported yet), instead of silently building an async
  projection.
- [x] **11.3 (kit)** `build-state-view` gets an inline variant, chosen in Step 0 from `readmodels[0].readModelType`:
  - `projection.ts` is unchanged, plus rules for inline code: keep it fast, make no external calls, and remember
    that a throw fails the command.
  - Wiring: the projection goes in `inlineProjections`. It gets no consumer and no `waitFn`.
  - The route has no `preferWait` or bookmark ETag.
  - Tests do a GET immediately after the POST, with no wait.
  - The extension steps (E1–E6) apply unchanged.
- [x] **11.4 (kit)** `ensureProjectionsCurrent` takes the inline projections and replays one the first time it
  sees it.
- [x] **11.5 (kit)** Add ADR-021 "Inline projections for immediate consistency": when to choose inline, the lock
  cost, sparing use, and the fact that failures surface as write failures.
  *(11.1 done in emcli `2674065`: `READ_MODEL_TYPES`, `effectiveReadModelType`, `findInlineFanOut`; 121 tests.
  11.2–11.5 done: the inline variant is I1–I4 in the skill.
  `src/shared/ensureProjectionsCurrent.tests.ts` (7 tests, real Postgres) confirms the rebuild hypothesis:
  - a new inline projection is backfilled;
  - reads are current straight after the append;
  - an extension rebuild projects earlier events of the new type;
  - a throw rolls back the append;
  - switching async → inline rebuilds.
  Two library findings:
  - `rebuildProjection()` needs a `_handler_bookmarks` row, so `ensureProjectionsCurrent` installs one for each
    inline projection.
  - An inline `pongoProjection` is registered as type `'a'`, which is cosmetic.)*
- [x] **11.6 (experiment)** On `~/Projects/course-enrollment`, build a **CourseSeats** read model (inline).
  - **t5:** the origin, handling `courseWasRegistered`, `studentWasSubscribed` and `studentWasUnsubscribed`.
    Check that it is backfilled from existing history, that a read immediately after a write shows the change,
    and what the registry records as its type.
  - **t6:** an extension adding `courseCapacityWasChanged`, with a capacity change made *before* the extension.
    Check that the rebuild picks it up.
  - Record whether the rebuild strategy and the copy/extension flow are the same as for async read models. Then
    update the manual (read model types in §1, a t5/t6 walkthrough, rebuild differences in §12, and a
    troubleshooting row).
  *(Done 2026-09-23 on `~/Projects/course-enrollment`, increments t5 and t6 (merged). The loop built both slices
  unattended from the updated skill:
  - `0d8275d` feat and `926c2af` wire, a one-line `inlineProjections` change.
  - `462c2c4`, the extension: additive, with no wiring change.
  - 53/53 tests pass.

  Measured on the live DB, which holds the t0–t4 history:
  - **Backfill:** on first start the log shows `Rebuilding CourseSeatsProjection: (new inline projection)`, and
    c1 = 30/1/29 and c2 = 20/1/19 are correct from history.
  - **Consistency:** 200 reads, each straight after a subscribe or unsubscribe, found 0 stale for CourseSeats,
    against 199 stale for the async CourseDetails read without `Prefer: wait`.
  - **Extension:** the restart logs `Rebuilding …` with the new fingerprint, and it picks up both earlier capacity
    changes: the historic c1 change to 45 and a c2 change to 25 made during t5.
  - **Registry:** `_projections` shows type `'a'` (the quirk). The inline projection's bookmark stays at the
    rebuild position, which is harmless.

  **Answers:**
  - The copy/extension flow is identical for inline and async read models.
  - The rebuild strategy is the same for changes, but differs on first start: inline needs a replay, which
    `ensureProjectionsCurrent` now does.

  Manual: §1 read model types, a new §10 walkthrough (old §10–15 are now §11–16), §13 inline rebuilds, and two
  troubleshooting rows. Not measured: the write-latency cost per inline projection. The library has a
  `contention` benchmark for that.)*
- [x] **11.7 Live read models, and switchable types** (design approved 2026-09-23; ADR-022).
  - **The contract is the data shape only:** the same URL, body and status for a read model whichever type serves
    it. Headers (`ETag`, `Prefer: wait`) are outside it.
  - **One definition per read model:** a keyed fold (`defineReadModel`: `key`, `canHandle`, pure `evolve`), with
    declared **lookups** for cross-entity data.
  - **Three runners over it:**
    - Stored (async or inline): a generic pongo projection with lookup collections.
    - Live, read 1: the primary events for the key; collect the related ids from their tags.
    - Live, read 2: **one union read**, `(primary types ∧ key tag) OR (lookup types ∧ tags && {related ids})`,
      folded in position order, and repeated until the related-id set is stable.
    Both fold the same functions over the same event sequence, so every type gives the same data.
  - Verified read-only on course-enrollment: the union read for CourseDetails c1 returns positions 1, 3, 5, 6, 7,
    8, 11, the exact sequence the stored projection processed.
  - **Requirements:** every primary event carries the key tag, and every related id is a tag on the primary events
    that reference it. Live serves keyed GETs only. A retype changes one `type:` line and is re-queued by emcli
    export.
  - Sub-tasks, one PR each:
    - [x] **11.7a** ADR-022 "Read model contract and switchable types", and these entries.
    - [x] **11.7b** Scaffold runtime `src/shared/readModels.ts` (`defineReadModel`, stored and live runners,
      `startReadModels`, `readModelRoute`, `supportedTypes`), `src/test/readModelHarness.ts`, and the `live:`
      fingerprint in `ensureProjectionsCurrent`. Real-Postgres tests: identical bodies across the three types for a
      model with a lookup, the fixpoint under a concurrent subscription, live → stored rebuild, and 404.
      *(Done: 12 tests in `src/shared/readModels.tests.ts`, all passing on real Postgres. The CourseDetails-like
      model with a student-name lookup gives identical documents and HTTP bodies as async, inline and live, and
      404 for an unknown key. The fixpoint test commits a new subscription after live read 1 and gets the new
      student's name, in 3 reads. A live → stored switch rebuilds, including events appended while live. The
      scaffold's `index.ts` files use `startReadModels`, and the bundled example's projections are registered as
      `imperative`. The full template suite passes: 48 tests.)*
    - [x] **11.7c** `build-state-view`: fold form by default (`readModel.ts`), imperative form only when §4 of the
      design excludes fold form. Live gets built, with a generic route and body-only contract tests across all
      supported types (`describe.each`). Extensions append `evolve` cases or lookups. R-steps for a retype. The
      switchboard builds `live-report`.
      *(Done, extending the existing skill as Gary confirmed; there is no separate live skill.
      - Step 2 chooses the form. Fold form is the default, and the imperative form (P0–P4) is kept for lists and
        payload-only lookups.
      - Steps 3–6 cover `readModel.ts`, the generic route, `readModels` wiring, and `describe.each(READ_MODEL_TYPES)`
        contract tests.
      - The extension steps (E1–E6) cover both forms. R1–R4 cover a retype.
      - `extension-additive` guards `readModel.ts` too and recognises `describe.each` blocks. `test-file-present`
        knows `readModel.ts`.
      - Dry run: a fold-form CourseSeats written exactly from the templates passes tsc and 6/6 contract tests
        (2 scenarios × 3 types) in a copy of course-enrollment.)*
    - [x] **11.7d** emcli: retype re-queue on export (`retype: { from, to }`, with the built type recorded in
      `index.json`), and a warning for a live list read model.
      *(Done in emcli `ef3b232`, 129 tests. The index entry records the `readModelType` the loop was asked to build.
      A Done origin whose type changed is re-queued with `retype`. A pending retype survives re-exports, follows
      further changes, and is cancelled by switching back. Extension slices are never retyped. Checked end to end
      on a copy of course-enrollment: CourseSeats inline → live re-queued, and switching back cancelled it.)*
    - [x] **11.7e** Commit check `retype-scope`: a retype commit may change only the `type:` line, with tests
      unchanged.
      *(Done: `checks/17-retype-scope.cjs`, with 5 `node:test` cases in `stacks/dcb/tests/checks/retype-scope.test.cjs`
      that run in a throwaway git repo.)*
    - [x] **11.7f** Experiment on course-enrollment:
      - migrate CourseSeats and CourseDetails to fold form (existing scenarios unchanged);
      - retype CourseDetails async → live, with the body identical before and after (the lookup union on the live
        DB);
      - retype CourseSeats inline → live → async;
      - measure live latency against stored;
      - model one new live read model.
      *(Done 2026-09-23, increments t7–t10 merged.
      - **t7:** CourseSeats and CourseDetails (with a `students` lookup) were converted to fold form in reviewed
        commits. With `version: 2` they rebuilt from history, and all 14 read-model URLs kept identical bodies and
        statuses (key order ignored). 10 scenarios → 30 contract tests.
      - **t8:** emcli re-queued both retypes. The loop made two one-line commits, which passed the (now active)
        hook, retype-scope included. Bodies stayed identical after the switch to live. Stale reads for
        CourseDetails fell from 199/200 (async) to 0.
      - **t9:** CourseSeats live → async. A subscription made while it was live was missing from the stale stored
        copy. The restart logged `Rebuilding …: live:v2 → v2`, and the body was then correct.
      - **t10:** a new live `StudentSubscriptions`. The loop derived the `courses` lookup (courseWasRegistered +
        courseTitleWasChanged, by `courseId` tag) from the skill alone. Its data was correct against the live
        history, including a read straight after a write.
      - **Latency** (medians, 300 GETs each). Stored read models answered in 2.0–2.5 ms. Live answered in 3.0 ms
        (5 events, no lookup), 4.2 ms (5 events + lookup), 7.1 ms (612 events) and 9.4 ms (813 events + lookup).
      - **Full suite:** 94 tests.
      - **Kit fixes found on the way:**
        - PR #22: `ReadModel[]` typing.
        - PR #23: the commit hook was silently off in projects scaffolded without `--hooks`, and the scaffold
          failed `tsc --noEmit` on `uuid` types.)*
    - [x] **11.7g** Manual: "Switching read model types" (the contract, lookups in live reads, when to choose live,
      a measured retype walkthrough), plus updates to §1, §13, troubleshooting and the known limits. PLAN
      results.
      *(Done. New §11, "Increments t7–t10: switching read model types", covers the contract, fold form and the
      union read, the conversion, retype to live and back, a new live read model, and a cost table. §1 table,
      §6.5, §10.3 note, §14 live fingerprints, three troubleshooting rows, the command reference and the known
      limits are updated. Sections from §12 on are renumbered.)*

---


### Phase 1: Stack Scaffolding & Init Command ✅

**Goal:** `eventmodelers init --stack dcb` creates a working baseline application.

#### What was built

- Registered `dcb` in `eventmodelers-cli/cli.js` STACKS object
- Created full `stacks/dcb/templates/root/` scaffold ported from `course-manager-web-api-sliced`:
  - `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `docker-compose.yml`, `.env.example`, `.gitignore`, `README.md`
  - `src/test/testPgDbPool.ts` + `vitest.globalSetup.ts` — inlined from monorepo (standalone testcontainers setup)
  - `src/shared/` — `dependencies.ts`, `Tags.ts`, `idempotency.ts`
  - `src/contexts/enrollment/Events.ts` — 6 tagged event factories
  - 5 write slices: `register-course`, `register-student`, `subscribe-student`, `unsubscribe-student`, `change-course-capacity`
  - 2 read slices: `course-details`, `student-details`
  - Infrastructure slices: `course-list`, `event-feed`, `openapi`
  - `src/index.ts` bootstrap, `src/seed.ts`, `src/scenario.tests.ts`

#### Key adaptation decisions

- `file:../dcb-event-store/packages/...` paths used for unpublished `@dcb-es/*` packages (switch to npm versions when published)
- `@test` alias redirected from `../../test` (monorepo) to `./src/test` (standalone)
- `postgres:16` used in docker-compose and globalSetup for consistency

#### Verification issues found (2026-09-21)

**Issue 1 — `@types/pg` version conflict with `file:` references**
- `npm install` with `"@types/pg": "^8.20.0"` resolved to `8.23.1`, which has a different `on()` overload signature than `8.20.0` (used in the DCB pnpm monorepo). TypeScript treated the two copies as structurally incompatible when passing `Pool` across the `file:` boundary, causing `tsc` to fail.
- Fix: pinned `"@types/pg": "8.20.0"` (exact, no `^`) and added `"overrides": { "@types/pg": "8.20.0" }` to prevent transitive resolution to a newer version.
- Note: `skipLibCheck: true` was added to `tsconfig.json` as well for general robustness with `file:` cross-package-manager setups, though alone it was not sufficient for this error (which appeared in source files, not `.d.ts` files).

**Issue 2 — Wrong error type in `change-course-capacity/decider.ts`**
- The "new capacity is the same as current" invariant check used `ValidationError` (→ HTTP 400) instead of `IllegalStateError` (→ HTTP 422). The test expected 422.
- Error type mapping: `ValidationError` = 400 (bad input format), `IllegalStateError` = 422 (business rule violation), `NotFoundError` = 404.
- Fix: `throw new ValidationError(...)` → `throw new IllegalStateError(...)`.

#### Verification result

- `eventmodelers init --stack dcb` ✅
- `npm install` ✅
- `npm run build` (tsc --noEmit) ✅
- 21/21 write-slice unit tests (no Docker) ✅
- Integration tests + scenario tests require `docker compose up -d` (not run in CI)

---

### Phase 2: Build State Change Skill ✅

**Goal:** Claude can build a state-change slice from a `slice.json` using DCB patterns.

#### What was built

`stacks/dcb/templates/.claude/skills/build-state-change/SKILL.md` — 9-step skill:

1. Read `slice.json`
2. Ensure `src/contexts/{context}/Events.ts` — append tagged event factories
3. Create `command.ts` — `Command<"typeName", { fields }>`
4. Create `decisionModels.ts` — `EventHandlerWithState` with `tagFilter`, `init`, `when`
5. Create `decider.ts` — `decider<Cmd, State>({ handlers, decide })`
6. Create `schema.ts` — Zod schema with `.openapi()` extensions
7. Create `route.ts` — `validateBody`, `on`, `handle`, `withETag`, HTTP response
8. Create `route.tests.ts` — `ApiSpecification.for(...)` with `MemoryEventStore`
9. Wire route into `src/index.ts`

Includes patterns for all decision model shapes, correct error types (`NotFoundError`/`IllegalStateError`/`ValidationError`), and a verification checklist.

---

### Phase 3: Build State View Skill ✅

**Goal:** Claude can build a state-view slice from a `slice.json` using DCB patterns.

#### What was built

`stacks/dcb/templates/.claude/skills/build-state-view/SKILL.md` — 5-step skill:

1. Read `slice.json`
2. Create `projection.ts` — `pongoProjection({ name, canHandle, init, handle, truncate })`
3. Register in `src/index.ts` — `projection.init`, `projectionToProcessor`, `waitFn`
4. Create `route.ts` — `preferWait({ waitFn })` before GET + `withETag(bookmarkPosition)` + `OK`
5. Create `route.tests.ts` — integration tests with `getTestPgDatabasePool`, `createConsumer`, `waitUntilProcessed`

Includes Pongo operation patterns (`insertOne`, `updateOne`, `$push`, `filter`, cross-collection lookup).

---

### Phase 4: Build Automation Skill ✅

**Goal:** Claude can build an automation slice from a `slice.json` using DCB patterns.

#### What was built

`stacks/dcb/templates/.claude/skills/build-automation/SKILL.md` — 5-step skill:

1. Check target command slice exists
2. Create `processor.ts` — event-triggered processor that issues a command via `handle(store, decider, cmd)`
3. Register in `src/index.ts` — add to `createConsumer` processors array
4. Create `processor.tests.ts` — `MemoryEventStore` unit tests
5. Verify wiring

---

### Phase 5: Build Kit Configuration ✅

**Goal:** `.build-kit/CLAUDE.md` and supporting files correctly guide Claude when building slices.

#### What was built

- `build-kit/CLAUDE.md` — DCB path convention (`src/contexts/{context}/slices/{slicename}/`), no migrations, no Knex, programmatic OpenAPI, 6 commit scope checks listed
- `build-kit/lib/AGENT.md` — DCB-specific agent learnings
- `build-kit/lib/prompt.md` + `backend-prompt.md` — task processing prompts adapted for DCB
- `build-kit/lib/check-commit-scope.cjs` — runner adapted with DCB `SLICE_PATTERN`
- Commit checks (6 total — `20-append-only-migrations` and `60-openapi-annotation` omitted as not applicable to DCB):
  - `00-blocked-paths.cjs` — blocks `package.json`/lockfiles and `src/index.ts`
  - `10-slice-scope.cjs` — enforces `src/contexts/{context}/slices/{slicename}/`; exceptions for `src/contexts/{context}/Events.ts` and `src/index.ts`
  - `30-test-file-present.cjs` — `decider.ts`/`projection.ts` → `route.tests.ts`; `processor.ts` → `processor.tests.ts`
  - `40-no-invented-fields.cjs` — heuristic field check for `Command<"name", { ... }>` type literals vs `slice.json`
  - `50-spec-coverage.cjs` — counts `test()`/`it()` blocks vs `specifications[]` in `slice.json`
  - `90-tsc-build.cjs` — runs `npx tsc --noEmit`

---

### Phase 5.5: Prove DCB Build Kit Skills ✅

**Goal:** Verify all three skill templates generate correct code from slice.json input before Ralph loop integration.

#### What was done

**5.5a — Test Input Creation**
- Created 8 slice.json files in `eventmodelers-cli/stacks/dcb/tests/enrollment-proof/slices/` matching the enrollment reference domain (register-course, register-student, subscribe-student, unsubscribe-student, change-course-capacity, course-details, student-details, student-subscribed-notification)

**5.5b — State Change Skill Proof**
- Setup: restored subscribe-student, created git baseline (29/29 tests)
- Test 1: register-student deleted and regenerated from skill → 29/29 pass
- Test 2: subscribe-student deleted and regenerated from skill → 29/29 pass

**5.5c — State View Skill Proof**
- student-details deleted and regenerated from skill → 29/29 pass

**5.5d — Automation Skill Proof**
- student-subscribed-notification created from skill → 30/30 pass (1 new test)

**5.5e — Skill Fixes from Proof Findings**
- **build-automation/SKILL.md** — critical rewrite: replaced broken `canHandle/handle` pattern with correct `ConsumerProcessorConfig` + `handlerFactory`; fixed tests to use `handlerFactory` directly instead of non-existent `store.readAll()`; fixed index.ts wiring to direct factory call instead of spread
- **build-state-change/SKILL.md** — added `generated: true` field handling (GUID default, exclusion from command type and Zod schema)
- **build-state-view/SKILL.md** — added lookup collection naming convention (`_{projectionName}_{entityPlural}`)

#### Proof project
- Location: `~/Projects/enrollment-proof-project/` (30/30 tests, git baseline + proof commits)
- All generated code compiles and passes tests without manual intervention

---

### Phase 6: Ralph Loop Integration ✅

**Goal:** Verify that the DCB skill templates produce correct code when invoked via the Ralph dispatch pattern (read slice.json → determine type → follow matching build-* skill).

#### Approach

Nested Claude sessions are blocked (`CLAUDECODE` env var prevents `claude -p` inside another Claude Code session), so Phase 6 tests simulate Ralph's dispatch by manually following `backend-prompt.md` steps: reading slice.json, determining slice type, and executing the matching `build-*` skill template step by step.

#### What was done

| Step | Slice | Type | Result |
|------|-------|------|--------|
| 6.1 | — | — | Baseline verification: 30/30 tests, tagged `phase6-baseline` |
| 6.2 | — | — | Mock `.build-kit/.slices/` structure: 8 slice.json files + index.json + current_context.json |
| 6.3 | — | — | Mock board config: `.eventmodelers/config.json` with `RALPH_LOCAL=1` |
| 6.4 | register-course | STATE_CHANGE | Delete → rebuild from skill → 28/28 tests (4 spec-matched vs 6 baseline) |
| 6.5 | subscribe-student | STATE_CHANGE | Delete → rebuild from skill → 28/28 tests (5 spec-matched tests) |
| 6.6 | student-details | STATE_VIEW | Delete → rebuild from skill → 27/27 tests (3 spec-matched vs 4 baseline) |
| 6.7 | student-subscribed-notification | AUTOMATION | Delete → rebuild from skill → 27/27 tests (1 spec-matched test) |

#### Key Findings

1. **Nested Claude sessions blocked**: `ralph-claude.js` spawns `claude -p` as a subprocess, which fails with "Claude Code cannot be launched inside another Claude Code session." Ralph dispatch chain (detecting Planned, reading backend-prompt, routing to skill) confirmed working — only the nested-session limitation prevents end-to-end execution.

2. **id field in schema**: When a command field has `idAttribute: true` and `generated` is absent/false, include the `id` in the Zod body schema. The client sends it. This keeps deciders pure, route tests deterministic, and idempotent creation possible.

3. **Test count difference**: Skill-generated code produces tests matching specifications only (no bonus infrastructure tests). Baseline register-course had 6 tests (4 specs + 2 bonus); skill rebuild produces 4. Baseline student-details had 4 tests (3 specs + 1 bonus unsubscribe); skill rebuild produces 3. This is correct behavior — skills generate from specs.

4. **Cross-slice decision models**: The subscribe-student slice correctly consumes events from register-course (`courseWasRegistered`) and change-course-capacity (`courseCapacityWasChanged`) via shared Events.ts imports. The skill template's cross-slice guidance works.

5. **All three slice types validated**: STATE_CHANGE (subscribe-student), STATE_VIEW (student-details), and AUTOMATION (student-subscribed-notification) all rebuild correctly from their slice.json definitions using the corresponding skill templates.

> **Testing guide:** See `eventmodelers-cli/stacks/dcb/RALPH-TESTING-GUIDE.md` for the full methodology.

---

### Phase 8: Postgres Integration Tests for State-Change Slices ✅

**Goal:** Generate per-slice Postgres integration tests for every state-change slice, verifying that events are actually persisted with all `SequencedEvent` fields correct.

#### Motivation

Unit tests (`route.tests.ts`) use an in-memory `MemoryEventStore` with `pool: {} as Pool` — they verify business rules and emitted `TaggedEvent` shapes but never touch Postgres. This leaves zero confidence that events are persisted correctly: payload JSON round-trip, tags as TEXT[], UUID generation, sequential position, timestamp, schema version.

The `build-state-view` skill already proves the Postgres+testcontainers pattern works. This phase extends `build-state-change` to generate a matching integration test file.

#### What was built

**Phase A — Prototype:**
- Created `route.integration.tests.ts` for `register-course` in the enrollment-proof project
- 4 integration tests mirroring the 4 unit test scenarios, all passing against real Postgres
- Validates all `SequencedEvent` fields: `event.type`, `event.data`, `tags.values`, `id` (UUID), `position`, `recordedAt`, `schemaVersion`
- Error scenarios verify no events persisted after the seed position

**Phase B — Skill template updates:**

| File | Change |
|------|--------|
| `build-state-change/SKILL.md` | Added Step 8b with full integration test template, comparison table, and what-it-catches documentation |
| `build-kit/CLAUDE.md` | Updated example slice structure and spec-coverage description to include `route.integration.tests.ts` |
| `build-kit/lib/checks/50-spec-coverage.cjs` | Updated comment to document that the check applies independently to each `*.tests.ts` file |
| `RALPH-TESTING-GUIDE.md` | Updated test coverage table, generated file inventory, and infrastructure gaps section |
| `PLAN.md` | This phase entry |

#### Key API details discovered during prototype

- `SequencePosition.initial()` (not `.zero()`) returns position 0
- `SequencePosition.value` is private — use `.isAfter(SequencePosition.initial())` for assertions
- `Tags` exposes `.values` (string array), not `.toArray()`
- `SequencedEvent.schemaVersion` is optional in the type but defaults to `"1"` from Postgres
- `streamAllEventsToArray(store.read(Query.all()))` reads all events; use `{ after: position }` to skip seeded events
- No consumer/projection setup needed — integration tests only verify event persistence

#### Verification

- `route.integration.tests.ts` compiles: `npm run build` ✅
- 4 integration tests pass: `npx vitest run .../register-course/route.integration.tests.ts` ✅
- Full suite: 31/31 tests (10 files) ✅

#### Proof Run — Full delete-and-rebuild of register-course

Validated that the updated SKILL.md (with Step 8b) produces both test files when rebuilding a slice from scratch. Following the RALPH-TESTING-GUIDE §4 methodology:

1. Baseline: 31/31 tests, 10 files
2. Deleted all 7 files in `register-course/` (command, decider, decisionModels, schema, route, route.tests, route.integration.tests)
3. Followed SKILL.md Steps 1–9 (including 8b) sequentially
4. Result: all 7 files regenerated, `npm run build` clean, 31/31 tests (4 unit + 4 integration for register-course)

**Key finding:** Step 8b's placement between Steps 8 and 9 ensures an agent following the skill sequentially will always generate integration tests. The numbered sequence is sufficient — no separate "outstanding work" detection is needed.

---

### Phase 9: Progressive Read Model Evolution ✅ (core done — see Remaining)

**Goal:** Let a read model grow one event at a time as the timeline is discovered, without breaking vertical-slice ownership and without regenerating the projection from a full-board snapshot.

#### The scenario

`course-manager-web-api-sliced/src/contexts/enrollment/slices/course-details/projection.ts` handles six events (`courseWasRegistered`, `courseTitleWasChanged`, `courseCapacityWasChanged`, `studentWasRegistered`, `studentWasSubscribed`, `studentWasUnsubscribed`). That was built from a **snapshot** of a finished model. A real project doesn't grow that way:

1. **t0:** only `courseWasRegistered` exists. `course-details` projects `{courseId, title, capacity}`.
2. **t1:** a new state-change slice adds `courseCapacityWasChanged`. The read model now also has to react to it.
3. **t2:** `studentWasSubscribed` shows up. The read model gets a new field (`subscribedStudents[]`) **and** needs a private lookup of student data (`studentWasRegistered`).

The state-view slice owns the projection, its table/collection, and its route. Every later event that affects that read model comes from a *different* slice. So the question is where the code for "handle the new event" lives, and who changes the storage shape.

#### What each kit does today

| Concern | DCB kit (Pongo, `stacks/dcb`) | Node kit (Emmett, `stacks/node`) |
|---|---|---|
| Projection style | `pongoProjection` running **async** in a consumer with its own `_handler_bookmarks` row (ADR-014) | `postgreSQLRawSQLProjection` running **inline**, registered in `loadPostgresEventstore.ts` `projections.inline([...])`, and its SQL runs in the append transaction |
| Storage shape | Schemaless JSONB. `init()` does `createCollection()`, so no migrations | Typed table from `migrations/V{N}__{table}.sql` (Flyway) |
| Adding a field | No DDL. Old docs just don't have the field | Needs a **new** `ALTER TABLE ... ADD COLUMN` migration. The `20-append-only-migrations` check forbids editing the original one |
| Who may change storage | Only the owning slice (`init()` sits in its `projection.ts`) | **Any** slice commit. `10-slice-scope` lets `migrations/V*.sql` through from every slice, so the schema history is global and owned by no slice |
| Who may change projection code | Only the owning slice folder. `src/index.ts` is the only shared exception | Only the owning slice folder. `loadPostgresEventstore.ts` is the only shared exception |
| Skill guidance for *extending* an existing projection | **None.** Step 2 says "Create `projection.ts`", which is greenfield only | **None.** Step 2 always emits `CREATE TABLE IF NOT EXISTS`, and Step 3 says "Create `{SliceName}Projection.ts`" |
| Replay / backfill | None generated (ADR-016). `rebuildProjection()` exists in the library but isn't wired up | `src/common/replay.ts` → `rebuildPostgreSQLProjections()` per projection |

#### Findings

1. **The node kit does not handle progressive development better. It has a latent bug here.** If the agent rebuilds a state-view slice after a new event adds a field, the skill as written produces another `CREATE TABLE IF NOT EXISTS`. That migration is a **no-op** because the original `V{n}` has already created the table, and that is true in a fresh test DB as well as in production. So the new column never appears. The agent's only way out is to edit the original migration, which `20-append-only-migrations` blocks, so the kit has no working path from t0 to t1. The `IF NOT EXISTS` learning in `backend-prompt.md` turns what would be a loud failure (`relation already exists`) into a silent one (a missing column).
2. **The node kit does bend ownership, but for the schema, not the projection.** Migrations sit outside every slice folder, are exempt from `slice-scope`, and form one global, append-only timeline. Any slice can `ALTER` another slice's table. Projection *code* stays strictly owned: a later slice still can't edit `course-details/…Projection.ts` in its own commit (`10-slice-scope` rejects cross-slice commits). So the node kit hasn't solved the tension. It has separated schema history from code ownership, and the skill doesn't take advantage of that.
3. **For additive evolution, Pongo helps more than it hurts.** New fields and new events need no DDL. Old docs lacking the field is the only gap, and replay closes it. Where Pongo is weaker is types, indexes, and joins (ADR-001), not iteration. Moving to raw SQL + Flyway only for this scenario would add a second artifact (the migration) that has to evolve in step with the projection. That is more coordination, not less.
4. **The real gap is the same in both kits: `build-state-view` is greenfield-only.** Neither skill has an "extend" path: read the existing projection, diff `slice.json.events[]` against the current `canHandle`, and add only the new cases, fields, lookups, and tests.
5. **In event modeling terms the tension mostly goes away.** A state-view slice is *the READMODEL plus its inbound events*. Connecting a new event to an existing READMODEL on the board **changes that state-view slice**, not the new state-change slice. The state-change slice that introduces `courseCapacityWasChanged` owns the command and the event. The `course-details` slice owns the reaction to that event. So the change belongs to the read model's slice, re-opened (status back to `planned`) and rebuilt *incrementally*. It doesn't need to be pushed from the producing slice.

#### Decision (supersedes "Option A" above)

The read model's growth is modeled as **copies**. prooph board encourages copying a read model forward
after each new event rather than drawing a backward arrow. Each copy is its own **extension slice**. Its
code goes into the **origin's** `projection.ts` as additive edits. Option A's "reopen the origin slice"
leaves the growth step with no slice to track. Option C (fragments) spreads one read model across N
folders that still depend on each other. Option B stays rejected for async projections.
Full rationale: `stacks/dcb/ADR.md` ADR-019 (extension slices) and ADR-020 (automatic rebuild).
Storage stays Pongo: an extension then needs no schema change.

#### What was built

**emcli** (`~/Projects/emcli`, branch `feat/read-model-copies`, 108 tests):
- `element.copyOf`: local-only, preserved on pull, root-origin only, same type, later on the timeline. Commands: `element copy`, `element update --copy-of/--clear-copy-of`. Removing an origin that still has copies, or moving a copy out of timeline order, is rejected (`cli/model/domain/copy.ts`).
- Export: `linkedTo` on elements, and an `extends { origin…, previousInstanceId, addedEvents, addedFields }` block on the copy's slice. The delta is measured against the nearest earlier instance, and an event that is itself a copy counts as its origin. A STATE_VIEW slice's `events[]` is now filled from its read model's inbound events (it was empty before, which also affected the axon5 prompt). An extension lists only `addedEvents`.
- `workspace export --build-kit <dir>`: writes the Ralph `.slices/` layout. Loop-owned statuses (InProgress/Blocked/Done) are kept on re-export.
- `element field add --subfields name:Type,…` for Custom fields.
- Fixed `ISSUES.md` (copies share `details`): a copy group's dependency tables are rendered into the per-element `description`.
- Test suite made runnable: vitest and ajv added, and a vendored `eventmodeling.schema.json` extended with the fields emcli actually emits.

**DCB build kit** (branch `feat/extension-slices`):
- `build-state-view` SKILL.md: Step 0 mode switch, plus "Extending an existing projection" E1–E6 (guard, additive projection edits, route defaults, test block, automatic replay, no new wiring) and matching checklist items.
- Test template: setup at module level, reset through `projection.truncate()`, scenarios asserted with `toMatchObject`.
- `templates/root/src/shared/ensureProjectionsCurrent.ts`: fingerprint (`version` + sorted `canHandle`) triggers `rebuildProjection()` at startup. Wired in the template `index.ts`.
- Check `15-extension-additive.cjs`: while an extension slice is InProgress, changes stay in its origin's folder, the projection only gains lines, and there's a `describe("{title}")` with a test per spec.
- Kit `CLAUDE.md`: extension dispatch, `sliceType === "STATE_VIEW"` dispatch, the check list, and an explicit exception to the "don't touch test files" rule.
- Template `tsconfig.json`: `paths` `@test/*` → `./src/test/*.ts`. Without it the Phase 8 integration tests fail the tsc commit check (NodeNext does no extension probing).
- Modeling-kit rules (`eventmodeling-core-rules`, `eventmodeling-slicing-event-models`): a READMODEL copy with new inbound events now implies an extension slice.

#### Proof run (`~/Projects/enrollment-progressive`, tags `t-empty` → `t0` … `t4`)

DCB scaffold stripped to an empty enrollment context. Modeled one increment at a time with emcli
(`model/t0.sh` … `t4.sh`, re-runnable), exported with `--build-kit`, and built slice by slice following
the skills (simulated dispatch; nested `claude -p` is still blocked, Phase 6 finding 1). A long-lived
docker-compose Postgres was kept across every step.

| Step | Built | course-details handles | Live DB after deploy |
|---|---|---|---|
| t0 | register course, course details | courseWasRegistered | c1, c2 readable; duplicate → 422 |
| t1 | change course capacity, **ext** capacity | + courseCapacityWasChanged | c1 capacity 45: a change made *before* the extension, picked up by the rebuild |
| t2 | register/subscribe student, **ext** subscriptions | + studentWasRegistered, studentWasSubscribed | c1 [Ada, Grace], c2 [Grace]. All recorded before the extension, at positions 5–9, **behind the bookmark (10)** |
| t3 | unsubscribe student, **ext** unsubscriptions | + studentWasUnsubscribed | Grace's pre-extension unsubscribe from c1 applied; c2 kept her |
| t4 | change course title, **ext** title | + courseTitleWasChanged | c3 renamed "Quantum Physics" (pre-extension) |

**Pass criteria:**
- Every `t{n-1}..t{n}` diff of `course-details/projection.ts` only adds lines. The single removed line per step is the previous last `canHandle` entry gaining a comma. ✅
- Final `canHandle` is identical to the reference projection's six events. ✅
- 32/32 tests, 13 files. ✅
- Commit checks passed on every slice commit. Negative tests confirmed the check blocks an edited existing case, and a missing extension `describe` block. ✅

**Not verified:**
- The reference projection's own tests weren't ported. The progressive model deliberately differs (`courseId` not `id`, no generated `studentNumber`), so equivalence means the same events and per-event behaviour, checked by our specs and the live DB.
- The real Ralph loop (`eventmodelers run --local`) wasn't run: run it from a plain terminal outside Claude Code.

#### Findings from the proof run

1. **Replay is necessary, not optional.** The consumer's bookmark advances to every handled event, so a newly handled type's history is skipped whenever a handled event came after it. At t2 the student events sat at positions 5–9 behind bookmark 10. The build agent can't see the live log, so ADR-020 makes the rebuild automatic.
2. **Exact-shape assertions break growing read models.** The t0/t1 tests used `toEqual`, and t2 (a new field) failed them although their scenarios still held. That was fixed in a separate labelled commit (`test: assert read-model scenarios with toMatchObject`), and the template now requires `toMatchObject`. This was the only edit to an earlier test in the whole run.
3. **Test setup must sit outside the scenario `describe`.** Otherwise an appended extension block has no setup. Resetting through `truncate()` keeps new lookup collections out of the setup.
4. **Kit bug:** the Phase 8 integration-test template failed the tsc commit check (`@test` alias unresolved). Fixed in the template `tsconfig.json`.
5. **Scaffold friction:**
   - `eventmodelers init` crashes on a closed stdin at the credentials prompt (`ERR_USE_AFTER_CLOSE`).
   - The DCB scaffold wires no git hook, so checks must be run by hand (`node .build-kit/lib/check-commit-scope.cjs --staged`).

#### Remaining

- [x] **9.6** Run the real Ralph loop over the proof project (`eventmodelers run --local`) from a plain terminal, starting at `t-empty` with the t0–t4 exports. *(Done: the unattended journey run `t-empty` → `t4`, then again in 10.3 against chapter `Course Enrollment`: 11 slices, 42/42 tests.)*
- [ ] **9.7** Node kit: port the extend mode, and replace re-emitted `CREATE TABLE IF NOT EXISTS` with an `ALTER TABLE ... ADD COLUMN` migration path (finding 1 above).
- [x] ~~**9.9** Does the eventmodelers `slicedata` export carry `linkedTo`?~~ *Dropped: the eventmodelers board is no longer used. Its slice schema survives only as the format the kit's skills generate code from, and emcli (prooph board + `workspace.json`) is the only slice source, so emcli computes `extends`.*
- [x] **9.10** Does prooph REST expose element copy, and does pull mark copies? If it does, `copyOf` can be pulled instead of kept local.
  *(Answered 2026-09-23: **no**, so `copyOf` stays local. REST has `POST /chapters/{id}/elements/{id}/copy`, and the
  board does link the copy internally: editing the origin's `details` changed the copy's, while `description`
  stays per element. But no response carries the link. `GET /chapters/{id}` and `GET .../elements/{id}` return
  identical key sets for origin and copy, with no origin/group field, and neither the OpenAPI spec (`/openapi.json`)
  nor the copy response mentions one. Probed in a scratch chapter, since deleted. The manual now tells readers to mark a
  board-made copy with `element update --copy-of` after a pull. Follow-up done in emcli (`ec6470b`): `sync pull`
  warns about each new read model that has the same name as an earlier one in its chapter and no `copyOf`, and
  prints the `element update --copy-of` command that marks it.)*
- [x] **9.11a** Install a pre-commit hook in the DCB scaffold. *(Done in PR #8: `.githooks/` plus `"prepare": "git config core.hooksPath .githooks"` in the scaffold's `package.json`, so `npm install` enables it.)*
- [ ] **9.11b** Fix `eventmodelers init` on a closed stdin (`ERR_USE_AFTER_CLOSE` at the credentials prompt). Parked: it only affects unattended setup (scripts, CI, agents), not the manual's interactive path.

---

### Phase 10: User Manual ✅

**Goal:** A user manual (`docs/USER-MANUAL.md`) for a developer new to event sourcing. It walks from an empty
directory to a working, progressively grown app using emcli, prooph board, the DCB build kit and the Ralph loop.
Concepts are explained as they come up, every command is given in full, and sample data is used throughout.
The source of truth is the unattended user-journey run (`~/Projects/enrollment-journey/journey/log.md`, tags
`t-empty` → `t4`; kit fixes merged in PR #7 and #8).

The work is split in two because browser tools only load when a Claude Code session starts, and the Chrome
extension was installed mid-session.

#### Step 1: write and verify the manual (this session, no browser)

- [x] **10.1 Draft `docs/USER-MANUAL.md`.** Concepts, then setup, then increments t0–t4, the client round trip,
  how the loop works, rebuilds, troubleshooting, command reference and known limits. Sample data throughout
  (courses c1–c6, students s1–s2).
- [x] **10.2 Board diagrams.** `docs/tools/board-diagram.mjs` renders a chapter of `workspace.json` as SVG: lanes
  as rows, slices as columns, stickies colored by type, copies with a dashed outline, and status badges. The
  diagrams are generated at each checkpoint into `docs/images/diagram-*.svg`.
- [x] **10.3 Verification walkthrough.** Follow the manual literally in `~/Projects/enrollment-manual` against a
  new board chapter, **`Course Enrollment`**. *(Done: t0–t4 built unattended, 11 slices, 14.4 min, $7.83, 42/42 tests; project at `~/Projects/course-enrollment`, tags via `Merge increment tN` commits on `main`.)* Gary starts `eventmodelers run --local` in his terminal when asked.
  Fix every command or expected output that doesn't match what happens.
- [x] **10.4 Screenshot slots.** Each checkpoint below gets a marked slot in the manual
  (`<!-- SCREENSHOT:SSn -->` plus a placeholder image `docs/images/SSn.png` referenced by name) next to the
  generated diagram.
- [x] **10.5 PR + merge** of the manual, the diagram tool and the images; link the manual from README.md.
- [x] **10.8 (kit) Recover stale InProgress on loop start.** If the agent is interrupted (usage limit, crash),
  the slice stays InProgress. The loop retries every 60 s, but the retried agent only builds Planned slices, so
  the loop idles. On startup/idle, the loop should detect an InProgress slice with no running agent and reset it
  to Planned (after stashing partial work). *(Done in `shared/build-kit/lib/ralph.js`, `--local` mode: each agent run
  records the InProgress set and a worktree snapshot (plus a run marker for a killed loop). When the run ends, or the
  loop next starts, the slices it left InProgress go back to Planned and only the paths the run dirtied are stashed.
  If HEAD moved, the slice is marked Blocked instead of being rebuilt. With board sync, the loop can't tell its own
  claim from another agent's, so it only warns. Not ported to the react stack's own `lib/ralph.js` or to `ralph.sh`.)*

#### Step 2: screenshot pass (next session, Chrome connected)

- [x] **10.6 Capture** each checkpoint from the live board chapter `Course Enrollment` (prooph board, same
  workspace as `Faculty` / `Enrollment`). Save to `docs/images/SSn.png`, replace the matching
  `<!-- SCREENSHOT:SSn -->` slot, then PR + merge. *(Done: SS2, SS3, SS4, SS6, SS7 captured from the final t4 board.
  SS1 and SS5 show pre-t4 states, so those slots were dropped and the generated diagrams `diagram-t0-pushed.svg` /
  `diagram-t1-staged.svg` stand in for them.)*

| ID | Checkpoint | What must be visible |
|---|---|---|
| SS1 | After the first push (t0 modeled) | Chapter `Course Enrollment`: lanes Student / Enrollment / Enrollment Events; slices `register course`, `course details` (status planned) |
| SS2 | An element's generated content | `CourseDetails` sticky opened: field list in the description, dependency table ("Dependencies (CLI-managed)") |
| SS3 | A slice's specs | `register course` slice details: the "Specifications (CLI-managed)" GWT block |
| SS4 | After t0 is built | Both t0 slices show status **ready** (mirrored via `import-status` + `sync push`) |
| SS5 | t1 modeled, extension staged | `course details capacity` slice with the `CourseDetails` copy, status **draft**; the copy's dependency table lists both events (cumulative) |
| SS6 | The client note | A note on the `course details subscriptions` slice |
| SS7 | Final board (t4) | All 11 slices **ready**; four `CourseDetails` copies along the timeline |

---

### Phase 7: Board Re-pointing — dropped

**Goal:** Point the CLI to a different board ("Proof Board") with separate credentials/API.

*Dropped (2026-09-23): the eventmodelers board is retired. prooph board is the only board, reached through emcli
(`workspace.json`), so there is nothing left to re-point `eventmodelers fetch` at.*

#### Tasks

- [x] ~~**7.1 Gather Proof Board credentials and API endpoint**~~
- [x] ~~**7.2 Configure `.eventmodelers/config.json`** with new board details~~
- [x] ~~**7.3 Verify connectivity** — `eventmodelers fetch` works against new board~~

---

## Test Coverage by Slice Type

What each `build-*` skill generates and what it verifies:

| Slice Type | Skill | Test File(s) | Store | Docker | What's Verified |
|------------|-------|-------------|-------|--------|-----------------|
| **STATE_CHANGE** | `build-state-change` | `route.tests.ts` | `MemoryEventStore` | No | Business rules, emitted `TaggedEvent` shape, HTTP status codes, Zod validation |
| | | `route.integration.tests.ts` | `PostgresEventStore` | Yes (testcontainers) | All of the above **plus** JSON round-trip, tags as TEXT[], UUID `id`, sequential `position`, `recordedAt` timestamp, `schemaVersion`, error scenarios persist nothing |
| **STATE_VIEW** | `build-state-view` | `route.tests.ts` | `PostgresEventStore` | Yes (testcontainers) | Projection init/handle, Pongo JSONB persistence, consumer + `waitUntilProcessed`, HTTP GET with ETag |
| **AUTOMATION** | `build-automation` | `processor.tests.ts` | `MemoryEventStore` | No | Event triggers correct command, `handlerFactory` wiring, emitted event assertions |

### Coverage gaps

| Gap | Affected Slice Type | Notes |
|-----|---------------------|-------|
| No Postgres integration tests | AUTOMATION | Processor tests use in-memory store only; no verification that the triggered command's event persists correctly through Postgres |
| No idempotency verification | STATE_CHANGE (integration) | Integration tests don't exercise the `findExistingPosition` → `message_id` path with a real Pool |
| No consumer/projection integration | STATE_VIEW | Tests verify projection logic but don't test the full `createConsumer` polling loop end-to-end |

---

## Decisions Log

> **Architectural decisions with full rationale and alternatives:** see [`eventmodelers-cli/stacks/dcb/ADR.md`](eventmodelers-cli/stacks/dcb/ADR.md) — 23 ADRs covering projections, identity, consistency, testing, error handling, idempotency, versioning, and more.

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-09-21 | Base on `course-manager-web-api-sliced` example | Most complete DCB example with commands, events, projections, routes, tests, and OpenAPI — vertical-slice architecture mirrors how build kit skills generate code |
| 2026-09-21 | Keep other stacks in repo (don't delete) | They don't affect our work and removing them risks breaking the CLI for other users. We'll focus only on `stacks/dcb/`. |
| 2026-09-21 | Use `file:` paths for `@dcb-es/*` packages | Packages not yet published to npm; using local monorepo at sibling path. Switch to npm versions when published. |
| 2026-09-21 | Inline monorepo test helpers into `src/test/` | `dcb-event-store/test/` is a monorepo-internal package not available standalone. `testPgDbPool.ts` and `vitest.globalSetup.ts` copied and adapted. |
| 2026-09-21 | Omit `20-append-only-migrations` check | DCB uses Pongo which auto-creates JSONB collections — no migration files exist to check |
| 2026-09-21 | Omit `60-openapi-annotation` check | DCB uses programmatic OpenAPI via `document.ts` + zod-to-openapi, not JSDoc `@openapi` blocks |
| 2026-09-21 | Pin `@types/pg` to `8.20.0` exact | DCB monorepo uses pnpm with `@types/pg@8.20.0`; `8.23.1` (npm default) has incompatible `on()` overloads. Pinned with `overrides` to prevent transitive drift. |
| 2026-09-22 | Simulate Ralph dispatch (no nested sessions) | `CLAUDECODE` env var blocks nested `claude -p`. Validated skill templates by manually following the dispatch pattern instead. |
| 2026-09-22 | Read-model copies are extension slices editing the origin projection (ADR-019) | Each growth step gets its own planned, tracked slice; one read model stays one projection file |
| 2026-09-22 | Automatic rebuild on changed `canHandle`/`version` (ADR-020, supersedes ADR-016) | Bookmarks skip a newly handled type's history; proven necessary in the t2 proof step |
| 2026-09-22 | Include `idAttribute` fields in Zod body schema | When a command field has `idAttribute: true` and no `generated: true`, include it in the body schema. Client sends it for deterministic tests and idempotent creation. |
| 2026-09-23 | Inline read models share `build-state-view`, chosen by `readModelType` (ADR-021) | Same projection code and extension steps as async; only wiring, route and tests differ. First sighting of an inline projection backfills from history |
| 2026-09-23 | Read specs' *when* carries the read operation (ADR-023) | Every read model is a keyed GET today. A *when* query with named parameters gives filtered reads a stable client contract, generated and tested from given/when/then |

## Progress

| Phase | Status | Notes |
|-------|--------|-------|
| 1 — Stack Scaffolding | ✅ Complete | Verified: init, npm install, tsc, 21/21 unit tests |
| 2 — State Change Skill | ✅ Complete | 9-step SKILL.md with full DCB patterns |
| 3 — State View Skill | ✅ Complete | 5-step SKILL.md with Pongo + preferWait patterns |
| 4 — Automation Skill | ✅ Complete | 5-step SKILL.md for event-triggered processors |
| 5 — Build Kit Config | ✅ Complete | CLAUDE.md, AGENT.md, prompts, 6 commit checks |
| 5.5 — Prove Skills | ✅ Complete | 8 slice.json inputs, 3 skills proven, 30/30 tests, automation skill rewritten |
| 6 — Ralph Loop | ✅ Complete | 4 slices rebuilt from skills (STATE_CHANGE, STATE_VIEW, AUTOMATION), all tests pass |
| 8 — Integration Tests | ✅ Complete | Postgres integration tests for state-change slices; prototype proven, skill template updated |
| 9 — Progressive Read Model Evolution | ✅ Core complete | emcli copies + extension slices, `build-state-view` extend mode, automatic rebuild; proven t0→t4 on a live DB (32/32). Real Ralph run done (9.6). Node kit port remains |
| 10 — User Manual | ✅ Complete | Manual written, verified and illustrated (board screenshots SS2–SS4, SS6, SS7; diagrams for t0 pushed / t1 staged). Kit follow-up 10.8 done (stale InProgress recovery in `--local` mode) |
| 11 — Read Model Types | ✅ Complete | Async, inline and live read models from one fold definition, with an identical data shape across types (ADR-021/022). Proven on course-enrollment t5–t10: inline, a retype to live and back, a new live read model with a lookup |
| 12 — Query Read Models | 🚧 In progress (top priority) | 12.1–12.3 done: ADR-023 query contract; emcli queries + `SPEC_QUERY` + `addQueries` re-queue; kit runtime (stored SQL + live, one semantics). Named queries on the read model element, the spec *when* references them, `{ data, cursor? }` pages; live needs a tag parameter |
| 7 — Board Re-pointing | ⛔ Dropped | eventmodelers board retired; prooph board via emcli is the only board |
