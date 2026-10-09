'use strict';

// A DCB slice commit that adds/changes a decider, projection, or processor
// must also include a *.tests.ts for that slice.
//
// DCB implementation files that require tests:
//   decider.ts      → needs route.tests.ts (write slices tested via ApiSpecification), or decider.tests.ts when
//                     the command has no endpoint (DeciderSpecification, in-process; ADR-058)
//   projection.ts   → needs route.tests.ts (read slices tested via integration tests), or readModel.tests.ts
//   readModel.ts    → needs route.tests.ts (fold-form read slices: contract tests across types), or
//                     readModel.tests.ts when the read model has no endpoint (read in-process; ADR-058)
//   processor.ts    → needs processor.tests.ts
//   workflow.ts     → needs processor.tests.ts (an external automation's workflow, ADR-033)
//   activities.ts   → needs processor.tests.ts

const { execSync } = require('child_process');

// Matches files that need test coverage in DCB slices
const IMPLEMENTATION_FILE = /^src\/contexts\/([^/]+)\/slices\/([^/]+)\/(decider|projection|readModel|processor|workflow|activities)\.ts$/;

module.exports = {
  name: 'test-file-present',
  run(ctx) {
    const sliceDirs = new Map(); // dir -> type (write or processor)

    for (const { path: p } of ctx.changes) {
      const m = IMPLEMENTATION_FILE.exec(p);
      if (m) {
        const dir = `src/contexts/${m[1]}/slices/${m[2]}`;
        const type = ['workflow', 'activities'].includes(m[3]) ? 'processor' : m[3]; // an automation's files
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
        // decider.ts → route.tests.ts or decider.tests.ts; projection.ts / readModel.ts → route.tests.ts or readModel.tests.ts
        const own = type === 'decider' ? 'decider.tests.ts' : 'readModel.tests.ts';
        hasTest = [...known].some((f) => f === `${dir}/route.tests.ts` || f === `${dir}/${own}`);
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
