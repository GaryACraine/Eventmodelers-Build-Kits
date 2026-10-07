'use strict';

// Every specification of a slice has a test named after it. For each slice folder a commit's test files touch:
// - **by title:** every specification title of the folder's slice, and of each extension slice built (or being built)
//   on it, appears verbatim as a `test(...)`/`it(...)` title in one of the folder's *.tests.ts files. An extension's
//   tests live in its origin's `route.tests.ts` (ADR-019), so a count alone can't tell whose tests they are: licensing's
//   "refused trials at paddle" gained a scenario with no test, and its file still had more tests than scenarios;
// - **by count** (as before): each test file has at least as many test blocks as the folder's own slice.json has
//   specifications, so an integration file mirrors them too.
// Skipped when the folder's slice.json can't be found or has no specifications.

const fs = require('fs');
const path = require('path');
const { findSliceJson, normalize } = require('../util/find-slice.cjs');

// DCB test files are *.tests.ts (plural)
const TEST_FILE = /^(src\/contexts\/([^/]+)\/slices\/([^/]+))\/[^/]+\.tests\.ts$/;
// vitest uses `test(` or `it(` — both count
const TEST_BLOCK = /\b(?:test|it)(?:\.(?:only|skip))?\s*\(/g;
// A test's title: test("…"), it('…'), test.skip(`…`)
const TEST_TITLE = /\b(?:test|it)(?:\.(?:only|skip))?\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function testTitles(content) {
  return [...content.matchAll(TEST_TITLE)].map((m) => m[2].replace(/\\(.)/g, '$1'));
}

function backendStatus(entry) {
  return String((entry?.concerns ? entry.concerns.backend?.status : entry?.status) || '').toLowerCase();
}

// The extension slices of the folder's slice that are built or being built: their tests share the folder.
function extensionsOf(repoRoot, context, folder) {
  const root = path.join(repoRoot, '.build-kit', '.slices');
  let contexts;
  try {
    contexts = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const dir of contexts) {
    if (!dir.isDirectory() || normalize(dir.name) !== normalize(context)) continue;
    const index = readJson(path.join(root, dir.name, 'index.json'));
    for (const entry of index?.slices ?? []) {
      if (!['done', 'inprogress'].includes(backendStatus(entry))) continue;
      const slice = readJson(path.join(root, dir.name, entry.folder, 'slice.json'));
      if (slice?.extends && normalize(slice.extends.originSliceTitle) === normalize(folder)) out.push(slice);
    }
  }
  return out;
}

module.exports = {
  name: 'spec-coverage',
  run(ctx) {
    const violations = [];
    const folders = new Map();

    for (const { path: p } of ctx.changes) {
      const m = TEST_FILE.exec(p);
      if (!m) continue;
      const [, dir, context, folder] = m;
      if (!folders.has(dir)) folders.set(dir, { context, folder });

      const slice = findSliceJson(ctx.repoRoot, context, folder);
      if (!slice || !Array.isArray(slice.specifications) || slice.specifications.length === 0) continue;
      let content;
      try {
        content = fs.readFileSync(path.join(ctx.repoRoot, p), 'utf8');
      } catch {
        continue;
      }
      const specCount = slice.specifications.length;
      const testCount = (content.match(TEST_BLOCK) || []).length;
      if (testCount < specCount) {
        violations.push({
          path: p,
          reason: `slice.json declares ${specCount} specification(s) but this test file only has ${testCount} test(...) block(s)`,
        });
      }
    }

    for (const [dir, { context, folder }] of folders) {
      const own = findSliceJson(ctx.repoRoot, context, folder);
      const slices = [own, ...extensionsOf(ctx.repoRoot, context, folder)].filter(Boolean);
      const specs = slices.flatMap((s) =>
        (Array.isArray(s.specifications) ? s.specifications : []).map((spec) => ({ slice: s.title, title: spec?.title })),
      ).filter((s) => s.title);
      if (specs.length === 0) continue;

      let files;
      try {
        files = fs.readdirSync(path.join(ctx.repoRoot, dir)).filter((f) => f.endsWith('.tests.ts'));
      } catch {
        continue; // folder deleted in this commit
      }
      const titles = new Set(files.flatMap((f) => testTitles(fs.readFileSync(path.join(ctx.repoRoot, dir, f), 'utf8'))));
      const missing = specs.filter((s) => !titles.has(s.title));
      if (missing.length > 0) {
        violations.push({
          path: dir,
          reason: `no test is named after ${missing.map((s) => `"${s.title}" ("${s.slice}")`).join(', ')}. ` +
            `Name one test after each specification, its title verbatim; an extension's go in its origin's route.tests.ts`,
        });
      }
    }

    return violations;
  },
};
