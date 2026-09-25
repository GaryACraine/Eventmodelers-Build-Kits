'use strict';

// The routes a backend commit's slices serve match the API contract (api/openapi.json), which emcli writes from
// the model at export (PLAN 14.10, ADR-029). The UI is generated from the contract, possibly before this backend
// was built, so a field renamed, retyped or made optional here would break it.
//
// For each slice folder the commit touches, the operations it serves — router.<method>("<path>"), readModelRoute's
// keyed GET, and each query `path:` in its readModel.ts — are compared with the contract by
// `node dist/contract.js --only …` (src/contract.ts): field names, required, types, component names, parameters and
// the success status. Descriptions, headers and which 4xx a rejection uses are the code's to choose.
//
// Skipped when the project has no contract (a project not exported by emcli), and once the commit is already
// rejected (it builds dist/ first, after tsc-build has passed).

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SLICE_DIR = /^(src\/contexts\/[^/]+\/slices\/[^/]+)\//;
const ROUTE_CALL = /router\.(get|post|put|patch|delete)\(\s*(["'`])([^"'`]+)\2/g;
const READ_MODEL_ROUTE = /readModelRoute\([^)"'`]*?(["'`])([^"'`]+)\1/g;
const QUERY_PATH = /\bpath\s*:\s*(["'`])(\/[^"'`]+)\1/g;
const EXEMPT = new Set(['/openapi.json', '/events']);

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
const openApiPath = (p) => p.replace(/:(\w+)/g, '{$1}');

/** The operations (`POST /rate-course`) a slice folder serves. */
function servedBy(dir) {
  const ops = new Set();
  const route = read(path.join(dir, 'route.ts'));
  for (const m of route.matchAll(ROUTE_CALL)) ops.add(`${m[1].toUpperCase()} ${openApiPath(m[3])}`);
  const keyed = [...route.matchAll(READ_MODEL_ROUTE)];
  for (const m of keyed) ops.add(`GET ${openApiPath(m[2])}`);
  if (keyed.length > 0) {
    for (const m of read(path.join(dir, 'readModel.ts')).matchAll(QUERY_PATH)) ops.add(`GET ${openApiPath(m[2])}`);
  }
  return [...ops].filter((op) => !EXEMPT.has(op.slice(op.indexOf(' ') + 1)));
}

module.exports = {
  name: 'api-contract',
  skipIfAlreadyFailing: true,
  run(ctx) {
    if (!fs.existsSync(path.join(ctx.repoRoot, 'api', 'openapi.json'))) return [];
    const dirs = new Set();
    for (const { path: p } of ctx.changes) {
      const m = p.match(SLICE_DIR);
      if (m) dirs.add(m[1]);
    }
    const ops = [...dirs].flatMap((dir) => servedBy(path.join(ctx.repoRoot, dir)));
    if (ops.length === 0) return [];

    try {
      execSync('npx tsc -p tsconfig.build.json', { cwd: ctx.repoRoot, stdio: 'pipe' });
      execSync(`node dist/contract.js --only "${ops.join(',')}"`, { cwd: ctx.repoRoot, stdio: 'pipe', encoding: 'utf8' });
      return [];
    } catch (err) {
      const output = (String(err.stdout || '') + String(err.stderr || '')).trim() || String(err.message);
      return [{
        path: [...dirs].join(', '),
        reason: 'the served API differs from the API contract (api/openapi.json, written from the model):\n' +
          output.split('\n').slice(0, 30).join('\n') +
          '\nThe contract is the model\'s: make the code match it (slice.json has the same fields). If the model is wrong, ' +
          'block the job and say what the model should say.',
      }];
    }
  },
};
