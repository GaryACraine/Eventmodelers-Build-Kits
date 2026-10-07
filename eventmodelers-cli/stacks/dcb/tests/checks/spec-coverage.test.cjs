'use strict';

// Run: node --test eventmodelers-cli/stacks/dcb/tests/checks/spec-coverage.test.cjs
// Builds a throwaway project with the kit layout (.build-kit/.slices, an origin read model and its extensions) and runs
// the spec-coverage check against a commit that touches the origin's tests.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KIT = path.resolve(__dirname, '../../../..');
const CHECK_SRC = path.join(KIT, 'stacks/dcb/templates/build-kit/lib/checks/50-spec-coverage.cjs');
const UTIL_SRC = path.join(KIT, 'shared/build-kit/lib/util');

const DIR = 'src/contexts/licensing/slices/refusedtrialsatpaddle';
const TESTS = `${DIR}/route.tests.ts`;

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

const specs = (...titles) => titles.map((title, i) => ({ id: `s${i}`, title, given: [], when: [], then: [] }));

// slices: [{ folder, title, specs, status, origin }]; tests: { file: [titles] }
function project(slices, tests) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-coverage-'));
  const base = '.build-kit/.slices/licensing';
  write(root, `${base}/index.json`, JSON.stringify({
    slices: slices.map((s) => ({ id: s.folder, folder: s.folder, slice: s.title, concerns: { backend: { status: s.status ?? 'Done' } } })),
  }));
  for (const s of slices) {
    write(root, `${base}/${s.folder}/slice.json`, JSON.stringify({
      id: s.folder, title: s.title, specifications: specs(...s.specs),
      ...(s.origin ? { extends: { originContext: 'licensing', originSliceTitle: s.origin } } : {}),
    }));
  }
  for (const [file, titles] of Object.entries(tests)) {
    write(root, `${DIR}/${file}`, titles.map((t) => `    test(${JSON.stringify(t)}, async () => {})\n`).join(''));
  }
  fs.mkdirSync(path.join(root, 'lib/checks'), { recursive: true });
  fs.cpSync(UTIL_SRC, path.join(root, 'lib/util'), { recursive: true });
  fs.copyFileSync(CHECK_SRC, path.join(root, 'lib/checks/50-spec-coverage.cjs'));
  const check = require(path.join(root, 'lib/checks/50-spec-coverage.cjs'));
  return (changes = [TESTS]) => check.run({ repoRoot: root, changes: changes.map((p) => ({ status: 'M', path: p })) });
}

const origin = (more = [], status) => ({ folder: 'refusedtrialsatpaddle', title: 'refused trials at paddle', specs: ['lists a refused trial', ...more], status });
const settled = (status) => ({ folder: 'refusedtrialsatpaddlesettled', title: 'refused trials at paddle settled', specs: ['is empty once cancelled'], origin: 'refused trials at paddle', status });

test('passes when every specification, the extensions\' too, has a test named after it', () => {
  const run = project([origin(), settled()], { 'route.tests.ts': ['lists a refused trial', 'is empty once cancelled'] });
  assert.deepStrictEqual(run(), []);
});

test("blocks a scenario with no test, though the origin's file holds more tests than its own scenarios", () => {
  // licensing, 2026-10-07: the extensions' tests made up the count
  const run = project([origin(['lists each refused subscription']), settled()],
    { 'route.tests.ts': ['lists a refused trial', 'is empty once cancelled', 'a third extension test'] });
  const violations = run();
  assert.strictEqual(violations.length, 1);
  assert.match(violations[0].reason, /"lists each refused subscription" \("refused trials at paddle"\)/);
});

test("blocks an extension's scenario whose test is named otherwise", () => {
  const run = project([origin(), settled()], { 'route.tests.ts': ['lists a refused trial', 'drops it once cancelled'] });
  assert.match(run()[0].reason, /"is empty once cancelled" \("refused trials at paddle settled"\)/);
});

test('ignores an extension not built yet (the origin may be rebuilt first)', () => {
  const run = project([origin(), settled('Planned')], { 'route.tests.ts': ['lists a refused trial'] });
  assert.deepStrictEqual(run(), []);
});

test("counts the extension being built (InProgress), whose job adds its tests", () => {
  const run = project([origin(), settled('InProgress')], { 'route.tests.ts': ['lists a refused trial'] });
  assert.match(run()[0].reason, /"is empty once cancelled"/);
});

test('finds a title in any of the folder\'s test files, with quotes escaped', () => {
  const run = project([{ ...origin(), specs: ["lists a refused trial until Paddle confirms it's cancelled"] }],
    { 'route.tests.ts': [], 'route.integration.tests.ts': ["lists a refused trial until Paddle confirms it's cancelled"] });
  const violations = run([`${DIR}/route.integration.tests.ts`]);
  assert.deepStrictEqual(violations, []);
});

test('still counts test blocks per file', () => {
  const run = project([origin(['a second'])], { 'route.tests.ts': ['lists a refused trial', 'a second'], 'route.integration.tests.ts': ['one'] });
  const violations = run([TESTS, `${DIR}/route.integration.tests.ts`]);
  assert.strictEqual(violations.length, 1);
  assert.match(violations[0].reason, /declares 2 specification\(s\) but this test file only has 1/);
});

test('does nothing for a commit without test files', () => {
  const run = project([origin(['no test'])], { 'route.tests.ts': ['lists a refused trial'] });
  assert.deepStrictEqual(run([`${DIR}/readModel.ts`]), []);
});
