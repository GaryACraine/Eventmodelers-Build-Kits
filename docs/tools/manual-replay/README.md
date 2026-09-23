# Manual replay

Checks that the manual's modeling commands (§5–§12, with `docs/examples/t3.sh` and `t4.sh` inlined where §9 runs
them) still build the intended model, without a board, a database or the loop.

```bash
cd "$(mktemp -d)"
python3 ~/Projects/Eventmodelers-Build-Kits/docs/tools/manual-replay/extract.py \
  ~/Projects/Eventmodelers-Build-Kits/docs/USER-MANUAL.md replay.sh
emcli workspace init "Course Enrollment" --no-skills
EMCLI=$(command -v emcli) bash replay.sh > replay.log 2>&1
grep -in "usage\|matches\|no chapter" replay.log          # expect nothing
python3 ~/Projects/Eventmodelers-Build-Kits/docs/tools/manual-replay/normalize.py workspace.json model.json
```

`normalize.py` writes the model keyed by names (IDs replaced by `slice/type/name`), so two replays, before and
after a manual edit, can be compared with `diff`. git, curl, npm, `sync`, `export` and `import-status` lines are
skipped: they need the board, the app or the loop.
