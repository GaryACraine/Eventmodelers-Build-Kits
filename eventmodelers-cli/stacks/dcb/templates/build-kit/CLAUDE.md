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

Do not change files with tests unless explicitly instructed, or the change brings the test in line with slice.json: `*.tests.ts`

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
   - **State-view** — `projections` or `queries` array is non-empty → invoke `/build-state-view`
   - **State-change** — default (has `commands` / `events`) → invoke `/build-state-change`
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
- **test-file-present** — a changed `decider.ts`, `projection.ts`, or `processor.ts` needs a sibling `*.tests.ts`
- **no-invented-fields** — heuristic: flags a field used in code that isn't declared anywhere in
  `.build-kit/.slices/{context}/{slice}/slice.json`
- **spec-coverage** — heuristic: the test file needs at least as many `test(...)` blocks as slice.json
  has `specifications[]` entries
- **tsc-build** — `npx tsc --noEmit` must still pass

Run `npm run run:checks` any time you want to check your current work. Pass `-- --staged` to match the pre-commit hook.

## Example Slice Structure

```
src/contexts/
└── {context}/
    ├── Events.ts
    └── slices/
        └── {slice-name}/
            ├── command.ts
            ├── decisionModels.ts
            ├── decider.ts
            ├── schema.ts
            ├── route.ts
            └── route.tests.ts
```
