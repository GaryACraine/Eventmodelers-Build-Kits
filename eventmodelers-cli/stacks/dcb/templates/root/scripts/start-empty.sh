#!/usr/bin/env bash
# Start from an empty `enrollment` context instead of the bundled reference app.
#
# The scaffold ships a complete worked example (10 slices, seed data, scenario tests).
# Building your own model from scratch starts from nothing: this removes the example
# slices, keeps the generic event feed, and resets Events.ts and src/index.ts to empty
# wiring (a `projections` array, ensureProjectionsCurrent, no routes but the event feed).
set -euo pipefail
cd "$(dirname "$0")/.."

slices=src/contexts/enrollment/slices
for dir in "$slices"/*/; do
  name=$(basename "$dir")
  [ "$name" = "event-feed" ] || rm -rf "$dir"
done
rm -f src/scenario.tests.ts src/seed.ts
cp scripts/empty/Events.ts src/contexts/enrollment/Events.ts
cp scripts/empty/index.ts src/index.ts
echo "Empty enrollment context ready: $(ls "$slices" | tr '\n' ' ')"
