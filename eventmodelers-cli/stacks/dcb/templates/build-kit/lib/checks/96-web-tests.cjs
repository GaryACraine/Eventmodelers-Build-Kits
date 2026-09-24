'use strict';

// A screen commit must leave web/ typechecking, and the tests of the slice's web/ folder and of the
// pages must pass (answered by MSW, no backend needed). Skipped once the commit is already rejected.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WEB_SLICE = /^web\/src\/slices\/([^/]+)\//;

function failure(err) {
  const output = String(err.stdout || '') + String(err.stderr || '') || String(err.message);
  const lines = output.trim().split('\n');
  const failures = lines.filter((l) => /FAIL|×|✗|AssertionError|Error|error TS/.test(l)).slice(0, 15);
  const summary = lines.filter((l) => /Test Files|Tests /.test(l)).slice(-2);
  return [...failures, ...summary].join('\n') || lines.slice(-20).join('\n');
}

module.exports = {
  name: 'web-tests',
  scope: 'web',
  skipIfAlreadyFailing: true,
  run(ctx) {
    const web = path.join(ctx.repoRoot, 'web');
    if (!fs.existsSync(path.join(web, 'node_modules'))) {
      return [{ path: 'web/', reason: 'web/node_modules is missing: run `npm install` in web/ first' }];
    }
    const dirs = new Set();
    for (const { path: p } of ctx.changes) {
      const m = p.match(WEB_SLICE);
      if (m && fs.existsSync(path.join(web, 'src/slices', m[1]))) dirs.add(`src/slices/${m[1]}`);
    }
    const run = (cmd) => execSync(cmd, { cwd: web, stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 });
    try {
      run('npx tsc -b');
    } catch (err) {
      return [{ path: '(web: tsc -b)', reason: `web/ doesn't typecheck:\n${failure(err)}` }];
    }
    try {
      run(`npx vitest run ${[...dirs, 'src/pages'].map((d) => `"${d}"`).join(' ')}`);
      return [];
    } catch (err) {
      return [{ path: [...dirs].map((d) => `web/${d}`).join(', ') || 'web/src/pages', reason: `screen tests failed:\n${failure(err)}` }];
    }
  },
};
