#!/usr/bin/env bash
# Start from an empty `enrollment` context instead of the bundled reference app.
#
# The scaffold ships a complete worked example (10 slices, seed data, scenario tests).
# Building your own model from scratch starts from nothing: this removes the example
# slices, keeps the generic event feed and the OpenAPI document (/openapi.json, filled by each
# slice as it's built), and resets Events.ts and src/index.ts to empty wiring (`readModels` and
# `imperative` arrays started by startReadModels, CORS, and no routes but those two).
set -euo pipefail
cd "$(dirname "$0")/.."

slices=src/contexts/enrollment/slices
for dir in "$slices"/*/; do
  name=$(basename "$dir")
  case "$name" in event-feed|openapi) ;; *) rm -rf "$dir" ;; esac
done
rm -f src/scenario.tests.ts src/seed.ts
cp scripts/empty/Events.ts src/contexts/enrollment/Events.ts
cp scripts/empty/index.ts src/index.ts
echo "Empty enrollment context ready: $(ls "$slices" | tr '\n' ' ')"
