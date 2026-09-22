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

---

### Phase 7: Board Re-pointing 🔲 (Lower Priority)

**Goal:** Point the CLI to a different board ("Proof Board") with separate credentials/API.

#### Tasks

- [ ] **7.1 Gather Proof Board credentials and API endpoint**
- [ ] **7.2 Configure `.eventmodelers/config.json`** with new board details
- [ ] **7.3 Verify connectivity** — `eventmodelers fetch` works against new board

---

## Decisions Log

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
| 7 — Board Re-pointing | 🔲 Not started | Lower priority — waiting on credentials |
