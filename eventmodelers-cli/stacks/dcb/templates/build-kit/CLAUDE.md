# Project Configuration

Read `src/contexts/` to understand the global structure. Events for each context live at `src/contexts/{context}/Events.ts`.

## File Structure Constraints

- **Strict Path Limitation**: if not instructed otherwise, only check `src/contexts/{context}/slices/{slicename}/*.ts`
- **Slice Organisation**: Each feature/domain is a separate slice under its context

## Code Standards

- **Language**: TypeScript only
- **Module System**: Use ES modules (import/export) with `.js` extensions in imports
- **Type Safety**: Ensure all code is properly typed

## Development Guidelines

1. Each slice is self-contained under `src/contexts/{context}/slices/{slicename}/`
2. Shared events live at `src/contexts/{context}/Events.ts` — add to it, never rewrite
3. No migration files — Pongo creates JSONB collections via `projection.init()`
4. OpenAPI documentation is programmatic via `src/contexts/{context}/slices/openapi/document.ts`

Only check `src/contexts/{context}/slices/{slicename}/*.ts`, do not check subfolders, unless explicitly tasked to build the UI.

Ignore case for contexts and slices in prompts.

Do not change files with tests unless explicitly instructed, or the change brings the test in line with slice.json: `*.tests.ts`. An extension slice appending its own `describe` block to its origin's `route.tests.ts` is explicitly instructed (build-state-view, E4), and so is a slice with `addQueries` appending one query block per added query (A5); existing tests there stay untouched.

At the start of every session, read `.build-kit/AGENTS.md` if it exists to load accumulated project learnings.

When starting to work on a slice, invoke the `update-slice-status` skill with `InProgress` status before doing anything else.

## Building a Slice

**CRITICAL: You MUST always use the provided skills to build slices. NEVER implement a slice manually.**
**ALL fields, event names, command names, and business rules MUST come exclusively from slice.json. Do NOT invent, assume, or guess any field or logic not present in the slice definition.**

**If, at any point below, the slice's requirements are genuinely ambiguous, contradictory, or missing a decision you need in order to proceed — do not guess, and do not build anyway.** Invoke the `request-feedback` skill with the specific question; it posts the question as a comment on the slice and marks it `Blocked`, then stop. Most slices are fully specified and need none of this.

When asked to build a slice, always follow this flow:

1. Read the slice definition from `.build-kit/.slices/<context>/<slicename>/slice.json`.
2. Determine the slice type:
   - **Translation** — `sliceType === "TRANSLATION"` → default to `/build-automation`
   - **Automation** — `processors` array is non-empty → invoke `/build-automation`
   - **State-view** — `sliceType === "STATE_VIEW"`, or `projections`/`queries` array is non-empty → invoke `/build-state-view`
     - Every read model type goes to `/build-state-view`: `database-projected` (async, the default), `inline-projected`
       (updated inside the append transaction) and `live-report` (folded from the event store per read). It writes one
       definition (`readModel.ts`) whose `type:` line picks how it runs, so every type returns the same data (ADR-022).
       Never build a different type than slice.json names.
   - **Retype** — a state-view slice whose slice.json has a `retype` block: the model switched a built read model's
     type → `/build-state-view` ("Changing a read model's type"). It changes the `type:` line only.
   - **Queries** — a state-view slice whose slice.json has `addQueries`: its specs now run queries the built read
     model doesn't serve yet → `/build-state-view` ("Adding queries"). It adds to `queries` and appends query
     tests only (ADR-023). With a `retype` block too, the retype is its own commit first.
   - **State-change** — default (has `commands` / `events`) → invoke `/build-state-change`
   - **Extension** — a state-view slice whose slice.json has an `extends` block. It grows a read model an
     earlier slice built (its read model is a board copy, `linkedTo` the origin) → `/build-state-view`,
     which edits the **origin** slice's projection, route and tests in place (its Step 0 decides this).
