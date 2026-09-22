'use strict';

// Extension slices (slice.json has an `extends` block) grow an existing read model by
// editing the ORIGIN slice's projection in place — see build-state-view SKILL.md,
// "Extending an existing projection". Three rules while such a slice is InProgress:
//
//  1. Slice-folder changes stay inside the origin's folder (or the extension's own).
//  2. The origin's projection.ts only grows: no removed lines, except a line that is
//     re-added with a trailing comma (appending after the last canHandle entry).
//  3. The origin's route.tests.ts has a top-level describe("{extension title}") block
//     with at least one test(...) per specification in the extension's slice.json.
//
// The slice being built is the one the loop marked InProgress in the current
// context's index.json. No InProgress extension slice → this check does nothing.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { normalize } = require('../util/find-slice.cjs');

const SLICE_KEY_PATTERN = /^src\/contexts\/([^/]+)\/slices\/([^/]+)\//;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function inProgressExtensions(repoRoot) {
  const slicesDir = path.join(repoRoot, '.build-kit', '.slices');
  const ctx = readJson(path.join(slicesDir, 'current_context.json'));
  if (!ctx?.name) return [];
  const index = readJson(path.join(slicesDir, ctx.name, 'index.json'));
  return (index?.slices ?? [])
    .filter((entry) => String(entry.status || '').toLowerCase() === 'inprogress')
    .map((entry) => readJson(path.join(slicesDir, ctx.name, entry.folder, 'slice.json')))
    .filter((slice) => slice && slice.extends);
}

function originFolder(repoRoot, ext) {
  const contextsDir = path.join(repoRoot, 'src', 'contexts');
  let contexts;
  try {
    contexts = fs.readdirSync(contextsDir);
  } catch {
    return null;
  }
  const context = contexts.find((c) => normalize(c) === normalize(ext.originContext));
  if (!context) return null;
  let slices;
  try {
    slices = fs.readdirSync(path.join(contextsDir, context, 'slices'));
  } catch {
    return null;
  }
  const folder = slices.find((s) => normalize(s) === normalize(ext.originSliceTitle));
  return folder ? `src/contexts/${context}/slices/${folder}` : null;
}

const TEST_BLOCK = /\b(?:test|it)(?:\.(?:only|skip))?\s*\(/g;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Tests inside the top-level describe block named `title`, up to the next top-level
// describe(...) or end of file. Returns null when the block is missing.
function testsInDescribe(content, title) {
  const start = content.search(new RegExp(`^describe\\(\\s*["'\`]${escapeRegExp(title)}["'\`]`, 'm'));
  if (start === -1) return null;
  const rest = content.slice(start + 1);
  const next = rest.search(/^describe\(/m);
  const block = next === -1 ? rest : rest.slice(0, next);
  return (block.match(TEST_BLOCK) || []).length;
}

function removedLines(repoRoot, file) {
  let diff;
  try {
    diff = execSync(`git diff HEAD -U0 --no-color -- "${file}"`, { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    return [];
  }
  const lines = diff.split('\n');
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1).trim());
  const added = new Set(lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1).trim()));
  return removed.filter((line) => line !== '' && !added.has(`${line},`));
}

module.exports = {
  name: 'extension-additive',
  run(ctx) {
    const violations = [];

    for (const slice of inProgressExtensions(ctx.repoRoot)) {
      const origin = originFolder(ctx.repoRoot, slice.extends);
      if (!origin) {
        violations.push({
          path: `(extension "${slice.title}")`,
          reason: `origin slice "${slice.extends.originSliceTitle}" not found under src/contexts/${slice.extends.originContext}/slices/ — build the origin first`,
        });
        continue;
      }
      const ownKey = normalize(slice.title);

      for (const { path: p } of ctx.changes) {
        const m = p.match(SLICE_KEY_PATTERN);
        if (!m) continue;
        const inOrigin = p.startsWith(`${origin}/`);
        const inOwn = normalize(m[2]) === ownKey;
        if (!inOrigin && !inOwn) {
          violations.push({
            path: p,
            reason: `extension slice "${slice.title}" may only change its origin ${origin}/ — this is another slice`,
          });
        }
      }

      const projection = `${origin}/projection.ts`;
      if (ctx.changes.some((c) => c.path === projection)) {
        for (const line of removedLines(ctx.repoRoot, projection)) {
          violations.push({
            path: projection,
            reason: `extension slices only add to the origin projection — removed/changed line: ${line}`,
          });
        }
      }

      const specCount = Array.isArray(slice.specifications) ? slice.specifications.length : 0;
      const testsFile = `${origin}/route.tests.ts`;
      if (specCount > 0 && ctx.changes.some((c) => c.path === testsFile)) {
        let content = '';
        try {
          content = fs.readFileSync(path.join(ctx.repoRoot, testsFile), 'utf8');
        } catch {
          // unreadable — nothing to verify
        }
        const count = testsInDescribe(content, slice.title);
        if (count === null) {
          violations.push({ path: testsFile, reason: `no top-level describe("${slice.title}") block for this extension slice's specifications` });
        } else if (count < specCount) {
          violations.push({
            path: testsFile,
            reason: `describe("${slice.title}") has ${count} test(...) block(s) but the extension declares ${specCount} specification(s)`,
          });
        }
      }
    }

    return violations;
  },
};
