# Agent Learnings

Patterns and gotchas discovered during task processing. Update this file whenever you encounter something reusable.

## tasks.json

- Tasks are objects with `id`, `createdAt`, and `payload` (a `SliceChangedPayload`).
- After completing a task, remove it from the array entirely — do not add a status field.
- Write `[]` to `tasks.json` if the last task is completed.

## SliceChangedPayload fields

```
event           always "slice:changed"
organizationId  org UUID or null
boardId         board UUID
sliceId         SLICE_BORDER node UUID — use this with /load-slice
sliceTitle      human-readable slice name (may be null)
sliceStatus     e.g. "Created", "InProgress", "Done", "Blocked" (may be null)
timestamp       unix ms when the change was emitted
```

## Slice files

The realtime agent writes one file per slice:

```
.slices/<context>/<sliceName>.json
```

These are always up to date — read them directly before invoking any skill.

## DCB-specific conventions

- Source files are at `src/contexts/{context}/slices/{slicename}/` (not `src/slices/`)
- Shared events live at `src/contexts/{context}/Events.ts`
- No migration files — Pongo creates JSONB collections automatically via `projection.init()`
- No Flyway, no Knex — use Pongo for read model persistence
- OpenAPI is programmatic via Zod, not JSDoc `@openapi` annotations: each slice's `schema.ts` registers its routes
  (`registerCommand` / `registerRead` from `src/shared/openapi.ts`); `readModelRoute` documents a read model from
  its required `schema`. `/openapi.json` is what the frontend generates its client from
- Test files are named `*.tests.ts` (plural), not `*.test.ts`
- Test blocks use `test(...)` (vitest), not `it(...)`
- Integration tests use `getTestPgDatabasePool` + testcontainers — requires Docker

## Skill Usage

- Always run `/connect` first to load credentials from `.eventmodelers/config.json`
- `/load-slice sliceId=<uuid>` re-fetches all slices and returns the requested slice
- Read `.slices/<context>/<sliceName>.json` directly when the file is recent enough

## Board API

- Node events POST to `/api/org/:orgId/boards/:boardId/nodes/events`
- `/update-slice-status` rejects moving a slice into a status it's already in — treat as `ALREADY_IN_STATUS`, skip and move on

## DCB decider pattern

- `decider()` takes a `handlers` factory (returns decision model instances) and a `decide` function
- State keys in `handlers` must match the state properties used in `decide()`
- `TaggedEvent` returned by event factories carries both the event and its `Tags.fromObj(...)` scope
- `handle(store, decider, command, { idempotencyKey })` replaces stream-based CommandHandler

## Pongo projection pattern

- `pongoProjection({ name, canHandle, init, handle, truncate })`
- `init` creates collections; `handle` processes batches; `truncate` clears collections for reset
- `waitUntilProcessed(pool, projectionName, position, { timeoutMs })` blocks until the projection catches up
- `_handler_bookmarks` table tracks the last processed position per projection
- `preferWait({ waitFn })` must be registered BEFORE the actual GET handler for read-your-writes to work
