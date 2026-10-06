'use strict';

// Run: node --test eventmodelers-cli/stacks/dcb/tests/checks/events-append-only.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const CHECK = path.resolve(__dirname, '../../templates/build-kit/lib/checks/19-events-append-only.cjs');
const EVENTS = 'src/contexts/licensing/Events.ts';
const BEFORE = `export type UserWasAssignedToRole = Event<"userWasAssignedToRole", { organisationId: string; roleId: string }>
export type LicensingEvent =
    | UserWasAssignedToRole
`;

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'events-append-only-'));
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: root });
  fs.mkdirSync(path.join(root, 'src/contexts/licensing'), { recursive: true });
  fs.writeFileSync(path.join(root, EVENTS), BEFORE);
  execSync('git add -A && git commit -q -m init', { cwd: root });
  return root;
}
const run = (root, status = 'M') => require(CHECK).run({ repoRoot: root, changes: [{ status, path: EVENTS }] });

test('adding an event passes', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, EVENTS), BEFORE + '    | TrialWasStarted\nexport type TrialWasStarted = Event<"trialWasStarted", { organisationId: string }>\n');
  assert.deepStrictEqual(run(root), []);
});

test('changing an event (even adding an optional field) or removing one is refused', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, EVENTS), BEFORE.replace('roleId: string }', 'roleId: string; note?: string }'));
  assert.match(run(root)[0].reason, /Events\.ts only grows.*new version/);
  fs.writeFileSync(path.join(root, EVENTS), 'export type LicensingEvent = never\n');
  assert.ok(run(root).length >= 2);
});

test('deleting the file is refused; other files are not its business', () => {
  const root = repo();
  assert.match(run(root, 'D')[0].reason, /only grows/);
  assert.deepStrictEqual(require(CHECK).run({ repoRoot: root, changes: [{ status: 'M', path: 'src/index.ts' }] }), []);
});
