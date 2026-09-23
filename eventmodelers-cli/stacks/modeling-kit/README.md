# modeling-kit — deprecated in this fork

> **Deprecated (2026-09-23, PLAN Phase 13).** In this fork, modeling happens in a local `workspace.json` edited
> with [emcli](../../../../emcli) and rendered on prooph board. The eventmodelers board this kit writes to is
> retired here. Use emcli's **`event-model`** skill instead: link it into a project with `emcli skills link`, then
> describe the process to Claude Code. Kept, not deleted, until that skill has been used on a real project
> (PLAN 13.6).

What moved where:

| This kit | Now |
|---|---|
| `timeline` (live event storming) | `emcli/skills/event-model` storm mode (`references/storming.md`) |
| `eventmodeling-core-rules` | `references/method.md` |
| `eventmodeling-brainstorming-events`, `-plotting-events`, `-interview-protocol` | `references/storming.md` |
| `eventmodeling-identifying-inputs`, `-identifying-outputs`, `-storyboarding-events`, `-designing-automation-chains`, `-translating-external-events`, `-slicing-event-models` | `references/slicing.md` |
| `eventmodeling-elaborating-scenarios`, `examples`, `attributes` | `references/detail.md` |
| `eventmodeling-checking-completeness`, `-validating-event-models(-checklist)`, `wdyt`, `analyze-existing-model` | `references/review.md` |
| worked examples (`references/examples.md` etc.) | `references/examples/` (API-free ones, copied) |
| `place-element`, `storyboard*`, `html-screen`, `handle-comment`, `update-prompt-status`, `add-next-slice`, `discover-storyboard` | not ported: eventmodelers board mechanics; emcli commands replace them |
| the `tasks.json` agent loop (was this repo's root `CLAUDE.md`) | `REPO-CLAUDE-LOOP.md` here, for reference; no replacement (modeling is conversational now) |
