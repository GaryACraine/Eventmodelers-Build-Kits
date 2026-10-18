'use strict';

// Run: node --test eventmodelers-cli/stacks/dcb/tests/checks/slice-scope.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const CHECK = path.resolve(__dirname, '../../templates/build-kit/lib/checks/10-slice-scope.cjs');
const run = (paths) => require(CHECK).run({ changes: paths.map((p) => ({ status: 'M', path: p })) });

test("a slice's commit may add to its context's Events.ts and Published.ts (ADR-073), not another slice", () => {
  assert.deepStrictEqual(run([
    'src/contexts/identity/slices/registeruser/decider.ts',
    'src/contexts/identity/Events.ts',
    'src/contexts/identity/Published.ts',
  ]), []);
  assert.equal(run(['src/contexts/identity/slices/registeruser/decider.ts', 'src/contexts/identity/slices/myaccount/readModel.ts']).length, 1);
  assert.equal(run(['src/contexts/identity/Other.ts']).length, 1);
});
