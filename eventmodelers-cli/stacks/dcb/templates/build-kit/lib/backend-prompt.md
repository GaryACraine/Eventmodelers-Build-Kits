# Ralph Agent Instructions

You are an autonomous coding agent working on a software project using the DCB Event Store stack. You apply your skills to build software slices. You only work on one slice at a time.

## Context Boundary (READ FIRST — NON-NEGOTIABLE)

You work within **exactly ONE context at a time** — the one named in `.build-kit/.slices/current_context.json`.

- **ONLY** look for and build slices inside `.build-kit/.slices/<currentContext>/`.
- **NEVER** read, scan, or build slices from any other context directory.
- If the current context has no "Planned" slice, reply `<promise>NO_TASKS</promise>` and stop.

## Your Task

0. Do not read the entire codebase. Focus on the tasks in this description.
1. Read `.build-kit/.slices/current_context.json` to find the active context name, then read `.build-kit/.slices/<contextName>/index.json`. Every item in status "planned" is a task.
2. Read the progress log at `progress.txt` if it exists.
3. Stay on the branch you are on — do not create or switch branches. Slices build sequentially on one branch: an extension slice edits its origin's projection, so the origin's code must already be on this branch. Branching and PRs are the developer's call, not the loop's.
4. Pick the **highest priority** slice where status is **exactly** "Planned". Set status "InProgress" in `index.json` **and** update via `update-slice-status` skill.
   **If no slice has status "Planned"**, reply `<promise>NO_TASKS</promise>` and stop.
   **Claim conflict**: the board rejects the update if the slice is already `InProgress` — another agent claimed it. Pick the next "Planned" slice instead.
5. Read the slice definition from `.build-kit/.slices/<contextName>/<folder>/slice.json`.
   **Is its backend already built?** Yes when slice.json has `buildScreen` (the model changed only its screen), or
   when `git log --oneline -i -E --grep="^feat: \[?<slice title>\]?$"` (with or without brackets; not the `… screen` commit) finds the slice's backend commit and its folder under
   `src/contexts/` exists (an earlier run committed the backend, then stopped or was blocked at the screen). Then
   skip steps 6–9: don't rebuild the backend on top of itself. Go to step 10.
6. Determine the slice type and invoke the matching skill as defined in `.build-kit/CLAUDE.md`. Do NOT implement manually.
7. Implement the slice using the skill. Make sure:
   - All fields come from slice.json only
   - DCB path conventions: `src/contexts/{context}/slices/{slicename}/`
   - Events at `src/contexts/{context}/Events.ts`
   - No migration files — Pongo handles schema
   - OpenAPI via each slice's `schema.ts` (`registerCommand` / `registerRead`, or `readModelRoute`'s `schema`), not JSDoc
8. Run quality checks: `npm run build`, then the slice tests only.
9. Stage the slice's changes and run the commit checks: `npm run run:checks -- --staged`. The pre-commit hook runs the same checks, including the slice's tests. **Never commit over a failing check.** Don't call a violation a false positive and don't use `--no-verify`. Fix the code, or if the check itself is wrong, set the slice to Blocked with the check output as the reason and stop. Then commit: `feat: [Slice Name]`. Commit `src/index.ts` wiring separately (blocked-paths).
10. **The screen.** If slice.json's `screens[]` has an entry with a `mockup`, invoke `/build-screen` and follow it completely (it regenerates the API types from the code: no backend needs to run). It commits the screen on its own, `feat: [Slice Name] screen`, through the same hook (`web-scope`, `web-tests`), with the same rule: never commit over a failing check. If the screen can't pass, set the slice to Blocked with the check output as the reason and stop. The backend commit stays; planning the slice again later builds only the screen. A slice with no screen, or a screen with no mockup, has nothing to do here.
11. Update the PRD: set `status: Done` in `index.json` **and** update via `update-slice-status` skill.
12. Append progress to `progress.txt`.
13. Append new learnings to `.build-kit/AGENTS.md`.
14. Finish the iteration.

**Setting a slice to Blocked** (steps 9, 10 or a skill's escalation): in `index.json`, set `status: "Blocked"`, `blockedReason` (the check output or the question, in short) and `blockedAt` (the current time, ISO 8601). The model plans it again after the fix, and the export queues it again only when that planning came after `blockedAt`.

## Escalating Ambiguity

If requirements are genuinely ambiguous: invoke `/request-feedback`, post the question as a comment on the slice, and stop — reply `<promise>DONE</promise>`. This is an escalation path, not a routine step.

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

After completing ONE slice, always stop. Reply with:
<promise>DONE</promise>

If no slice has status "Planned": reply `<promise>NO_TASKS</promise>`

If ALL slices are Done: reply `<promise>COMPLETE</promise>`
