'use strict';

// Run: node --test eventmodelers-cli/stacks/dcb/tests/checks/security-audit.test.cjs
// The security audit (ADR-063): advisories in what runs and in the tooling, lockfiles, the sign-in path's pins and
// exact image versions. npm is a stand-in here, answering from each package's fixture, so no test needs the network.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const AUDIT = path.resolve(__dirname, '../../templates/build-kit/lib/security-audit.cjs');
const SCAFFOLD = path.resolve(__dirname, '../../templates/root');

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

// The stand-in for npm: answers `npm audit --json [--omit=dev]` from .audit.json in the folder it runs in
const FAKE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-npm-')), 'npm');
fs.writeFileSync(
  FAKE,
  `#!/usr/bin/env node
const fs = require('fs');
if (!fs.existsSync('.audit.json')) { console.log(JSON.stringify({ vulnerabilities: {} })); process.exit(0) }
const fixture = JSON.parse(fs.readFileSync('.audit.json', 'utf8'));
if (fixture.fail) { console.error(fixture.fail); process.exit(1) }
const runtime = process.argv.includes('--omit=dev');
const vulnerabilities = {};
for (const a of fixture.advisories ?? []) {
  if (runtime && a.dev) continue;
  vulnerabilities[a.package] = { severity: a.severity, via: [{ source: 1, url: 'https://github.com/advisories/' + a.id, severity: a.severity, title: a.title }] };
}
console.log(JSON.stringify({ vulnerabilities }));
process.exit(Object.keys(vulnerabilities).length ? 1 : 0);
`,
  { mode: 0o755 }
);

const advisory = (id, pkg, severity, extra = {}) => ({ id, package: pkg, severity, title: `${pkg} is unsafe`, ...extra });

/** A project like the scaffold: the backend, the sign-in service and the web app, each locked, images exact */
function project({ advisories = {}, exceptions, files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'security-audit-'));
  const pkg = (where, deps = {}) => {
    write(root, `${where}/package.json`, { name: where, dependencies: deps });
    write(root, `${where}/package-lock.json`, '{}');
    if (advisories[where]) write(root, `${where}/.audit.json`, { advisories: advisories[where] });
  };
  pkg('.', { express: '^5.1.0' });
  pkg('auth', { 'better-auth': '1.7.7', '@better-auth/passkey': '1.7.7' });
  pkg('web', { 'better-auth': '1.7.7', '@better-auth/passkey': '1.7.7' });
  write(root, 'docker-compose.yml', 'services:\n  postgres:\n    image: postgres:18.6\n  mail:\n    image: axllent/mailpit:v1.31.4\n');
  write(root, 'auth/Dockerfile', 'FROM node:24.21.0-alpine AS build\nRUN npm ci\nFROM build AS again\nFROM node:24.21.0-alpine\n');
  if (exceptions) write(root, 'security/audit-exceptions.json', exceptions);
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) fs.rmSync(path.join(root, rel));
    else write(root, rel, content);
  }
  return root;
}

const run = (root, ...args) => spawnSync('node', [AUDIT, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, SECURITY_AUDIT_NPM: FAKE } });

test('nothing known and everything held still: no warning, and the release gate passes', () => {
  const r = run(project(), '--strict');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /3 packages; what runs: 0 advisories \(0 high or critical\); tooling: 0; accepted: 0; 0 warning/);
  assert.strictEqual(r.stderr, '');
});

test('a high advisory in what runs: listed under what runs, and the release gate fails (warn only without --strict)', () => {
  const root = project({ advisories: { auth: [advisory('GHSA-aaaa-bbbb-cccc', 'better-auth', 'high')] } });
  const r = run(root, '--strict');
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /what runs:\n {2}high better-auth \(auth\) GHSA-aaaa-bbbb-cccc: better-auth is unsafe/);
  assert.match(r.stdout, /what runs: 1 advisories \(1 high or critical\)/);
  assert.strictEqual(run(root).status, 0);
});

test('a moderate advisory in what runs is listed, but doesn\'t fail the gate', () => {
  const r = run(project({ advisories: { web: [advisory('GHSA-mmmm-mmmm-mmmm', 'uuid', 'moderate')] } }), '--strict');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /what runs: 1 advisories \(0 high or critical\)/);
});

test('an advisory only in dev dependencies, or anywhere under e2e/, is tooling: reported, not the gate', () => {
  const root = project({
    advisories: { '.': [advisory('GHSA-dddd-dddd-dddd', 'tinypool', 'critical', { dev: true })], 'e2e/journey': [advisory('GHSA-eeee-eeee-eeee', 'undici', 'high')] },
    files: { 'e2e/journey/package.json': '{"name":"journey"}', 'e2e/journey/package-lock.json': '{}' }
  });
  write(root, 'e2e/journey/.audit.json', { advisories: [advisory('GHSA-eeee-eeee-eeee', 'undici', 'high')] });
  const r = run(root, '--strict');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /tooling:\n {2}critical tinypool \(\.\) GHSA-dddd-dddd-dddd/);
  assert.match(r.stdout, /high undici \(e2e\/journey\) GHSA-eeee-eeee-eeee/);
  assert.match(r.stdout, /what runs: 0 advisories .* tooling: 2/);
});

