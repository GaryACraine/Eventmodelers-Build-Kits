## v1.0.56

### Features
- `run --standalone` no longer needs a modeling kit installed in the current directory. With none there, it falls back to a single global install under `~/.eventmodelers/kit`, initialized on first use and refreshed when the CLI version changes — so `npx @eventmodelers/cli run --standalone --board-id <uuid>` works from anywhere and writes nothing into the directory it was started from. `--global` selects that install explicitly even when a local kit exists.
- `--standalone` now implies `--modeling` — it already refused every other runner, so requiring both flags only made the shorter command fail.
- `run` accepts `--token`/`--board-id`/`--organization-id`/`--base-url`, the same credential flags `init` and `init-config` take, so credentials can be given per agent run rather than per directory. They're stored per board in `~/.eventmodelers/boards/<board>.json` (`0600`) together with a stable agent id, so later runs for the same board need only `--board-id`. One machine can drive several boards across several accounts at once.
- The first run for a board asks once whether it should have credentials of its own or use the account-wide ones, and remembers the answer — either the credentials or a `useGlobal` marker is written to `~/.eventmodelers/boards/<board>.json`. The question is skipped when credentials are given on the command line, under `--print`, or when stdin is not interactive, so CI and process supervisors never block on it.
- `init-config --credentials "token=...,boardId=...,organizationId=...,baseUrl=..."` configures a single board non-interactively from the blob app.eventmodelers.ai/account hands out. The equivalent JSON works too, and `-` reads either from stdin so a token need not appear in shell history or `ps`. `run --credentials` takes the same value, for configuring and starting in one command.

### Fixes
- `init --modeling` no longer runs `npm install` in the kit dir — modeling-kit's `package.json` declares no dependencies and exists only for its `"type": "module"`.

## v0.0.38

### Features
- Added a `release-notes` command to print the CLI's release notes (what changed across recent versions) without needing a connected project or credentials.