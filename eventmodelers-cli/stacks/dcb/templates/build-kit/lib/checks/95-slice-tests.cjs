'use strict';

// The tests of every slice folder this commit touches must pass. Before this check,
// "run the slice tests before committing" was only an instruction in the build prompt,
// so a commit could land with red tests. An extension slice's commit touches its
// origin's folder, so the origin's full test file runs, and every earlier scenario
// still has to hold.
//
// Runs last (slowest: integration tests start a Postgres testcontainer) and is skipped
// once the commit is already rejected.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SLICE_DIR = /^(src\/contexts\/[^/]+\/slices\/[^/]+)\//;

module.exports = {
  name: 'slice-tests',
  skipIfAlreadyFailing: true,
  run(ctx) {
    const dirs = new Set();
    for (const { path: p } of ctx.changes) {
      const m = p.match(SLICE_DIR);
      if (m) dirs.add(m[1]);
    }
    const withTests = [...dirs].filter((dir) => {
      try {
        return fs.readdirSync(path.join(ctx.repoRoot, dir)).some((f) => f.endsWith('.tests.ts'));
      } catch {
        return false; // folder deleted in this commit
      }
    });
    if (withTests.length === 0) return [];

    try {
      execSync(`npx vitest run ${withTests.map((d) => `"${d}"`).join(' ')}`, {
        cwd: ctx.repoRoot,
        stdio: 'pipe',
        maxBuffer: 16 * 1024 * 1024,
      });
      return [];
    } catch (err) {
      const output = String(err.stdout || '') + String(err.stderr || '') || String(err.message);
      const lines = output.trim().split('\n');
      const failures = lines.filter((l) => /FAIL|×|✗|AssertionError|Error:/.test(l)).slice(0, 15);
      const summary = lines.filter((l) => /Test Files|Tests /.test(l)).slice(-2);
      return [{
        path: withTests.join(', '),
        reason: `slice tests failed:\n${[...failures, ...summary].join('\n') || lines.slice(-20).join('\n')}`,
      }];
    }
  },
};
