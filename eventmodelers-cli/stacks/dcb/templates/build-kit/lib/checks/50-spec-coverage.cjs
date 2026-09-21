'use strict';

// Heuristic: a DCB slice's *.tests.ts must have at least as many `test(...)` blocks as
// slice.json has `specifications[]` entries. Also counts `it(...)` blocks (alias).
// Skipped when slice.json can't be found or has no specifications[] array.

const fs = require('fs');
const path = require('path');
const { findSliceJson } = require('../util/find-slice.cjs');

// DCB test files are *.tests.ts (plural)
const TEST_FILE = /^src\/contexts\/([^/]+)\/slices\/([^/]+)\/[^/]+\.tests\.ts$/;
// vitest uses `test(` or `it(` — both count
const TEST_BLOCK = /\b(?:test|it)(?:\.(?:only|skip))?\s*\(/g;

module.exports = {
  name: 'spec-coverage',
  run(ctx) {
    const violations = [];

    for (const { path: p } of ctx.changes) {
      TEST_FILE.lastIndex = 0;
      const m = TEST_FILE.exec(p);
      if (!m) continue;
      const [, context, sliceName] = m;

      const slice = findSliceJson(ctx.repoRoot, context, sliceName);
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

    return violations;
  },
};
