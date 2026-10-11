'use strict';

// Run: node --test eventmodelers-cli/stacks/dcb/tests/checks/security-evidence.test.cjs
// The security evidence check (ADR-056 D14): it warns, never blocks, when a policy names no test or names one that
// doesn't exist; `record` keeps a run as it happened.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const CHECK = path.resolve(__dirname, '../../templates/build-kit/lib/security-evidence.cjs');
const SCAFFOLD = path.resolve(__dirname, '../../templates/root');

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

/** A project with one policy, proved by one test that exists */
function project(evidenceRows = '| AC-1 | `src/a.tests.ts` "refuses a stranger" | 2026-01-01 PASS, [log](results/2026-01-01-unit.log) |') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'security-evidence-'));
  write(root, 'SECURITY.md', '# Security\n');
  write(root, 'security/POLICY.md', '| ID | Policy |\n|---|---|\n| AC-1 | Strangers are refused |\n');
  write(root, 'security/EVIDENCE.md', `| ID | Proved by | Last run |\n|---|---|---|\n${evidenceRows}\n`);
  write(root, 'security/results/2026-01-01-unit.log', 'exit: 0\n');
  write(root, 'src/a.tests.ts', 'test("refuses a stranger", () => {})\n');
  return root;
}

const run = (root, ...args) => spawnSync('node', [CHECK, ...args], { cwd: root, encoding: 'utf8' });

test('a policy proved by a test that exists, with a recorded run: no warning', () => {
  const r = run(project());
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /1 policies, 1 proved by tests that exist, 1 with a recorded run; 0 warning/);
  assert.strictEqual(r.stderr, '');
});

test("a test's name that isn't in its file, a file that doesn't exist, and a missing run: warned, not blocked", () => {
  const root = project(
    '| AC-1 | `src/a.tests.ts` "refuses everyone"; `src/gone.tests.ts` | [log](results/2026-10-12-unit.log) |'
  );
  const r = run(root);
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /AC-1 names "refuses everyone", which isn't in src\/a.tests.ts/);
  assert.match(r.stderr, /AC-1 names src\/gone.tests.ts, which doesn't exist/);
  assert.match(r.stderr, /AC-1's last run links to results\/2026-10-12-unit.log, which doesn't exist/);
  assert.match(r.stdout, /0 proved by tests that exist, 0 with a recorded run; 3 warning/);
});

test('a policy with no evidence row, a row naming nothing, and a row for no policy are warned', () => {
  const root = project('| AC-1 | checked somehow | — |\n| AC-9 | `src/a.tests.ts` | — |');
  write(root, 'security/POLICY.md', '| ID | Policy |\n|---|---|\n| AC-1 | Strangers are refused |\n| AS-1 | Sessions record how they signed in |\n');
  const r = run(root);
  assert.match(r.stderr, /a row for AC-1 names no test/);
  assert.match(r.stderr, /AC-9 isn't a policy in POLICY.md/);
  assert.match(r.stderr, /POLICY.md: AS-1 names no test/);
});

test('--strict fails on a warning, for CI', () => {
  const root = project();
  fs.rmSync(path.join(root, 'SECURITY.md'));
  assert.strictEqual(run(root).status, 0);
  const r = run(root, '--strict');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /SECURITY.md is missing/);
});

test('a project without security/ is told what is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'security-evidence-'));
  const r = run(root);
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /security\/POLICY.md is missing/);
  assert.match(r.stderr, /security\/EVIDENCE.md is missing/);
});

test("record keeps the run's output with its date, commit, command and exit code, and exits with its code", () => {
  const root = project();
  const passed = run(root, 'record', 'unit', '--', 'echo', 'all 3 passed');
  assert.strictEqual(passed.status, 0);
  const day = new Date().toISOString().slice(0, 10);
  const log = fs.readFileSync(path.join(root, `security/results/${day}-unit.log`), 'utf8');
  assert.match(log, /^# unit\ndate: \d{4}-\d\d-\d\dT/);
  assert.match(log, /commit: none\ncommand: echo all 3 passed\n\nall 3 passed\n\nexit: 0\n$/);

  const failed = run(root, 'record', 'e2e', '--', 'printf "\\033[31mfailed\\033[0m\\n"; exit 3');
  assert.strictEqual(failed.status, 3);
  assert.match(fs.readFileSync(path.join(root, `security/results/${day}-e2e.log`), 'utf8'), /\nfailed\n\nexit: 3\n$/);
});

test('record names the commit, and says when what was tested has uncommitted changes; earlier logs are not such a change', () => {
  const root = project();
  execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -q -m init', { cwd: root });
  const sha = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim();
  const day = new Date().toISOString().slice(0, 10);
  const log = (name) => fs.readFileSync(path.join(root, `security/results/${day}-${name}.log`), 'utf8');
  run(root, 'record', 'first', '--', 'true');
  run(root, 'record', 'second', '--', 'true');
  assert.match(log('second'), new RegExp(`\\ncommit: ${sha}\\n`));
  write(root, 'src/a.tests.ts', 'test("changed", () => {})\n');
  run(root, 'record', 'third', '--', 'true');
  assert.match(log('third'), new RegExp(`\\ncommit: ${sha} \\(with uncommitted changes\\)\\n`));
});

test('record never replaces a run: the same name again that day is numbered', () => {
  const root = project();
  const day = new Date().toISOString().slice(0, 10);
  run(root, 'record', 'api', '--', 'echo failed; exit 1');
  run(root, 'record', 'api', '--', 'echo passed');
  run(root, 'record', 'api', '--', 'echo passed again');
  const log = (file) => fs.readFileSync(path.join(root, 'security/results', file), 'utf8');
  assert.match(log(`${day}-api.log`), /\nfailed\n\nexit: 1\n$/);
  assert.match(log(`${day}-api-2.log`), /\npassed\n\nexit: 0\n$/);
  assert.match(log(`${day}-api-3.log`), /\npassed again\n/);
});

test('record refuses a name that would make a strange file', () => {
  const r = run(project(), 'record', '../escape', '--', 'true');
  assert.strictEqual(r.status, 2);
});

test("the kit's scaffold: every policy names tests that exist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'security-scaffold-'));
  fs.cpSync(SCAFFOLD, root, { recursive: true, filter: (src) => !src.includes('node_modules') });
  fs.mkdirSync(path.join(root, '.build-kit/lib/checks'), { recursive: true });
  fs.cpSync(path.resolve(__dirname, '../../templates/build-kit/lib/checks'), path.join(root, '.build-kit/lib/checks'), { recursive: true });
  const r = run(root, '--strict');
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /24 policies, 24 proved by tests that exist/);
});
