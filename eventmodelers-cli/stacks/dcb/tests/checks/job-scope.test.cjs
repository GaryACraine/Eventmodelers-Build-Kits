'use strict';

// Run: node --test eventmodelers-cli/stacks/dcb/tests/checks/job-scope.test.cjs
// Builds a throwaway git repo with the kit layout (.build-kit/.slices + two built slices), marks a job InProgress,
// makes changes, and runs the job-scope check against them.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const KIT = path.resolve(__dirname, '../../../..');
const CHECK_SRC = path.join(KIT, 'stacks/dcb/templates/build-kit/lib/checks/11-job-scope.cjs');
const UTIL_SRC = path.join(KIT, 'shared/build-kit/lib/util');

const SLICES = 'src/contexts/licensing/slices';
const JOB = `${SLICES}/assignorganisationowner`;
const OTHER = `${SLICES}/owneronactivation`;
const ORIGIN = `${SLICES}/organisationoverview`;

function write(root, rel, content = 'x\n') {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

function repo({ concerns = { backend: { status: 'InProgress' } }, status, extendsOrigin = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-scope-'));
  const sh = (cmd) => execSync(cmd, { cwd: root, stdio: 'pipe' });
  sh('git init -q && git config user.email t@t && git config user.name t');
  for (const dir of [JOB, OTHER, ORIGIN]) write(root, `${dir}/route.ts`);
  write(root, 'src/contexts/licensing/Events.ts');
  write(root, '.gitignore', '.build-kit/\nlib/\n');
  sh('git add -A && git commit -q -m init');

  const entry = { id: 'a1', slice: 'assign organisation owner', folder: 'assignorganisationowner', status: status ?? 'InProgress' };
  if (concerns) entry.concerns = concerns;
  write(root, '.build-kit/.slices/current_context.json', JSON.stringify({ name: 'licensing' }));
  write(root, '.build-kit/.slices/licensing/index.json', JSON.stringify({ slices: [entry] }));
  write(root, '.build-kit/.slices/licensing/assignorganisationowner/slice.json', JSON.stringify({
    id: 'a1',
    title: 'assign organisation owner',
    ...(extendsOrigin ? { extends: { originContext: 'licensing', originSliceTitle: 'organisation overview' } } : {}),
  }));
  fs.mkdirSync(path.join(root, 'lib/checks'), { recursive: true });
  fs.cpSync(UTIL_SRC, path.join(root, 'lib/util'), { recursive: true });
  fs.copyFileSync(CHECK_SRC, path.join(root, 'lib/checks/11-job-scope.cjs'));
  return root;
}

// Changes `staged` (the commit) and `dirty` (left in the working tree) files, then runs the check on the commit.
function run(root, { staged = [], dirty = [] } = {}) {
  for (const p of [...staged, ...dirty]) write(root, p, `changed ${p}\n`);
  if (staged.length) execSync(`git add ${staged.join(' ')}`, { cwd: root });
  const check = require(path.join(root, 'lib/checks/11-job-scope.cjs'));
  return check.run({ repoRoot: root, changes: staged.map((p) => ({ status: 'M', path: p })) });
}

test("the job's own folder passes", () => {
  assert.deepStrictEqual(run(repo(), { staged: [`${JOB}/route.ts`, `${JOB}/decider.ts`] }), []);
});

test('another slice in the commit is refused', () => {
  const v = run(repo(), { staged: [`${OTHER}/route.ts`] });
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].path, `${OTHER}/route.ts`);
  assert.match(v[0].reason, /"assign organisation owner"; "owneronactivation" is another slice/);
});

test('another slice changed but left uncommitted is refused too', () => {
  const v = run(repo(), { staged: [`${JOB}/route.ts`], dirty: [`${OTHER}/route.ts`] });
  assert.deepStrictEqual(v.map((x) => x.path), [`${OTHER}/route.ts`]);
});

test("an extension's origin passes", () => {
  assert.deepStrictEqual(run(repo({ extendsOrigin: true }), { staged: [`${ORIGIN}/route.ts`] }), []);
  assert.strictEqual(run(repo(), { staged: [`${ORIGIN}/route.ts`] }).length, 1);
});

test('shared files outside the slices pass (their own checks hold them)', () => {
  const staged = ['src/contexts/licensing/Events.ts', 'src/providers/paddle/client.ts', `${JOB}/route.ts`];
  assert.deepStrictEqual(run(repo(), { staged }), []);
});

test('an entry without concerns uses its status', () => {
  assert.strictEqual(run(repo({ concerns: null }), { staged: [`${OTHER}/route.ts`] }).length, 1);
});

test('does nothing when no backend job is in progress', () => {
  assert.deepStrictEqual(run(repo({ concerns: { backend: { status: 'Done' } }, status: 'Done' }), { staged: [`${OTHER}/route.ts`] }), []);
  assert.deepStrictEqual(run(repo({ concerns: { backend: { status: 'Done' }, ui: { status: 'InProgress' } } }), { staged: [`${OTHER}/route.ts`] }), []);
});