3. Invoke the matching skill and follow its instructions completely. Do not deviate.
4. **Verify against slice.json**: After the skill completes, diff slice.json against the code field by field. No invented fields — if it is not in slice.json, it must not be in the code.
5. Run quality checks (`npm run build`, then the slice tests only).
6. If checks pass, commit with `feat: [Slice Name]` and set slice status to `Done`.

After you are done, automatically run the tests for the slice that was edited.

## Commit Scope Guard

A pre-commit hook runs `.build-kit/lib/check-commit-scope.cjs` on every commit that touches `src/contexts/{context}/slices/{slicename}/`.
It loads every check under `.build-kit/lib/checks/` and rejects the commit if any find a problem:

- **blocked-paths** — `package.json`/lockfiles and `index.ts` are never touched by slice work
- **slice-scope** — everything staged must be inside the slice folder or a documented exception:
  `src/contexts/{context}/Events.ts`
- **extension-additive** — while an extension slice (`extends` in slice.json) is InProgress: changes stay in
  its origin's folder, the origin's `readModel.ts` / `projection.ts` only gains lines, and the origin's
  `route.tests.ts` has top-level blocks for the extension (`describe("{extension title}")`, or
  `describe.each(…)("{extension title} (%s)")`, plus `"{extension title}: {query} (%s)"` for each query its
  specs run) with a test per specification across them
- **query-additive** — while a slice with `addQueries` in slice.json is InProgress: only that slice's
  `readModel.ts` and tests change; `readModel.ts` gains lines only inside `queries` (the previous last entry's
  `}` may be re-added as `},`) and declares every added name; `route.tests.ts` gets a
  `describe.each(queryTypes(…))("{slice title}: {query} (%s)")` block per added query with a test per
  specification that runs it, and keeps every existing line except the `readModels.js` import gaining `queryTypes`
- **retype-scope** — while a retype slice (`retype` in slice.json) is InProgress: a commit that touches the
  `type:` line changes only that line of the slice's `readModel.ts`, to `retype.to`. No test, route or other
  slice edits, because the existing contract tests are the proof that clients see the same data. With
  `addQueries` too, the queries follow as their own commit, which query-additive checks.
- **test-file-present** — a changed `decider.ts`, `projection.ts`, `readModel.ts`, or `processor.ts` needs a sibling `*.tests.ts`
- **no-invented-fields** — heuristic: flags a field used in code that isn't declared anywhere in
  `.build-kit/.slices/{context}/{slice}/slice.json`
- **spec-coverage** — heuristic: each `*.tests.ts` file needs at least as many `test(...)` blocks as
  slice.json has `specifications[]` entries (applies to both `route.tests.ts` and `route.integration.tests.ts`)
- **tsc-build** — `npx tsc --noEmit` must still pass
- **slice-tests** — the tests of every slice folder the commit touches must pass (for an extension, that is
  the origin's full test file, earlier scenarios included)

The hook lives in `.githooks/`, added by `eventmodelers init --hooks` (or `eventmodelers init-hooks` later); `npm install`'s
`prepare` then keeps `core.hooksPath` pointing at it (and leaves it alone when `.githooks/` is absent). It only acts on commits
that touch a slice folder, so model, docs and `index.ts` wiring commits pass straight through.

## Branching

The loop never creates, switches or merges branches. It builds on whatever branch is checked out.
Branching belongs to the developer. The recommended flow is one branch per model increment:
`git switch -c increment/<name>` before exporting the increment, let the loop build its slices there, then
open a PR into the main branch and merge it before starting the next increment. Extension slices need their
origin's code, which the previous merged increment provides.

Run `npm run run:checks` any time you want to check your current work. Pass `-- --staged` to match the pre-commit hook.

## Example Slice Structure

```
src/contexts/
└── {context}/
    ├── Events.ts
    └── slices/
        └── {slice-name}/
            ├── readModel.ts        (read slices: one definition, any read model type)
            ├── command.ts
            ├── decisionModels.ts
            ├── decider.ts
            ├── schema.ts
            ├── route.ts
            ├── route.tests.ts
            └── route.integration.tests.ts
```
