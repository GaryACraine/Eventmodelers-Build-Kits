'use strict';

// A screen commit's API types are the API contract's (PLAN 14.10, ADR-029): web/src/lib/api-types.ts must be exactly
// what `npm run gen:api` generates from api/openapi.json, the contract emcli writes from the model. It's never
// edited by hand, and never stale: a UI built against types the contract doesn't have would break against the
// backend. Skipped when the project has no contract.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const TYPES = 'web/src/lib/api-types.ts';

module.exports = {
  name: 'api-types',
  scope: 'web',
  run(ctx) {
    const contract = path.join(ctx.repoRoot, 'api', 'openapi.json');
    if (!fs.existsSync(contract)) return [];
    const web = path.join(ctx.repoRoot, 'web');
    if (!fs.existsSync(path.join(web, 'node_modules'))) return [];

    const staged = ctx.changes.some((c) => c.path === TYPES);
    let current;
    try {
      current = staged
        ? execSync(`git show :${TYPES}`, { cwd: ctx.repoRoot, encoding: 'utf8', stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 })
        : fs.readFileSync(path.join(ctx.repoRoot, TYPES), 'utf8');
    } catch {
      current = '';
    }

    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'api-types-')), 'api-types.ts');
    execSync(`npx openapi-typescript "${contract}" -o "${out}"`, { cwd: web, stdio: 'pipe' });
    if (fs.readFileSync(out, 'utf8') === current) return [];
    return [{
      path: TYPES,
      reason: "isn't what the API contract generates: run `npm run gen:api` (it reads api/openapi.json) and stage it; never edit it by hand",
    }];
  },
};
