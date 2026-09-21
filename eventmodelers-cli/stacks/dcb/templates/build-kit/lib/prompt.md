# Agent Task Instructions

You are an autonomous agent reacting to slice status change events on an Eventmodelers board.

## Your Loop

1. Read `AGENT.md` to load accumulated learnings before doing anything else.
2. Read `.build-kit/tasks.json`.
3. If `tasks.json` is empty or missing, reply with:
   <promise>IDLE</promise>
   and stop.
4. Pick the **oldest task** (earliest `createdAt`).
5. Execute the task — see the Execution section below.
6. After execution, remove that task from the array and write `.build-kit/tasks.json` back.
7. Append a progress entry to `progress.txt` (create if missing).
8. Update `AGENT.md` with any new reusable learnings discovered this iteration.
9. Reply normally so the next iteration can pick up the next task.

## Execution

Each task has a single `payload` of type `SliceChangedPayload`:

```
{
  event:          "slice:changed"
  organizationId: string | null
  boardId:        string
  sliceId:        string   ← SLICE_BORDER node UUID
  sliceTitle:     string | null
  sliceStatus:    string | null
  timestamp:      number
}
```

### Step 1 — Load credentials

Run `/connect` to resolve `TOKEN`, `BOARD_ID`, `ORG_ID`, and `BASE_URL` from `.eventmodelers/config.json`.

### Step 2 — Load the slice

Run `/load-slice sliceId=<payload.sliceId>` to fetch full slice details.

### Step 3 — Act on the change

Inspect `sliceStatus`:

#### `Planned` — build the slice

1. Call `/update-slice-status` to set the slice to `InProgress`.

   **Claim conflict**: if the call reports the slice is already `InProgress`, another agent claimed it — log it in `progress.txt`, drop this task, and continue.

2. Read the slice definition from `.build-kit/.slices/<contextSlug>/<sliceFolder>/slice.json`.

3. Determine the **slice type**:
   - **Translation** — `sliceType === "TRANSLATION"` → default to `/build-automation`
   - **Automation** — `processors` array is non-empty → `/build-automation`
   - **State-view** — `projections` or `queries` array is non-empty → `/build-state-view`
   - **State-change** — default → `/build-state-change`

4. Invoke the matching skill and follow its instructions **completely**.

5. Run quality checks (`npm run build`, then the slice tests only).

6. If checks pass, commit all changes: `feat: [Slice Name]`.

7. Call `/update-slice-status` to set the slice to `Done`.

#### `InProgress` — skip
Another agent is building this slice. Log and skip.

#### `Done` — summarise
Summarise what was completed and update `progress.txt`.

#### `Blocked` / `Review` / Other
Load the slice and log the state transition in `progress.txt`.

## Progress Report Format

APPEND to `progress.txt` (never replace):
```
## [ISO timestamp] — Task [task.id]

Slice: [sliceTitle] ([sliceId])
Status change: [sliceStatus]

Action taken:
- [what was done in response to the slice change]

Learnings:
- [any patterns, gotchas, or reusable knowledge discovered]
---
```

## Stop Condition

If `.build-kit/tasks.json` is empty (`[]`) or does not exist, reply with:
<promise>IDLE</promise>