test('a package without a lockfile is a warning: it can\'t be audited', () => {
  const r = run(project({ files: { 'web/package-lock.json': null } }), '--strict');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /warning: web: no package-lock.json, so it can't be audited and every install resolves afresh/);
});

test('npm audit failing (no network) is a warning, never a silent pass', () => {
  const root = project();
  write(root, 'auth/.audit.json', { fail: 'getaddrinfo ENOTFOUND registry.npmjs.org' });
  const r = run(root, '--strict');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /warning: auth: npm audit failed \(getaddrinfo ENOTFOUND registry.npmjs.org\)/);
});

test('the sign-in path: a range, or two versions of better-auth\'s packages, is a warning', () => {
  const ranged = run(project({ files: { 'web/package.json': { dependencies: { 'better-auth': '^1.7.7', '@better-auth/passkey': '1.7.7' } } } }));
  assert.match(ranged.stderr, /web\/package.json: better-auth is "\^1.7.7", not an exact version/);
  const apart = run(project({ files: { 'web/package.json': { dependencies: { 'better-auth': '1.7.6', '@better-auth/passkey': '1.7.7' } } } }));
  assert.match(apart.stderr, /better-auth's packages aren't one version: .*web: better-auth 1.7.6/);
});

test('an image without an exact version is a warning; a digest, a v-tag and a build stage are fine', () => {
  const root = project({
    files: {
      'docker-compose.yml': 'services:\n  a:\n    image: postgres:18\n  b:\n    image: redis\n  c:\n    image: "nginx@sha256:' + 'a'.repeat(64) + '"\n  d:\n    image: axllent/mailpit:v1.31.4\n',
      'mocks/x/Dockerfile': 'FROM node:24-alpine\n'
    }
  });
  const r = run(root);
  assert.match(r.stderr, /docker-compose.yml: image postgres:18 isn't an exact version/);
  assert.match(r.stderr, /docker-compose.yml: image redis isn't an exact version/);
  assert.match(r.stderr, /mocks\/x\/Dockerfile: FROM node:24-alpine isn't an exact version/);
  assert.doesNotMatch(r.stderr, /nginx|mailpit|FROM build|auth\/Dockerfile/);
  assert.match(r.stdout, /3 warning/);
});

test('an accepted advisory is listed as accepted, and counts again after its review date', () => {
  const advisories = { web: [advisory('GHSA-vfj7-8cjw-p6xm', 'braces', 'high')] };
  const accept = (review) => [{ advisory: 'GHSA-vfj7-8cjw-p6xm', package: 'braces', where: 'web', reason: 'no fixed version; build tooling only', review }];
  const current = run(project({ advisories, exceptions: accept('2999-01-01') }), '--strict');
  assert.strictEqual(current.status, 0, current.stderr);
  assert.match(current.stdout, /accepted \(security\/audit-exceptions.json\):\n {2}high braces \(web\)/);
  assert.match(current.stdout, /what runs: 0 advisories .* accepted: 1; 0 warning/);
  const lapsed = run(project({ advisories, exceptions: accept('2020-01-01') }), '--strict');
  assert.strictEqual(lapsed.status, 1);
  assert.match(lapsed.stderr, /GHSA-vfj7-8cjw-p6xm \(braces\) was due for review on 2020-01-01, so it counts again/);
  assert.match(lapsed.stdout, /what runs:\n {2}high braces \(web\)/);
  const elsewhere = run(project({ advisories: { auth: advisories.web }, exceptions: accept('2999-01-01') }), '--strict');
  assert.strictEqual(elsewhere.status, 1, 'accepted for the web app, not for the sign-in service');
  assert.match(elsewhere.stdout, /what runs:\n {2}high braces \(auth\)/);
  const noReason = run(project({ advisories, exceptions: [{ advisory: 'GHSA-vfj7-8cjw-p6xm', review: '2999-01-01' }] }));
  assert.match(noReason.stderr, /needs an advisory, a reason and a review date/);
});

test('the scaffold holds still: its images and the sign-in path\'s pins pass, and it has the script', () => {
  const r = run(SCAFFOLD);
  const held = r.stderr.split('\n').filter((line) => /exact version|one version/.test(line));
  assert.deepStrictEqual(held, []);
  for (const where of ['auth', 'web']) assert.ok(fs.existsSync(path.join(SCAFFOLD, where, 'package-lock.json')), `${where} ships its lockfile`);
  const scripts = JSON.parse(fs.readFileSync(path.join(SCAFFOLD, 'package.json'), 'utf8')).scripts;
  assert.strictEqual(scripts['security:audit'], 'node .build-kit/lib/security-audit.cjs');
});
