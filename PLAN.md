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

### Phase 6: Ralph Loop Integration 🔲 (Lower Priority)

**Goal:** The Ralph Loop can automatically build DCB slices when slice statuses change on the board.

#### Tasks

- [ ] **6.1 Knowledge gathering** — understand how Ralph dispatches to skills per stack
- [ ] **6.2 Verify shared Ralph components work** with DCB stack (`useShared: true` should handle this)
- [ ] **6.3 Test end-to-end:** board slice status change → Ralph picks up → skill runs → code committed

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

## Progress

| Phase | Status | Notes |
|-------|--------|-------|
| 1 — Stack Scaffolding | ✅ Complete | Verified: init, npm install, tsc, 21/21 unit tests |
| 2 — State Change Skill | ✅ Complete | 9-step SKILL.md with full DCB patterns |
| 3 — State View Skill | ✅ Complete | 5-step SKILL.md with Pongo + preferWait patterns |
| 4 — Automation Skill | ✅ Complete | 5-step SKILL.md for event-triggered processors |
| 5 — Build Kit Config | ✅ Complete | CLAUDE.md, AGENT.md, prompts, 6 commit checks |
| 6 — Ralph Loop | 🔲 Not started | Lower priority — needs investigation |
| 7 — Board Re-pointing | 🔲 Not started | Lower priority — waiting on credentials |
