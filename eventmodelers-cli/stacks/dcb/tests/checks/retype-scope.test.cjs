'use strict';

// Run: node --test eventmodelers-cli/stacks/dcb/tests/checks/retype-scope.test.cjs
// Builds a throwaway git repo with the kit layout (.build-kit/.slices + a built fold-form slice),
// makes a change, and runs the retype-scope check against it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const KIT = path.resolve(__dirname, '../../../..');
const CHECK_SRC = path.join(KIT, 'stacks/dcb/templates/build-kit/lib/checks/17-retype-scope.cjs');
const UTIL_SRC = path.join(KIT, 'shared/build-kit/lib/util');

const SLICE_DIR = 'src/contexts/enrollment/slices/courseseats';
const READ_MODEL = `export const courseSeats = defineReadModel({
    name: "CourseSeats",
    type: "inline-projected",
    key: "courseId",
    collection: "course_seats",
    canHandle: [
        "courseWasRegistered"
    ],
    evolve: (doc, { event }) => doc
})
`;

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

function repo({ status = 'InProgress', retype = { from: 'inline-projected', to: 'live-report' } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retype-scope-'));
  const sh = (cmd) => execSync(cmd, { cwd: root, stdio: 'pipe' });
  sh('git init -q && git config user.email t@t && git config user.name t');
  write(root, `${SLICE_DIR}/readModel.ts`, READ_MODEL);
  write(root, `${SLICE_DIR}/route.tests.ts`, 'describe.each(TYPES)("course seats (%s)", () => {})\n');
  sh('git add -A && git commit -q -m init');

  write(root, '.build-kit/.slices/current_context.json', JSON.stringify({ name: 'enrollment' }));
  write(root, '.build-kit/.slices/enrollment/index.json',
    JSON.stringify({ slices: [{ id: 'v1', folder: 'courseseats', status }] }));
  write(root, '.build-kit/.slices/enrollment/courseseats/slice.json',
    JSON.stringify({ id: 'v1', title: 'course seats', ...(retype ? { retype } : {}) }));
  fs.mkdirSync(path.join(root, 'lib/checks'), { recursive: true });
  fs.cpSync(UTIL_SRC, path.join(root, 'lib/util'), { recursive: true });
  fs.copyFileSync(CHECK_SRC, path.join(root, 'lib/checks/17-retype-scope.cjs'));
  return root;
}

function run(root, changed) {
  const check = require(path.join(root, 'lib/checks/17-retype-scope.cjs'));
  return check.run({ repoRoot: root, changes: changed.map((p) => ({ status: 'M', path: p })) });
}

function retypeTo(root, type) {
  const file = path.join(root, SLICE_DIR, 'readModel.ts');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('type: "inline-projected"', `type: "${type}"`));
}

test('a one-line type change to retype.to passes', () => {
  const root = repo();
  retypeTo(root, 'live-report');
  assert.deepStrictEqual(run(root, [`${SLICE_DIR}/readModel.ts`]), []);
});

test('the type line must name retype.to', () => {
  const root = repo();
  retypeTo(root, 'database-projected');
  const v = run(root, [`${SLICE_DIR}/readModel.ts`]);
  assert.strictEqual(v.length, 1);
  assert.match(v[0].reason, /targets "live-report"/);
});

test('any other change to readModel.ts is rejected', () => {
  const root = repo();
  retypeTo(root, 'live-report');
  const file = path.join(root, SLICE_DIR, 'readModel.ts');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"courseWasRegistered"', '"courseWasRegistered",\n        "courseTitleWasChanged"'));
  const v = run(root, [`${SLICE_DIR}/readModel.ts`]);
  assert.strictEqual(v.length, 1);
  assert.match(v[0].reason, /only the type: line/);
});

test('touching the tests (or any other slice file) is rejected', () => {
  const root = repo();
  retypeTo(root, 'live-report');
  write(root, `${SLICE_DIR}/route.tests.ts`, '// changed\n');
  const v = run(root, [`${SLICE_DIR}/readModel.ts`, `${SLICE_DIR}/route.tests.ts`]);
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].path, `${SLICE_DIR}/route.tests.ts`);
});

test('does nothing when no retype slice is in progress', () => {
  assert.deepStrictEqual(run(repo({ status: 'Planned' }), [`${SLICE_DIR}/route.tests.ts`]), []);
  assert.deepStrictEqual(run(repo({ retype: null }), [`${SLICE_DIR}/route.tests.ts`]), []);
});
