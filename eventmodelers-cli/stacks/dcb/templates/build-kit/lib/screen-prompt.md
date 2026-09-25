# Ralph Agent Instructions: the UI

You are an autonomous coding agent building a slice's **UI**: its screen, in `web/` (React), from the mockup in its slice.json. The slice's backend is already built and committed. That was a separate job; don't touch `src/`, and don't rebuild it.

The loop has chosen the job: **"Your task" above names the slice.** Build exactly that, one job per run.

## Context Boundary (READ FIRST — NON-NEGOTIABLE)

- **ONLY** read slices inside `.build-kit/.slices/<currentContext>/` (the context in "Your task").
- Work only in `web/src/slices/<slicename>/`, the pages its screen is on (`web/src/pages/`) and the generated `web/src/lib/api-types.ts`. Nothing else in `web/`, and nothing outside it.

## Your Task

0. Do not read the entire codebase. Focus on the slice and `web/`.
1. Your memory is above, under "What the loop remembers": the shared and UI lessons, any open notes on this job, and what the slice's backend job recorded in its commit (status codes, messages, when a read answers 404). Don't read `progress.txt`, `.build-kit/AGENTS.md` or the other learnings files.
2. Stay on the branch you are on — do not create or switch branches.
3. Read the slice definition from `.build-kit/.slices/<contextName>/<folder>/slice.json` (the folder is the slice's `folder` in `index.json`). Its `screens[]` with a `mockup` are your job. `buildScreen` tells you why the job is here: `"added"` (a first UI for a slice built without one) or `"changed"` (rebuild its UI to the new mockup). Without it, it's the slice's first build.
4. Invoke `/build-screen` and follow it **completely**. It regenerates the API types from the code (`npm run gen:api`: no database or running backend), builds a form per submitted command and a view per displayed read model from the mockup 1:1, mock handlers and tests from the scenarios, and puts them on the page.
5. Verify against slice.json: every field, value and message comes from it; every API path is one of its `apiEndpoint`s.
6. Stage and run the commit checks: `npm run run:checks -- --staged`. The pre-commit hook runs the same checks (`blocked-paths`, `web-scope`, `web-tests`). **Never commit over a failing check**, and never use `--no-verify`. Fix the code, or if a check itself is wrong, block the job (below) with the check output and stop. Then commit: `feat: [Slice Name] screen`, with a body ("Commit body" below): the commit is the record of this job.
7. Set `concerns.ui.status` to `"Done"` in `index.json`. The loop derives the slice's `status` from its concerns; don't set it yourself.
8. Lessons: add what a later UI job in this project should know to `.build-kit/learnings/ui.md` (or `learnings/shared.md` if the backend needs it too), following "Lessons" below. Most jobs add none or one.
9. Finish the iteration. Don't write to `progress.txt` unless you block the job.

**Blocking the job** (step 6, or when the screen can't be built without a change outside its scope, such as a missing component or library): in `index.json`, set `concerns.ui` to `{ "status": "Blocked", "blockedReason": "<the check output or the question, in short>", "blockedAt": "<now, ISO 8601>" }`, and add a journal entry to `progress.txt` ("Journal entry" below). The backend stays as built, and other slices go on; the model fixes the mockup and plans the slice again, and only the UI is rebuilt.

## Commit body

Completed work is recorded in git, not in `progress.txt` (ADR-028). The screen commit's body says, in short lines:

```
feat: [rate course] screen

Built: RateCourseForm on the Course Page (/courses/:courseId): a 1–5 select, Rate; courseId from the route,
  studentId from the session (first build | buildScreen: added | changed)
Tests: one per spec the screen can produce, plus the page flow; 14 web tests passing
Mockup: anything built differently from the mockup, and why (or "1:1")
```

## Journal entry (only when you block the job)

APPEND to `progress.txt` (never replace), tagged with the job, so the loop removes it once the job is Done:

```
## <now, ISO 8601> — Blocked: <Slice> (UI) [slice:<slice id> concern:ui]

- What was tried
- What's needed to unblock it (usually a mockup change)
---
```

## Lessons

`.build-kit/learnings/ui.md` holds what later UI jobs in **this project** should know. Keep it accurate and short:

- Only what is specific to this project and not obvious from the code, and never what `build-screen` already says.
- One lesson per bullet, with the project's example (`CourseRatingsView`, `.mock-card`).
- No status or environment lines.
- If a lesson is wrong or out of date, correct or delete it. Never add one that contradicts another.
- Over 40 lessons (your memory says so): merge or drop lessons before adding one.

## Stop Condition

After the one job in "Your task" (Done or Blocked), always stop. Reply with:
<promise>DONE</promise>
