'use strict';

// Everything staged in a DCB slice commit must be inside the slice's own folder,
// or one of the documented shared-infra exceptions a slice legitimately modifies.
//
// DCB path structure: src/contexts/{context}/slices/{slicename}/
// Exceptions:
//   - src/contexts/{context}/Events.ts  (shared event union — append-only)
//   - src/index.ts                      (bootstrap — projection/route/automation wiring)
//   - src/workflows.ts                  (the Temporal worker's workflows — append-only, ADR-033)
//   - mocks/{system}/**                 (an external system's container mock, built with its automation — ADR-033)
//   - src/providers/{system}/**         (an external system's code shared by the slices that use it: its provider
//                                        skill's module, created by the first slice that needs it — ADR-045)
//   - docker-compose.yml                (a mock's service)
//
// And one exception for another slice: a **rebuild** that renames an element (slice.json's `rebuild.changes` lists
// "<old>: removed" and "<new>: new", e.g. assignRole → assignOwnerRole, ADR-046) may update the slices that use it,
// as long as each of their changed lines is an old line with the old name replaced by the new one. Anything else in
// another slice is still refused.

const ALLOWED_EXCEPTIONS = [
  /^src\/contexts\/[^/]+\/Events\.ts$/,   // per-context event union (append-only)
  /^src\/index\.ts$/,                     // projection registration, route wiring
  /^src\/workflows\.ts$/,                 // external automations' workflows (append-only)
  /^mocks\/[^/]+\//,                      // an external system's mock
  /^src\/providers\/[^/]+\//,              // an external system's shared code (its provider skill's module)
  /^docker-compose\.yml$/,                // a mock's compose service
];

// Captures context/slicename to detect cross-slice commits
const SLICE_KEY_PATTERN = /^src\/contexts\/([^/]+)\/slices\/([^/]+)\//;

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The renames of the rebuild InProgress in the current context: { folderKey, pairs: [[old, new]] }, or null. */
function inProgressRename(repoRoot) {
  const slicesDir = path.join(repoRoot, '.build-kit', '.slices');
  const ctx = readJson(path.join(slicesDir, 'current_context.json'));
  if (!ctx?.name) return null;
  const index = readJson(path.join(slicesDir, ctx.name, 'index.json'));
  for (const entry of index?.slices ?? []) {
    if (String(entry.status || '').toLowerCase() !== 'inprogress') continue;
    const changes = readJson(path.join(slicesDir, ctx.name, entry.folder, 'slice.json'))?.rebuild?.changes ?? [];
    const named = (suffix) => changes.filter((c) => c.endsWith(suffix)).map((c) => c.slice(0, -suffix.length).trim());
    const removed = named(': removed');
    const added = named(': new');
    const pairs = removed.flatMap((o) => added.map((n) => [o, n]));
    if (pairs.length) return { folder: entry.folder.toLowerCase(), pairs };
  }
  return null;
}

/** Whether a file's every changed line is an old line with an old name replaced by its new one. */
function onlyRenamed(repoRoot, file, pairs) {
  let diff;
  try {
    diff = execSync(`git diff HEAD -U0 --no-color -- "${file}"`, { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    return false;
  }
  const lines = diff.split('\n');
  const pick = (sign, header) => lines.filter((l) => l.startsWith(sign) && !l.startsWith(header)).map((l) => l.slice(1));
  const removed = pick('-', '---');
  const added = pick('+', '+++');
  if (removed.length === 0 || removed.length !== added.length) return false;
  const back = (line) => pairs.map(([o, n]) => line.split(n).join(o));
  // Line for line: each added line, with a new name put back to the old one, is the removed line it replaced
  return added.every((line, i) => line !== removed[i] && back(line).includes(removed[i]));
}

module.exports = {
  name: 'slice-scope',
  run(ctx) {
    const violations = [];

    const sliceKeys = new Set();
    for (const { path: p } of ctx.changes) {
      const m = p.match(SLICE_KEY_PATTERN);
      if (m) sliceKeys.add(`${m[1]}/${m[2]}`);
    }
    // A rebuild that renamed an element: its own folder is the scope, and callers may follow the rename
    const rename = ctx.repoRoot ? inProgressRename(ctx.repoRoot) : null;
    const renamedKey = rename && [...sliceKeys].find((k) => k.split('/')[1].toLowerCase() === rename.folder);
    const primarySlice = renamedKey || [...sliceKeys].sort()[0] || null;

    for (const { path: p } of ctx.changes) {
      if (ALLOWED_EXCEPTIONS.some((r) => r.test(p))) continue;

      const m = p.match(SLICE_KEY_PATTERN);
      if (!m) {
        violations.push({ path: p, reason: 'outside src/contexts/{context}/slices/{slicename}/ and not a documented exception' });
        continue;
      }
      const sliceKey = `${m[1]}/${m[2]}`;
      if (sliceKey !== primarySlice) {
        if (renamedKey && ctx.changes.find((c) => c.path === p)?.status === 'M' && onlyRenamed(ctx.repoRoot, p, rename.pairs)) continue;
        violations.push({
          path: p,
          reason: `touches slice "${sliceKey}" but this commit's scope is "${primarySlice}" — split into separate commits`,
        });
      }
    }
    return violations;
  },
};
