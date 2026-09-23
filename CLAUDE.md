# Working on this repo

This is a fork of the eventmodelers build kits, extended with a **DCB build kit** (`eventmodelers-cli/stacks/dcb`)
and a user manual (`docs/USER-MANUAL.md`) that builds a DCB service slice by slice with the Ralph loop. Models are
edited with **emcli** (`~/Projects/emcli`, a separate repo) and rendered on **prooph board**. The eventmodelers
board/platform is retired in this fork: don't call its API or MCP tools.

## Where things are

| Path | What |
|---|---|
| `PLAN.md` | the living plan: phases, tasks, findings, Decisions Log. Read the top phase before starting work. |
| `docs/USER-MANUAL.md` | the manual (verified by replaying it in `~/Projects/course-enrollment`) |
| `eventmodelers-cli/stacks/dcb/` | the DCB kit: scaffold (`templates/root`), build skills (`templates/.claude/skills/build-*`), loop config (`templates/build-kit`) |
| `eventmodelers-cli/shared/` | files every kit installs (see `shared/SKILLS-STATUS.md`) |
| `eventmodelers-cli/stacks/modeling-kit/` | deprecated here (see its README) |
| `~/Projects/emcli` | the model editor and its `model` skill; its own repo, merged locally with `--no-ff` |
| `~/Projects/dcb-event-store` | the DCB event store library the scaffold links with `file:` |

## Rules

- **Git flow here:** branch → commit → push → `gh pr create` → `gh pr merge --merge --delete-branch` →
  `git checkout main && git pull`. emcli has no remote: branch, commit, `git merge --no-ff`, delete the branch.
- **The Ralph loop is run by the user**, in their own terminal (`eventmodelers run --local`). Never start it or
  spawn `claude -p`.
- **Never commit, export or edit files in a project while its loop is building** (the loop shares the working
  tree). Wait for its log to say *waiting*.
- **Model through emcli only** (the `model` skill in emcli), never through board MCP tools.
- Kit changes are proven in a real project before they're called done; record results in `PLAN.md`.
- Record decisions in `PLAN.md`'s Decisions Log with the reason, and tick tasks as they land.
