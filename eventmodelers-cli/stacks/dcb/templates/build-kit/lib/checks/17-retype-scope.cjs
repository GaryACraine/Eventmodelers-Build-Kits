'use strict';

// Retype slices (slice.json has a `retype: { from, to }` block) switch an already-built read model
// to another type — see build-state-view SKILL.md, "Changing a read model's type". The data shape
// must not change (ADR-022), so while such a slice is InProgress the commit may change exactly one
// thing: the `type:` line of the slice's own readModel.ts, to `retype.to`.
//
//  1. The only slice-folder file changed is the slice's own readModel.ts — no tests, no route.
//  2. In readModel.ts, the only removed line is the old `type:` line and the only added line is
//     `type: "{retype.to}"`.
//
// A slice can carry `addQueries` too (ADR-023): the retype is its own commit first, then the queries.
// So with `addQueries`, a commit that leaves the type: line alone is the queries commit — the
// query-additive check governs it and this one steps aside. A commit that does touch the type:
// line is still held to rules 1 and 2.
//
// The slice being built is the one the loop marked InProgress in the current context's
// index.json. No InProgress retype slice → this check does nothing.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { normalize } = require('../util/find-slice.cjs');

const SLICE_KEY_PATTERN = /^src\/contexts\/([^/]+)\/slices\/([^/]+)\//;
const TYPE_LINE = /^type\s*:\s*["'`]([a-z-]+)["'`]\s*,?$/;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function inProgressRetypes(repoRoot) {
  const slicesDir = path.join(repoRoot, '.build-kit', '.slices');
  const ctx = readJson(path.join(slicesDir, 'current_context.json'));
  if (!ctx?.name) return [];
  const index = readJson(path.join(slicesDir, ctx.name, 'index.json'));
  return (index?.slices ?? [])
    .filter((entry) => String(entry.status || '').toLowerCase() === 'inprogress')
    .map((entry) => readJson(path.join(slicesDir, ctx.name, entry.folder, 'slice.json')))
    .filter((slice) => slice && slice.retype && slice.retype.to);
}

function diffLines(repoRoot, file) {
  let diff;
  try {
    diff = execSync(`git diff HEAD -U0 --no-color -- "${file}"`, { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    return { removed: [], added: [] };
  }
  const lines = diff.split('\n');
  const pick = (sign, header) =>
    lines.filter((l) => l.startsWith(sign) && !l.startsWith(header)).map((l) => l.slice(1).trim()).filter(Boolean);
  return { removed: pick('-', '---'), added: pick('+', '+++') };
}

module.exports = {
  name: 'retype-scope',
  run(ctx) {
    const violations = [];

    for (const slice of inProgressRetypes(ctx.repoRoot)) {
      const ownKey = normalize(slice.title);
      const { from, to } = slice.retype;
      if (Array.isArray(slice.addQueries) && slice.addQueries.length > 0) {
        const own = ctx.changes.find(({ path: p }) => {
          const m = p.match(SLICE_KEY_PATTERN);
          return m && normalize(m[2]) === ownKey && p === `${m[0]}readModel.ts`;
        });
        const { removed, added } = own ? diffLines(ctx.repoRoot, own.path) : { removed: [], added: [] };
        if (![...removed, ...added].some((l) => TYPE_LINE.test(l))) continue;
      }
      let definition = null;

      for (const { path: p } of ctx.changes) {
        const m = p.match(SLICE_KEY_PATTERN);
        if (!m) continue;
        if (normalize(m[2]) === ownKey && p === `${m[0]}readModel.ts`) {
          definition = p;
          continue;
        }
        violations.push({
          path: p,
          reason: `retype of "${slice.title}" (${from} → ${to}) may only change the type: line of its readModel.ts — tests, route and other slices stay untouched`,
        });
      }

      if (!definition) continue;
      const { removed, added } = diffLines(ctx.repoRoot, definition);
      const addedType = added.length === 1 ? added[0].match(TYPE_LINE) : null;
      const removedType = removed.length === 1 ? removed[0].match(TYPE_LINE) : null;
      if (!addedType || !removedType) {
        violations.push({
          path: definition,
          reason: `a retype changes only the type: line — found ${removed.length} removed and ${added.length} added line(s)`,
        });
      } else if (addedType[1] !== to) {
        violations.push({ path: definition, reason: `retype targets "${to}" but the type: line says "${addedType[1]}"` });
      }
    }

    return violations;
  },
};
