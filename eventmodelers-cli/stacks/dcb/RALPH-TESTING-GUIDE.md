# Ralph Loop Operations & Testing Guide (DCB Stack)

> How to validate DCB skill templates against a real project without a live board.

## 1. Purpose & Scope

This guide covers the methodology for validating that DCB build-kit skill templates (`build-state-change`, `build-state-view`, `build-automation`) generate correct, compiling, test-passing code from `slice.json` input. It is not a production operations guide — for Ralph's general architecture and entry points, see the shared `build-kit/README.md`.

Everything here is DCB-stack-specific: the enrollment-proof project, slice.json fixtures, Docker-backed integration tests, and `ApiSpecification` unit tests.

---

## 2. Ralph Loop — How It Works (DCB Perspective)

### Two-phase loop

Ralph processes slices in two phases:

1. **Board sync** (`prompt.md`) — Reacts to `slice:changed` events from the board. Loads credentials via `/connect`, fetches the slice definition via `/load-slice`, and determines the action based on `sliceStatus` (Planned → build, InProgress → skip, Done → summarise).

2. **Build** — the loop takes the next **job**: one concern of one slice (ADR-027). Each slice's `index.json` entry has `concerns` (`backend`, and `ui` when its screen has a mockup), each with its own status; the slice's `status` is derived from them. A Planned backend runs `backend-prompt.md`; a Planned UI whose backend is Done runs `screen-prompt.md` (`/build-screen`). The loop claims the job and names it in a "Your task" header above the routine; the agent sets its concern Done or Blocked.
3. **Memory** (ADR-028) — under "Your task", the loop gives the job "What the loop remembers": `learnings/shared.md` and the concern's `learnings/backend.md` or `ui.md`, the job's open notes from `progress.txt`, and for a UI job its backend's commit body (only without an API contract). To check a job's memory, read the `[ralph] memory: …` line in `ralph.log`; the journal (`progress.txt`) should hold only entries tagged `[slice:<id> concern:<backend|ui>]` for jobs that aren't Done, and each slice commit should have a body (`git log -1 --format=%B`). The loop's memory code is tested by `node --test .build-kit/lib/memory.test.js`.
4. **The API contract** (ADR-029) — `api/openapi.json`, written by emcli's export. With it, a UI job doesn't wait for its backend, and `run --local --concern ui|backend` builds one concern only (the loop's start lines say both). To check a project: `npm run contract:check` (every operation match, pending or differ; exit 1 on differ), and in a UI commit `web/src/lib/api-types.ts` must be what `npm run gen:api` generates from the contract (the `api-types` check). The loop's job order is tested by `node --test .build-kit/lib/concerns.test.js`, the comparison by `npx vitest run src/shared/contract.tests.ts`.

### Slice type routing

For a backend job, `backend-prompt.md` determines the slice type:

| Condition | Type | Skill |
|-----------|------|-------|
| `sliceType === "TRANSLATION"` | Translation | `/build-automation` |
| `processors` array non-empty | Automation | `/build-automation` |
| `projections` or `queries` array non-empty | State-view | `/build-state-view` |
| Default (has `commands`/`events`) | State-change | `/build-state-change` |

### Nested Claude session limitation

Ralph's `ralph-claude.js` spawns `claude -p` as a subprocess. Inside Claude Code, the `CLAUDECODE` environment variable is set, which blocks nested `claude -p` invocations with:

> "Claude Code cannot be launched inside another Claude Code session."

This means end-to-end Ralph execution cannot be tested from within a Claude Code session. The dispatch chain (detecting Planned, reading backend-prompt, routing to skill) is confirmed working — only the nested-session spawn fails.

### Dispatch simulation workaround

To validate skill templates without a live board or nested sessions, manually follow `backend-prompt.md` (or, for a UI job, `screen-prompt.md`) steps as a substitute:

1. Read the target `slice.json`
2. Determine the slice type using the routing table above
3. Follow the matching `SKILL.md` step by step
4. Run builds and tests

This is the approach used in Phases 5.5 and 6.

---

## 3. Test Infrastructure

### Enrollment proof project

- **Location:** `~/Projects/enrollment-proof-project/`
- **What it is:** A standalone DCB project created via `eventmodelers init --stack dcb`, containing the full enrollment domain (courses, students, subscriptions)
- **Baseline state:** 30/30 tests passing at git tag `phase6-baseline`
- **Contents:** 5 write slices, 2 read slices, 1 automation slice, plus infrastructure slices (course-list, event-feed, openapi)

### Slice.json fixtures

**Location:** `eventmodelers-cli/stacks/dcb/tests/enrollment-proof/slices/`

8 slice definitions covering all three slice types:

| Slice | Type |
|-------|------|
| `register-course` | STATE_CHANGE |
| `register-student` | STATE_CHANGE |
| `subscribe-student` | STATE_CHANGE |
| `unsubscribe-student` | STATE_CHANGE |
| `change-course-capacity` | STATE_CHANGE |
| `course-details` | STATE_VIEW |
| `student-details` | STATE_VIEW |
| `student-subscribed-notification` | AUTOMATION |

### Mock `.build-kit/.slices/` structure

To simulate Ralph's file layout in the proof project:

```
.build-kit/
└── .slices/
    ├── index.json              # Array of all slice definitions with status
    ├── current_context.json    # { "context": "enrollment" }
    └── enrollment/
        ├── register-course/
        │   └── slice.json
        ├── subscribe-student/
        │   └── slice.json
        └── ...
```

### Mock board config

```
.eventmodelers/
└── config.json    # Contains RALPH_LOCAL=1 to skip board API calls
```

---

## 4. Proof Run Methodology

How to validate that a skill template generates correct code from a slice.json definition.

### Step-by-step

1. **Establish baseline**
   - Ensure the proof project is at a known-good state (e.g. `git checkout phase6-baseline`)
   - Record the current test count: `npm test` and note passing/total
   - Create a git tag if needed: `git tag <phase>-baseline`

2. **Delete the target slice's generated files**
   - Remove all files under `src/contexts/<context>/slices/<slicename>/` except keep `Events.ts` intact
   - For automation slices, also check if the processor was registered in `src/index.ts`

3. **Follow the matching SKILL.md step by step**
   - Read the slice.json fixture
   - Determine the type using the routing table in §2
   - Open the corresponding skill: `eventmodelers-cli/stacks/dcb/templates/.claude/skills/build-<type>/SKILL.md`
   - Execute each numbered step in order, generating code files as specified

4. **Run builds and tests**
   ```bash
   npm run build          # tsc --noEmit
   npm test               # or: npx vitest run src/contexts/<context>/slices/<slicename>/
   ```

5. **Compare test counts**
   - Skill-generated code produces tests matching `specifications[]` in slice.json only
   - Baseline may include additional hand-written tests (infrastructure, edge cases)
   - A lower test count from specs-only is expected and correct — see §6

6. **Record findings**
   - Note what passed/failed
   - Document any skill template fixes needed
   - If fixes were applied, re-run from step 3 to confirm

### Validating multiple slices in sequence

When running a multi-slice proof (like Phase 6), rebuild slices one at a time and run the full test suite after each. The cumulative test count drops as hand-written "bonus" tests are replaced by spec-only generated tests.

---

## 5. What Each Skill Generates

### Test coverage by skill

| Skill | Test file | Test type | Postgres required? |
|-------|-----------|-----------|-------------------|
| `build-state-change` | `route.tests.ts` | Unit — `ApiSpecification` with `MemoryEventStore` | No |
| `build-state-change` | `route.integration.tests.ts` | Integration — `PostgresEventStore` with testcontainers, verifies all `SequencedEvent` fields | Yes |
| `build-state-view` | `route.tests.ts` | Integration — `getTestPgDatabasePool` with testcontainers | Yes |
| `build-automation` | `processor.tests.ts` | Unit — `MemoryEventStore` with `handlerFactory` | No |

### Generated file inventory

**State-change slice:**
- `command.ts` — Command type definition
- `decisionModels.ts` — `EventHandlerWithState` decision models
- `decider.ts` — `decider<Cmd, State>()` composition
- `schema.ts` — Zod schema with `.openapi()` extensions
- `route.ts` — Express route with `validateBody`, `on`, `handle`, `withETag`
- `route.tests.ts` — `ApiSpecification.for(...)` unit tests (no Docker)
- `route.integration.tests.ts` — Postgres integration tests verifying all `SequencedEvent` fields (testcontainers)

**State-view slice:**
- `projection.ts` — `pongoProjection({ name, canHandle, init, handle, truncate })`
- `route.ts` — GET route with `preferWait` + `withETag`
- `route.tests.ts` — Integration tests with `createConsumer`, `waitUntilProcessed`

**Automation slice:**
- `processor.ts` — `ConsumerProcessorConfig` + `handlerFactory`
- `processor.tests.ts` — Unit tests using `handlerFactory` directly

### Infrastructure gaps

The following are not generated by skill templates and would need to be addressed separately (tracked in GitHub issue #3):

- SSE (Server-Sent Events) endpoint
- Pagination for list endpoints
- Idempotency middleware
- Cross-slice integration tests (multi-slice end-to-end scenarios)
- OpenAPI document registration for new slices

> **Note:** Per-slice Postgres integration tests for state-change slices are now generated by `build-state-change` Step 8b. The "cross-slice integration tests" gap above refers to multi-slice end-to-end scenarios, not per-slice persistence verification.

---

## 6. Known Issues & Learnings

Collected from PLAN.md Phases 5.5 and 6.

### Automation skill rewrite (Phase 5.5e)

The original automation skill template used a `canHandle`/`handle` pattern that doesn't exist in the DCB library. It was rewritten to use the correct pattern:
- `ConsumerProcessorConfig` for processor configuration
- `handlerFactory` for the actual event handling logic
- Tests invoke `handlerFactory` directly instead of non-existent `store.readAll()`
- `index.ts` wiring uses direct factory call instead of spread

### `generated: true` field handling

When a command field has `generated: true`:
- Use GUID as default value
- **Exclude** from the `Command` type definition
- **Exclude** from the Zod body schema
- The field is system-assigned, not client-provided

### `idAttribute` + not `generated`

When a command field has `idAttribute: true` and `generated` is absent or `false`:
- **Include** in the Zod body schema — the client sends it
- This keeps deciders pure, route tests deterministic, and idempotent creation possible

### Lookup collection naming convention

State-view projections that perform cross-collection lookups use the naming convention:
```
_{projectionName}_{entityPlural}
```

### Test count difference: specs-only vs baseline

Skill-generated tests match `specifications[]` entries in slice.json exactly. Baseline (hand-written) code may include additional tests for edge cases, infrastructure, or scenarios not captured in specs.

Example from Phase 6:
- `register-course`: baseline had 6 tests (4 specs + 2 bonus), skill rebuild produces 4
- `student-details`: baseline had 4 tests (3 specs + 1 bonus), skill rebuild produces 3

This is correct behaviour — skills generate from specs only.

### Cross-slice decision model imports

The `subscribe-student` slice correctly consumes events from other slices (`courseWasRegistered` from register-course, `courseCapacityWasChanged` from change-course-capacity) via shared `Events.ts` imports. The skill template's cross-slice guidance works without manual intervention.

### Error type mapping

DCB uses three error types that map to HTTP status codes:
- `ValidationError` → 400 (bad input format)
- `IllegalStateError` → 422 (business rule violation)
- `NotFoundError` → 404 (entity not found)

---

## 7. Phase 6 Proof Run Results

Complete validation results from the Ralph loop integration proof:

| Step | Slice | Type | Tests | Notes |
|------|-------|------|-------|-------|
| 6.1 | — | — | 30/30 | Baseline, tagged `phase6-baseline` |
| 6.4 | register-course | STATE_CHANGE | 28/28 | 4 spec-matched vs 6 baseline |
| 6.5 | subscribe-student | STATE_CHANGE | 28/28 | 5 spec-matched tests |
| 6.6 | student-details | STATE_VIEW | 27/27 | 3 spec-matched vs 4 baseline |
| 6.7 | student-subscribed-notification | AUTOMATION | 27/27 | 1 spec-matched test |

All three slice types validated. All rebuilds compile and pass tests without manual intervention.
