'use strict';

// Rejects a slice commit (backend or screen) that touches shared infra which must never
// change from slice work: the package manifests/lockfiles (the backend's and web/'s), the API contract
// (api/openapi.json, the model's) and the application bootstrap (index.ts).

const BLOCKED = [
  {
    pattern: /^(web\/)?(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/,
    reason: 'dependency/package manifest changes are not allowed from a slice commit',
  },
  {
    pattern: /^api\/openapi\.json$/,
    reason: 'api/openapi.json is the API contract, written by the model\'s export: change the model, never the contract',
  },
  {
    pattern: /^src\/index\.ts$/,
    reason: 'src/index.ts is shared infra — route/projection wiring goes here but must be committed separately from slice code when it involves changes outside the slice folder',
  },
];

module.exports = {
  name: 'blocked-paths',
  scope: 'any',
  run(ctx) {
    const violations = [];
    for (const { path: p } of ctx.changes) {
      const hit = BLOCKED.find((b) => b.pattern.test(p));
      if (hit) violations.push({ path: p, reason: hit.reason });
    }
    return violations;
  },
};
