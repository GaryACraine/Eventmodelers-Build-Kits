'use strict';

// Run: node --test eventmodelers-cli/stacks/dcb/tests/checks/automation-scope.test.cjs
// An automation slice's commit (ADR-033): its slice folder, the workflows barrel (which only grows), an external
// system's mock and its compose service. Its workflow and activities need processor.tests.ts.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const LIB = path.resolve(__dirname, '../../templates/build-kit/lib');
const CHECKS = ['10-slice-scope.cjs', '18-workflows-append-only.cjs', '30-test-file-present.cjs'];

function write(root, rel, content = 'x\n') {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-scope-'));
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: root });
  fs.mkdirSync(path.join(root, '.build-kit/lib/checks'), { recursive: true });
  fs.copyFileSync(path.join(LIB, 'check-commit-scope.cjs'), path.join(root, '.build-kit/lib/check-commit-scope.cjs'));
  for (const c of CHECKS) fs.copyFileSync(path.join(LIB, 'checks', c), path.join(root, '.build-kit/lib/checks', c));
  write(root, 'src/workflows.ts', 'export {}\nexport { stockCount } from "./contexts/restaurant/slices/count-stock/workflow.js"\n');
  write(root, 'docker-compose.yml', 'services: {}\n');
  execSync('git add -A && git commit -q -m init', { cwd: root });
  return root;
}

/** Writes `files` ({path: content}), stages them and runs the guard like the pre-commit hook: { ok, output }. */
function commit(root, files) {
  for (const [f, content] of Object.entries(files)) write(root, f, content ?? `// ${Math.random()}\n`);
  execSync('git add -A', { cwd: root });
  const r = spawnSync('node', ['.build-kit/lib/check-commit-scope.cjs', '--staged'], { cwd: root, encoding: 'utf8' });
  return { ok: r.status === 0, output: r.stderr };
}

const SLICE = 'src/contexts/restaurant/slices/request-payment';
const EXISTING = 'export {}\nexport { stockCount } from "./contexts/restaurant/slices/count-stock/workflow.js"\n';
const ADDED = `${EXISTING}export { paymentRequest } from "./contexts/restaurant/slices/request-payment/workflow.js"\n`;

test('an external automation: its slice, a new workflows.ts line, its mock and the mock\'s compose service', () => {
  const r = commit(repo(), {
    [`${SLICE}/processor.ts`]: null,
    [`${SLICE}/workflow.ts`]: null,
    [`${SLICE}/activities.ts`]: null,
    [`${SLICE}/processor.tests.ts`]: null,
    'src/workflows.ts': ADDED,
    'src/index.ts': null,
    'mocks/braintree/server.ts': null,
    'mocks/braintree/Dockerfile': null,
    'docker-compose.yml': 'services:\n  braintree:\n    build: mocks/braintree\n',
  });
  assert.ok(r.ok, r.output);
});

test('workflows.ts only grows: changing another slice\'s line is refused', () => {
  const r = commit(repo(), {
    [`${SLICE}/processor.ts`]: null,
    [`${SLICE}/processor.tests.ts`]: null,
    'src/workflows.ts': 'export {}\nexport { paymentRequest } from "./contexts/restaurant/slices/request-payment/workflow.js"\n',
  });
  assert.ok(!r.ok);
  assert.match(r.output, /workflows\.ts only grows/);
});

test('a workflow and activities without processor.tests.ts are refused', () => {
  const r = commit(repo(), { [`${SLICE}/workflow.ts`]: null, [`${SLICE}/activities.ts`]: null });
  assert.ok(!r.ok);
  assert.match(r.output, /no \*\.tests\.ts found/);
});

test('an external event\'s slice: its folder and the provider\'s shared module (src/providers/{system}/, ADR-045)', () => {
  const inbox = 'src/contexts/licensing/slices/paddle-notification-received';
  const r = commit(repo(), {
    [`${inbox}/inbox.ts`]: null,
    [`${inbox}/inbox.tests.ts`]: null,
    'src/providers/paddle/paddle.ts': null,
  });
  assert.ok(r.ok, r.output);
  const loose = commit(repo(), { [`${inbox}/inbox.ts`]: null, [`${inbox}/inbox.tests.ts`]: null, 'src/providers/index.ts': null });
  assert.ok(!loose.ok);
  assert.match(loose.output, /src\/providers\/index\.ts/);
});

test('other shared files are still outside a slice commit\'s scope', () => {
  const r = commit(repo(), {
    [`${SLICE}/processor.ts`]: null,
    [`${SLICE}/processor.tests.ts`]: null,
    'src/shared/automations.ts': null,
  });
  assert.ok(!r.ok);
  assert.match(r.output, /src\/shared\/automations\.ts/);
});
