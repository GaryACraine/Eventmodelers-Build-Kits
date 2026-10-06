'use strict';

// Run: node --test eventmodelers-cli/stacks/dcb/tests/checks/slice-scope-rename.test.cjs
// A rebuild that renames a command (ADR-046) may update the slices that call it, only by that rename.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const CHECK_SRC = path.resolve(__dirname, '../../templates/build-kit/lib/checks/10-slice-scope.cjs');
const OWN = 'src/contexts/licensing/slices/assignownerrole';
const CALLER = 'src/contexts/licensing/slices/ownerroleonactivation';
const PROCESSOR = `import { assignRoleDecider } from "../assignownerrole/decider.js"

export const ownerRole = defineAutomation({
    act: async ({ item, issue }) =>
        issue(assignRoleDecider, {
            type: "assignRole",
            data: { organisationId: item.organisationId }
        })
})
`;

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

function repo({ status = 'InProgress', changes = ['assignOwnerRole: new', 'assignRole: removed', 'scenario added: "x"'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-scope-rename-'));
  const sh = (cmd) => execSync(cmd, { cwd: root, stdio: 'pipe' });
  sh('git init -q && git config user.email t@t && git config user.name t');
  write(root, `${OWN}/decider.ts`, 'export const assignRoleDecider = {}\n');
  write(root, `${CALLER}/processor.ts`, PROCESSOR);
  sh('git add -A && git commit -q -m init');
  write(root, '.build-kit/.slices/current_context.json', JSON.stringify({ name: 'licensing' }));
  write(root, '.build-kit/.slices/licensing/index.json', JSON.stringify({ slices: [{ id: 'a', folder: 'assignownerrole', status }] }));
  write(root, '.build-kit/.slices/licensing/assignownerrole/slice.json', JSON.stringify({ id: 'a', title: 'assign owner role', ...(changes ? { rebuild: { from: 'v2-x', changes } } : {}) }));
  write(root, `${OWN}/decider.ts`, 'export const assignOwnerRoleDecider = {}\n');
  return root;
}

function run(root) {
  delete require.cache[CHECK_SRC];
  const check = require(CHECK_SRC);
  return check.run({ repoRoot: root, changes: [{ status: 'M', path: `${OWN}/decider.ts` }, { status: 'M', path: `${CALLER}/processor.ts` }] });
}

const renamed = PROCESSOR.split('assignRole').join('assignOwnerRole');

test('a renaming rebuild may update a caller by the rename only', () => {
  const root = repo();
  write(root, `${CALLER}/processor.ts`, renamed);
  assert.deepStrictEqual(run(root), []);
});

test("a caller's test may follow the route's rename too", () => {
  const root = repo();
  write(root, `${CALLER}/processor.ts`, renamed + '        .post("/assign-role")\n');
  execSync('git add -A && git commit -q -m tests', { cwd: root, stdio: 'pipe' });
  write(root, `${OWN}/decider.ts`, 'export const assignOwnerRoleDecider = {}\n// rebuilt\n');
  write(root, `${CALLER}/processor.ts`, renamed + '        .post("/assign-owner-role")\n');
  assert.deepStrictEqual(run(root), []);
});

test('anything else in the caller is still refused', () => {
  const root = repo();
  write(root, `${CALLER}/processor.ts`, renamed.replace('item.organisationId', 'item.other'));
  assert.match(run(root)[0].reason, /touches slice "licensing\/ownerroleonactivation"/);
});

test('a rebuild with no rename, or no rebuild in progress, keeps one slice per commit', () => {
  for (const options of [{ changes: ['scenario added: "x"'] }, { changes: null }, { status: 'Done' }]) {
    const root = repo(options);
    write(root, `${CALLER}/processor.ts`, renamed);
    assert.strictEqual(run(root).length, 1, JSON.stringify(options));
  }
});
