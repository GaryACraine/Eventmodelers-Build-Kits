'use strict';

// Run: node --test eventmodelers-cli/stacks/dcb/tests/checks/test-file-present.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHECK = path.resolve(__dirname, '../../templates/build-kit/lib/checks/30-test-file-present.cjs');

// Files in a scratch repo (not a git repo, so only the commit's own files count), all part of the commit
function run(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-file-present-'));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return require(CHECK).run({ repoRoot: root, changes: Object.keys(files).map((p) => ({ status: 'A', path: p })) });
}

const dir = 'src/contexts/licensing/slices/starttrial';

test('a command with an endpoint is tested through its route', () => {
  assert.deepStrictEqual(run({ [`${dir}/decider.ts`]: '', [`${dir}/route.tests.ts`]: '' }), []);
});

test('a command with no endpoint (ADR-058) is tested in-process, in decider.tests.ts', () => {
  assert.deepStrictEqual(run({ [`${dir}/decider.ts`]: '', [`${dir}/decider.tests.ts`]: '' }), []);
});

test('a read model with no endpoint is tested in-process, in readModel.tests.ts', () => {
  assert.deepStrictEqual(run({ [`${dir}/readModel.ts`]: '', [`${dir}/readModel.tests.ts`]: '' }), []);
});

test('a decider with no test file, or only the read model\'s, is refused', () => {
  assert.strictEqual(run({ [`${dir}/decider.ts`]: '' }).length, 1);
  assert.strictEqual(run({ [`${dir}/decider.ts`]: '', [`${dir}/readModel.tests.ts`]: '' }).length, 1);
});
