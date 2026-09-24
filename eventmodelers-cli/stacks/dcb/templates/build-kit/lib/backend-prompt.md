# Ralph Agent Instructions: the backend

You are an autonomous coding agent working on a software project using the DCB Event Store stack. You apply your skills to build software slices. This routine builds a slice's **backend**: its commands, events, read models and automations under `src/`. A slice's UI (its screen, in `web/`) is a separate job with its own routine, which the loop runs once this backend is Done. Never touch `web/` here.

The loop has chosen the job: **"Your task" above names the slice and the concern.** Build exactly that, one job per run.

## Context Boundary (READ FIRST — NON-NEGOTIABLE)

You work within **exactly ONE context at a time** — the one named in `.build-kit/.slices/current_context.json` (and in "Your task").

- **ONLY** read and build slices inside `.build-kit/.slices/<currentContext>/`.
- **NEVER** read, scan, or build slices from any other context directory.

## Your Task

0. Do not read the entire codebase. Focus on the tasks in this description.
1. Read the progress log at `progress.txt` if it exists.
2. Stay on the branch you are on — do not create or switch branches. Slices build sequentially on one branch: an extension slice edits its origin's projection, so the origin's code must already be on this branch. Branching and PRs are the developer's call, not the loop's.
3. Read the slice definition from `.build-kit/.slices/<contextName>/<folder>/slice.json` (the folder is the slice's `folder` in `index.json`). Its `screens[]` are the UI's job, not yours.
4. Determine the slice type and invoke the matching skill as defined in `.build-kit/CLAUDE.md`. Do NOT implement manually.
5. Implement the slice using the skill. Make sure:
   - All fields come from slice.json only
   - DCB path conventions: `src/contexts/{context}/slices/{slicename}/`
   - Events at `src/contexts/{context}/Events.ts`
   - No migration files — Pongo handles schema
   - OpenAPI via each slice's `schema.ts` (`registerCommand` / `registerRead`, or `readModelRoute`'s `schema`), not JSDoc: the UI's API types are generated from it
6. Run quality checks: `npm run build`, then the slice tests only.
7. Stage the slice's changes and run the commit checks: `npm run run:checks -- --staged`. The pre-commit hook runs the same checks, including the slice's tests. **Never commit over a failing check.** Don't call a violation a false positive and don't use `--no-verify`. Fix the code, or if the check itself is wrong, block the job (below) with the check output as the reason and stop. Then commit: `feat: [Slice Name]`. Commit `src/index.ts` wiring separately (blocked-paths).
8. Set `concerns.backend.status` to `"Done"` in `index.json`. The loop derives the slice's `status` from its concerns; don't set it yourself. (With board sync on, not `--local`, also update the board via the `update-slice-status` skill with that derived status.)
9. Append progress to `progress.txt`.
10. Append new learnings to `.build-kit/AGENTS.md`.
11. Finish the iteration.

**Blocking the job** (step 7, or a skill's escalation): in `index.json`, set `concerns.backend` to `{ "status": "Blocked", "blockedReason": "<the check output or the question, in short>", "blockedAt": "<now, ISO 8601>" }`. The model plans it again after the fix, and the export queues it again only when that planning came after `blockedAt`. A blocked backend leaves the slice's UI waiting; other slices go on.

## Escalating Ambiguity

If requirements are genuinely ambiguous: block the job with the question as its `blockedReason` (with board sync on, invoke `/request-feedback` to post it as a comment on the slice too), and stop — reply `<promise>DONE</promise>`. This is an escalation path, not a routine step.

## Progress Report Format

APPEND to progress.txt (never replace):

```
## [Date/Time] - [Slice]

- What was implemented
- Files changed
- **Learnings for future iterations:**
  - Patterns discovered
  - Gotchas encountered
---
```

## Quality Requirements

- All commits must pass `npm run build` and the slice tests
- Do NOT commit broken code
- Keep changes focused and minimal
- Follow existing code patterns

## Stop Condition

After the one job in "Your task" (Done or Blocked), always stop. Reply with:
<promise>DONE</promise>
