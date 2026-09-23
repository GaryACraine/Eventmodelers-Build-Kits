'use strict';

// Query slices (slice.json has `addQueries: [names]`) add named queries to a read model that is
// already built — see build-state-view SKILL.md, "Adding queries", and ADR-023. A query reads the
// documents the read model already has, so the commit only adds. While such a slice is InProgress:
//
//  1. The only slice-folder files changed are the slice's own readModel.ts and *.tests.ts.
//  2. readModel.ts only gains lines inside its `queries: { … }` block, and declares every name in
//     `addQueries` there. No removed lines, except a line re-added with a trailing comma (the
//     previous last query's `}` → `},`).
//  3. route.tests.ts has a describe.each(queryTypes(…))("{slice title}: {query} (%s)") block per added
//     query, with at least one test(...) per specification whose *when* runs that query. Existing
//     lines stay, except an import line re-added with more names (`queryTypes`).
//
// `type:` lines are left to retype-scope: with a `retype` block too, the retype is its own commit.
// Extension slices with `addQueries` are held to extension-additive instead (their query goes in
// the origin's folder). The slice being built is the one the loop marked InProgress in the current
// context's index.json. No InProgress query slice → this check does nothing.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { normalize } = require('../util/find-slice.cjs');
const { describeBlocks, queryOfBlock, specsPerQuery } = require('../util/describe-blocks.cjs');

const SLICE_KEY_PATTERN = /^src\/contexts\/([^/]+)\/slices\/([^/]+)\//;
const TYPE_LINE = /^type\s*:\s*["'`]([a-z-]+)["'`]\s*,?$/;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const IMPORT_LINE = /^import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*(["'`][^"'`]+["'`])/;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function inProgressQuerySlices(repoRoot) {
  const slicesDir = path.join(repoRoot, '.build-kit', '.slices');
  const ctx = readJson(path.join(slicesDir, 'current_context.json'));
  if (!ctx?.name) return [];
  const index = readJson(path.join(slicesDir, ctx.name, 'index.json'));
  return (index?.slices ?? [])
    .filter((entry) => String(entry.status || '').toLowerCase() === 'inprogress')
    .map((entry) => readJson(path.join(slicesDir, ctx.name, entry.folder, 'slice.json')))
    .filter((slice) => slice && !slice.extends && Array.isArray(slice.addQueries) && slice.addQueries.length > 0);
}

