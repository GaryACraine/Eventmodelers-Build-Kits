# DCB Event Store Stack — Project Plan

> Living document tracking the creation of a custom Eventmodelers Build Kit stack based on the DCB (Dynamic Consistency Boundary) event store library.

## Reference Implementations

| Role | Location |
|------|----------|
| **Build Kit (source patterns)** | `eventmodelers-cli/stacks/node/` — Emmett-based Node.js stack |
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

- [ ] **9.6** Run the real Ralph loop over the proof project (`eventmodelers run --local`) from a plain terminal, starting at `t-empty` with the t0–t4 exports.
- [ ] **9.7** Node kit: port the extend mode, and replace re-emitted `CREATE TABLE IF NOT EXISTS` with an `ALTER TABLE ... ADD COLUMN` migration path (finding 1 above).
- [ ] **9.9** Does the eventmodelers `slicedata` export carry `linkedTo`? If it does, derive `extends` kit-side so board-sourced slices get extension mode too (emcli is the only source of `extends` today).
- [ ] **9.10** Does prooph REST expose element copy, and does pull mark copies? If it does, `copyOf` can be pulled instead of kept local.
- [ ] **9.11** Fix `eventmodelers init` on a closed stdin; install a pre-commit hook in the DCB scaffold.

---

### Phase 7: Board Re-pointing 🔲 (Lower Priority)

**Goal:** Point the CLI to a different board ("Proof Board") with separate credentials/API.

#### Tasks

- [ ] **7.1 Gather Proof Board credentials and API endpoint**
- [ ] **7.2 Configure `.eventmodelers/config.json`** with new board details
- [ ] **7.3 Verify connectivity** — `eventmodelers fetch` works against new board

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

> **Architectural decisions with full rationale and alternatives:** see [`eventmodelers-cli/stacks/dcb/ADR.md`](eventmodelers-cli/stacks/dcb/ADR.md) — 18 ADRs covering projections, identity, consistency, testing, error handling, idempotency, versioning, and more.

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
| 9 — Progressive Read Model Evolution | ✅ Core complete | emcli copies + extension slices, `build-state-view` extend mode, automatic rebuild; proven t0→t4 on a live DB (32/32). Node kit port + real Ralph run remain |
| 7 — Board Re-pointing | 🔲 Not started | Lower priority — waiting on credentials |
