'use strict';

// Rejects a slice commit that touches shared infra which must never change from
// slice work: the package manifest/lockfiles and the application bootstrap (index.ts).

const BLOCKED = [
  {
    pattern: /^(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/,
    reason: 'dependency/package manifest changes are not allowed from a slice commit',
  },
  {
    pattern: /^src\/index\.ts$/,
    reason: 'src/index.ts is shared infra — route/projection wiring goes here but must be committed separately from slice code when it involves changes outside the slice folder',
  },
];

module.exports = {
  name: 'blocked-paths',
  run(ctx) {
    const violations = [];
    for (const { path: p } of ctx.changes) {
      const hit = BLOCKED.find((b) => b.pattern.test(p));
      if (hit) violations.push({ path: p, reason: hit.reason });
    }
    return violations;
  },
};
