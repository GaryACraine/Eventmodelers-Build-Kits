# Project Configuration

Read `src/contexts/` to understand the global structure. Events for each context live at `src/contexts/{context}/Events.ts`.

## File Structure Constraints

- **Strict Path Limitation**: if not instructed otherwise, only check `src/contexts/{context}/slices/{slicename}/*.ts`
- **Slice Organisation**: Each feature/domain is a separate slice under its context

## Code Standards

- **Language**: TypeScript only
- **Module System**: Use ES modules (import/export) with `.js` extensions in imports
- **Type Safety**: Ensure all code is properly typed

## Frontend (`web/`)

`web/` is the project's React app: Vite, React 19, TypeScript, Tailwind CSS v4 + shadcn/ui, React Router,
TanStack Query, React Hook Form + Zod, openapi-fetch (types generated from `/openapi.json`), Vitest + Testing
Library + MSW. See `web/README.md`.

- Backend slice work never touches `web/`. Only a slice's UI step does: `/build-screen`, when slice.json has a
  `screens[]` entry with a `mockup`, after the backend is committed (the loop runs it; see "Building a Slice").
  It builds `web/src/slices/{slicename}/` and the page the screen is on (`web/src/pages/`), and commits it on its own.
  A screen with no mockup isn't built: the model adds the mockup later, and the export queues the screen then.
- The UI calls the backend only through `web/src/lib/api.ts`, on slice.json's `apiEndpoint` paths.
  `web/src/lib/api-types.ts` is regenerated (`npm run gen:api`), never edited.
- A page's URL is slice.json's `screens[].page.route` (entity-shaped, for people). It is never an API path, and
  never the other way round.
- Read-your-writes (`afterLastWrite()`) is only for **async** (`database-projected`) read models. Inline and
  live ones are current when the command returns.
- A `session:` field comes from `useSession()` (a stub signed-in user), never from a form input or the URL.
- Mock data comes from the slice's scenario examples, never invented.

## Development Guidelines

1. Each slice is self-contained under `src/contexts/{context}/slices/{slicename}/`
2. Shared events live at `src/contexts/{context}/Events.ts` — add to it, never rewrite
3. No migration files — Pongo creates JSONB collections via `projection.init()`
4. OpenAPI is programmatic: each slice documents its routes (`registerCommand` / `registerRead` in its
   `schema.ts`, or `readModelRoute`'s `schema`) through `src/shared/openapi.ts`, and the `openapi` slice serves
   them all at `/openapi.json`. The frontend's client is generated from it, so every route must be there
5. Routes are slice.json's `apiEndpoint`, named after the model (ADR-025): a command is `POST /<command>` with
   every field in the body, a read model `GET /<read-model>/:<id>`, a query `GET /<read-model>/<query>?…`.
   Never design a REST path, nest one under an entity, or use PUT/PATCH/DELETE

Only check `src/contexts/{context}/slices/{slicename}/*.ts`, do not check subfolders, unless explicitly tasked to build the UI.

Ignore case for contexts and slices in prompts.

Do not change files with tests unless explicitly instructed, or the change brings the test in line with slice.json: `*.tests.ts`. An extension slice appending its own `describe` block to its origin's `route.tests.ts` is explicitly instructed (build-state-view, E4), and so is a slice with `addQueries` appending one query block per added query (A5); existing tests there stay untouched. A screen's own `web/src/slices/{slicename}/*.test.tsx` are `build-screen`'s output: a `buildScreen: "changed"` rebuild updates them to the new mockup.

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
   - **Screen only** — slice.json has `buildScreen` (`"added"` or `"changed"`): the model added or changed the
     screen of a slice that is already built. Skip the backend entirely → invoke `/build-screen` (its "A screen
     added or changed" section). So does a slice whose backend commit (`feat: [Slice Name]`) is already in
     `git log`: an earlier run stopped or was blocked at the screen.
3. Invoke the matching skill and follow its instructions completely. Do not deviate.
4. **Verify against slice.json**: After the skill completes, diff slice.json against the code field by field. No invented fields — if it is not in slice.json, it must not be in the code.
5. Run quality checks (`npm run build`, then the slice tests only).
6. If checks pass, commit with `feat: [Slice Name]`.
7. **Screen** — if slice.json's `screens[]` has an entry with a `mockup`, invoke `/build-screen`: it builds the
   slice's UI and commits it on its own (`feat: [Slice Name] screen`).
8. Set slice status to `Done`. When blocked instead, record `blockedReason` and `blockedAt` with the status.

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
- **openapi-registered** — every `router.get/post/put/patch/delete("<path>")` in a slice's `route.ts` has a
  `registerCommand` / `registerRead` with the same method and path in its `schema.ts`, and `route.ts` imports
  `./schema.js`; every `readModelRoute(…)` passes `schema:` (it documents the keyed GET and the queries itself)
- **tsc-build** — `npx tsc --noEmit` must still pass
- **slice-tests** — the tests of every slice folder the commit touches must pass (for an extension, that is
  the origin's full test file, earlier scenarios included)

A commit that touches `web/src/slices/{slicename}/` (a screen, from `build-screen`) gets its own checks instead,
plus blocked-paths (which also covers `web/package.json` and its lockfile):

- **web-scope** — everything staged is in that one slice's `web/src/slices/{slicename}/`, a page in
  `web/src/pages/*.tsx`, or the regenerated `web/src/lib/api-types.ts`; no backend file, nothing else in `web/`;
  and the slice's folder has a `*.test.tsx`
- **web-tests** — `web/` typechecks (`tsc -b`) and the slice's and the pages' tests pass (MSW, no backend)

The hook lives in `.githooks/`, added by `eventmodelers init --hooks` (or `eventmodelers init-hooks` later); `npm install`'s
`prepare` then keeps `core.hooksPath` pointing at it (and leaves it alone when `.githooks/` is absent). It only acts on commits
that touch a slice folder (backend or `web/`), so model, docs and `index.ts` wiring commits pass straight through.

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
