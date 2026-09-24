'use strict';

// Run: node --test eventmodelers-cli/stacks/dcb/tests/checks/web-scope.test.cjs
// Builds a throwaway git repo with the runner and the scope checks, stages a commit, and runs the
// pre-commit guard the way the hook does. Screen commits (web/src/slices/{slice}/) get the web checks,
// backend slice commits the backend ones.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const LIB = path.resolve(__dirname, '../../templates/build-kit/lib');
const CHECKS = ['00-blocked-paths.cjs', '10-slice-scope.cjs', '12-web-scope.cjs'];

function write(root, rel, content = 'x\n') {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-scope-'));
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: root });
  fs.mkdirSync(path.join(root, '.build-kit/lib/checks'), { recursive: true });
  fs.copyFileSync(path.join(LIB, 'check-commit-scope.cjs'), path.join(root, '.build-kit/lib/check-commit-scope.cjs'));
  for (const c of CHECKS) fs.copyFileSync(path.join(LIB, 'checks', c), path.join(root, '.build-kit/lib/checks', c));
  write(root, 'web/src/App.tsx');
  write(root, 'web/package.json', '{}\n');
  execSync('git add -A && git commit -q -m init', { cwd: root });
  return root;
}

/** Stages `files` and runs the guard like the pre-commit hook: { ok, output }. */
function commit(root, files) {
  for (const f of files) write(root, f, `// ${Math.random()}\n`);
  execSync('git add -A', { cwd: root });
  const r = spawnSync('node', ['.build-kit/lib/check-commit-scope.cjs', '--staged'], { cwd: root, encoding: 'utf8' });
  return { ok: r.status === 0, output: r.stderr };
}

const SLICE = 'web/src/slices/register-course';

test('a screen commit: its slice folder, the pages it composes and the generated types', () => {
  const r = commit(repo(), [
    `${SLICE}/RegisterCourseForm.tsx`, `${SLICE}/RegisterCourseForm.test.tsx`, `${SLICE}/handlers.ts`,
    'web/src/pages/CourseForm.tsx', 'web/src/lib/api-types.ts',
  ]);
  assert.ok(r.ok, r.output);
});

test('a screen commit changes nothing else in web/, and no backend file', () => {
  const r = commit(repo(), [`${SLICE}/Form.tsx`, `${SLICE}/Form.test.tsx`, 'web/src/App.tsx', 'web/src/lib/api.ts', 'src/index.ts']);
  assert.ok(!r.ok);
  assert.match(r.output, /web\/src\/App\.tsx — \[web-scope\] outside web\/src\/slices/);
  assert.match(r.output, /web\/src\/lib\/api\.ts — \[web-scope\]/);
  assert.match(r.output, /src\/index\.ts — \[blocked-paths\]/);
});

test('one slice per screen commit, with a test, and web/ manifests stay untouched', () => {
  const r = commit(repo(), [`${SLICE}/Form.tsx`, 'web/src/slices/course-list/List.tsx', 'web/package.json']);
  assert.ok(!r.ok);
  // the first slice by name is the commit's scope
  assert.match(r.output, /register-course\/Form\.tsx — \[web-scope\] touches the screen of slice "register-course" but this commit's scope is "course-list"/);
  assert.match(r.output, /web\/package\.json — \[blocked-paths\] dependency\/package manifest/);
  assert.match(r.output, /\[web-scope\] no \*\.test\.tsx/);
});

test('a backend slice commit never runs the web checks, and a mixed commit is split', () => {
  assert.ok(commit(repo(), ['src/contexts/enrollment/slices/register-course/route.ts']).ok);
  const mixed = commit(repo(), ['src/contexts/enrollment/slices/register-course/route.ts', `${SLICE}/Form.tsx`, `${SLICE}/Form.test.tsx`]);
  assert.ok(!mixed.ok);
  assert.match(mixed.output, /web\/src\/slices\/register-course\/Form\.tsx — \[slice-scope\] outside/);
  assert.match(mixed.output, /src\/contexts\/enrollment\/slices\/register-course\/route\.ts — \[web-scope\] outside/);
});

test('web-tests needs web/node_modules', () => {
  const root = repo();
  const check = require(path.join(LIB, 'checks/96-web-tests.cjs'));
  assert.equal(check.scope, 'web');
  const result = check.run({ repoRoot: root, changes: [{ status: 'A', path: `${SLICE}/Form.tsx` }] });
  assert.deepStrictEqual(result.map((v) => v.path), ['web/']);
  assert.match(result[0].reason, /npm install/);
});
