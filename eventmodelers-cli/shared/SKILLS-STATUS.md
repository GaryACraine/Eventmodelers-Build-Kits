# Shared skills (eventmodelers platform): status in this fork

`eventmodelers init` copies `shared/skills/*` into every build-kit project's `.claude/skills/`.

In this fork the eventmodelers board is retired: models live in `workspace.json` (emcli) and the loop runs with
`eventmodelers run --local`. These skills still talk to the eventmodelers API, yet the build kit's agent
instructions (`stacks/*/templates/build-kit/CLAUDE.md`, `lib/AGENT.md`) still invoke some of them:

| Skill | Still referenced by the loop? | In `--local` mode |
|---|---|---|
| `update-slice-status` | yes: "invoke with `InProgress` before doing anything else" | a wasted step; the loop tracks statuses in `.build-kit/.slices` itself |
| `request-feedback` | yes: the build skills' escalation to `Blocked` | the comment can't reach a board; only the local `index.json` status change matters |
| `connect`, `load-slice` | via `lib/AGENT.md` | not needed: `slice.json` is already on disk |
| `learn-eventmodelers-api` | no | unused |

So they are **not** deprecated yet. Giving the loop local-mode equivalents (status and feedback written to
`.build-kit/.slices`, surfaced by `emcli workspace import-status`) is a follow-up: PLAN 13.5b.
