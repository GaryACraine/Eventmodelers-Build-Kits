'use strict';

// A DCB slice commit that adds/changes a decider, projection, or processor
// must also include a *.tests.ts for that slice.
//
// DCB implementation files that require tests:
//   decider.ts      → needs route.tests.ts (write slices tested via ApiSpecification)
//   projection.ts   → needs route.tests.ts (read slices tested via integration tests)
//   processor.ts    → needs processor.tests.ts

const { execSync } = require('child_process');

// Matches files that need test coverage in DCB slices
const IMPLEMENTATION_FILE = /^src\/contexts\/([^/]+)\/slices\/([^/]+)\/(decider|projection|processor)\.ts$/;

module.exports = {
  name: 'test-file-present',
  run(ctx) {
    const sliceDirs = new Map(); // dir -> type (write or processor)

    for (const { path: p } of ctx.changes) {
      const m = IMPLEMENTATION_FILE.exec(p);
      if (m) {
        const dir = `src/contexts/${m[1]}/slices/${m[2]}`;
        const type = m[3]; // 'decider', 'projection', or 'processor'
        sliceDirs.set(dir, type);
      }
    }
    if (sliceDirs.size === 0) return [];

    let tracked = [];
    try {
      tracked = execSync('git ls-files -- src/contexts', { cwd: ctx.repoRoot, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    } catch {
      // best-effort
    }
    const known = new Set([...tracked, ...ctx.changes.map((c) => c.path)]);

    const violations = [];
    for (const [dir, type] of sliceDirs) {
      let hasTest;
      if (type === 'processor') {
        // processor.ts → processor.tests.ts
        hasTest = [...known].some((f) => f === `${dir}/processor.tests.ts`);
      } else {
        // decider.ts or projection.ts → route.tests.ts
        hasTest = [...known].some((f) => f === `${dir}/route.tests.ts`);
      }

      if (!hasTest) {
        violations.push({
          path: dir,
          reason: `no *.tests.ts found for this slice — decider/projection/processor files need test coverage`,
        });
      }
    }
    return violations;
  },
};
