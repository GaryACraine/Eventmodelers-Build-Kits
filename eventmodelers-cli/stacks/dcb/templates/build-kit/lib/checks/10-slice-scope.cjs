'use strict';

// Everything staged in a DCB slice commit must be inside the slice's own folder,
// or one of the documented shared-infra exceptions a slice legitimately modifies.
//
// DCB path structure: src/contexts/{context}/slices/{slicename}/
// Exceptions:
//   - src/contexts/{context}/Events.ts  (shared event union — append-only)
//   - src/index.ts                      (bootstrap — projection/route/automation wiring)
//   - src/workflows.ts                  (the Temporal worker's workflows — append-only, ADR-033)
//   - mocks/{system}/**                 (an external system's container mock, built with its automation — ADR-033)
//   - src/providers/{system}/**         (an external system's code shared by the slices that use it: its provider
//                                        skill's module, created by the first slice that needs it — ADR-045)
//   - docker-compose.yml                (a mock's service)

const ALLOWED_EXCEPTIONS = [
  /^src\/contexts\/[^/]+\/Events\.ts$/,   // per-context event union (append-only)
  /^src\/index\.ts$/,                     // projection registration, route wiring
  /^src\/workflows\.ts$/,                 // external automations' workflows (append-only)
  /^mocks\/[^/]+\//,                      // an external system's mock
  /^src\/providers\/[^/]+\//,              // an external system's shared code (its provider skill's module)
  /^docker-compose\.yml$/,                // a mock's compose service
];

// Captures context/slicename to detect cross-slice commits
const SLICE_KEY_PATTERN = /^src\/contexts\/([^/]+)\/slices\/([^/]+)\//;

module.exports = {
  name: 'slice-scope',
  run(ctx) {
    const violations = [];

    const sliceKeys = new Set();
    for (const { path: p } of ctx.changes) {
      const m = p.match(SLICE_KEY_PATTERN);
      if (m) sliceKeys.add(`${m[1]}/${m[2]}`);
    }
    const primarySlice = [...sliceKeys].sort()[0] || null;

    for (const { path: p } of ctx.changes) {
      if (ALLOWED_EXCEPTIONS.some((r) => r.test(p))) continue;

      const m = p.match(SLICE_KEY_PATTERN);
      if (!m) {
        violations.push({ path: p, reason: 'outside src/contexts/{context}/slices/{slicename}/ and not a documented exception' });
        continue;
      }
      const sliceKey = `${m[1]}/${m[2]}`;
      if (sliceKey !== primarySlice) {
        violations.push({
          path: p,
          reason: `touches slice "${sliceKey}" but this commit's scope is "${primarySlice}" — split into separate commits`,
        });
      }
    }
    return violations;
  },
};