// Removed lines, and added lines with their line number in the new file.
function diff(repoRoot, file) {
  let out;
  try {
    out = execSync(`git diff HEAD -U0 --no-color -- "${file}"`, { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    return { removed: [], added: [] };
  }
  const removed = [];
  const added = [];
  let line = 0;
  for (const l of out.split('\n')) {
    const hunk = l.match(HUNK);
    if (hunk) {
      line = Number(hunk[1]);
    } else if (l.startsWith('+') && !l.startsWith('+++')) {
      added.push({ line: line++, text: l.slice(1).trim() });
    } else if (l.startsWith('-') && !l.startsWith('---')) {
      removed.push(l.slice(1).trim());
    }
  }
  return { removed: removed.filter(Boolean), added: added.filter((a) => a.text !== '') };
}

// First and last line (1-based) of the definition's `queries: { … }` block, and its text; null if absent.
function queriesBlock(content) {
  const m = content.match(/^[ \t]*queries\s*:\s*\{/m);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  let quote = null;
  for (let i = open; i < content.length; i++) {
    const c = content[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
    } else if (c === '{') {
      depth++;
    } else if (c === '}' && --depth === 0) {
      const lineAt = (idx) => content.slice(0, idx).split('\n').length;
      return { first: lineAt(m.index), last: lineAt(i), text: content.slice(open, i + 1) };
    }
  }
  return null;
}

function importNames(line) {
  const m = line.match(IMPORT_LINE);
  if (!m) return null;
  const names = m[1].split(',').map((n) => n.trim()).filter(Boolean);
  return { names, from: m[2].slice(1, -1) };
}

// A removed import line is widened when an added import from the same module keeps all its names.
function isWidenedImport(removed, addedTexts) {
  const before = importNames(removed);
  if (!before) return false;
  return addedTexts.some((text) => {
    const after = importNames(text);
    return after && after.from === before.from && before.names.every((n) => after.names.includes(n));
  });
}

module.exports = {
  name: 'query-additive',
  run(ctx) {
    const violations = [];

    for (const slice of inProgressQuerySlices(ctx.repoRoot)) {
      const ownKey = normalize(slice.title);
      const names = slice.addQueries.join(', ');
      let folder = null;

      for (const { path: p } of ctx.changes) {
        const m = p.match(SLICE_KEY_PATTERN);
        if (!m) continue;
        const own = normalize(m[2]) === ownKey;
        const rest = p.slice(m[0].length);
        if (own && (rest === 'readModel.ts' || /^[^/]+\.tests\.ts$/.test(rest))) {
          folder = m[0].slice(0, -1);
          continue;
        }
        violations.push({
          path: p,
          reason: `adding queries (${names}) to "${slice.title}" changes only its readModel.ts and tests — not ${own ? 'this file' : 'another slice'}`,
        });
      }
      if (!folder) continue;

      const definition = `${folder}/readModel.ts`;
      const testsFile = `${folder}/route.tests.ts`;
      const definitionChanged = ctx.changes.some((c) => c.path === definition);
      const testsChanged = ctx.changes.some((c) => c.path === testsFile);

      // Rule 2 — readModel.ts only grows inside `queries`.
      const rm = definitionChanged ? diff(ctx.repoRoot, definition) : { removed: [], added: [] };
      const isType = (text) => TYPE_LINE.test(text);
      const added = rm.added.filter((a) => !isType(a.text));
      const removed = rm.removed.filter((text) => !isType(text));
      if (!slice.retype) {
        for (const text of [...rm.removed, ...rm.added.map((a) => a.text)].filter(isType)) {
          violations.push({ path: definition, reason: `adding queries doesn't change the read model's type — changed line: ${text}` });
        }
      }
      if (added.length === 0 && removed.length === 0 && !testsChanged) continue; // e.g. the retype commit

      const addedTexts = new Set(added.map((a) => a.text));
      for (const text of removed) {
        if (!addedTexts.has(`${text},`)) {
          violations.push({ path: definition, reason: `adding queries only adds to the read model — removed/changed line: ${text}` });
        }
      }
      const block = queriesBlock(readText(path.join(ctx.repoRoot, definition)));
      for (const a of added) {
        if (!block || a.line < block.first || a.line > block.last) {
          violations.push({ path: definition, reason: `line ${a.line} is outside the queries block — adding queries touches nothing else: ${a.text}` });
        }
      }
      for (const q of slice.addQueries) {
        if (!block || !new RegExp(`^\\s*["'\`]?${q.replace(/[^A-Za-z0-9_$]/g, '')}["'\`]?\\s*:`, 'm').test(block.text)) {
          violations.push({ path: definition, reason: `addQueries names "${q}" but readModel.ts doesn't declare it in queries` });
        }
      }

      // Rule 3 — a query test block per added query; existing tests untouched.
      if (!testsChanged) {
        violations.push({ path: testsFile, reason: `adding queries (${names}) needs their tests — no change to ${testsFile}` });
        continue;
      }
      const tests = diff(ctx.repoRoot, testsFile);
      const testsAdded = tests.added.map((a) => a.text);
      for (const text of tests.removed) {
        if (!testsAdded.includes(`${text},`) && !isWidenedImport(text, testsAdded)) {
          violations.push({ path: testsFile, reason: `adding queries leaves the existing tests as they are — removed/changed line: ${text}` });
        }
      }
      const blocks = describeBlocks(readText(path.join(ctx.repoRoot, testsFile)));
      const specs = specsPerQuery(slice);
      for (const q of slice.addQueries) {
        const own = blocks.filter((b) => queryOfBlock(b.title, slice.title) === q);
        const count = own.reduce((sum, b) => sum + b.tests, 0);
        const needed = Math.max(1, specs.get(q) || 0);
        if (own.length === 0) {
          violations.push({ path: testsFile, reason: `no describe.each(queryTypes(…))("${slice.title}: ${q} (%s)") block for the added query` });
        } else if (count < needed) {
          violations.push({ path: testsFile, reason: `"${slice.title}: ${q} (%s)" has ${count} test(...) block(s) but ${needed} specification(s) run ${q}` });
        }
      }
    }

    return violations;
  },
};
