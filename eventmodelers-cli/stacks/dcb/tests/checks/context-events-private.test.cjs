'use strict';

// Run: node --test eventmodelers-cli/stacks/dcb/tests/checks/context-events-private.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHECK = path.resolve(__dirname, '../../templates/build-kit/lib/checks/21-context-events-private.cjs');

function run(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-events-private-'));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return require(CHECK).run({ repoRoot: root, changes: Object.keys(files).map((p) => ({ status: 'A', path: p })) });
}

test("a slice importing its own context's events passes", () => {
  assert.deepStrictEqual(run({
    'src/contexts/licensing/slices/activateorganisation/decider.ts': 'import { organisationWasActivated } from "../../Events.js"\n',
  }), []);
});

test("a slice or a re-export importing another context's events is refused", () => {
  const violations = run({
    'src/contexts/licensing/slices/activateorganisation/route.tests.ts':
      'import { userWasRegistered } from "../../../identity/Events.js"\n',
    'src/contexts/licensing/Events.ts': 'export { userWasRegistered, type UserWasRegisteredEvent } from "../identity/Events.js"\n',
  });
  assert.strictEqual(violations.length, 2);
  assert.match(violations[0].reason, /identity's events.*ADR-059/);
});

test("another context's published read model, and code outside the contexts, pass", () => {
  assert.deepStrictEqual(run({
    'src/contexts/licensing/slices/x/route.ts': 'import { myAccount } from "../../../identity/slices/myaccount/readModel.js"\n',
    'src/index.ts': 'import { userWasRegistered } from "./contexts/identity/Events.js"\n',
  }), []);
});

test("another context's published events (Published.ts) pass; its Events.ts still doesn't (ADR-073)", () => {
  assert.deepStrictEqual(run({
    'src/contexts/licensing/slices/organisationoverview/readModel.ts':
      'import { type UserContactDetailsWereUpdatedEvent } from "../../../identity/Published.js"\n',
    'src/contexts/identity/Events.ts': 'export { userContactDetailsWereUpdated } from "./Published.js"\n',
  }), []);
  const violations = run({
    'src/contexts/licensing/slices/organisationoverview/readModel.ts': 'import { userEmailWasChanged } from "../../../identity/Events.js"\n',
  });
  assert.match(violations[0].reason, /identity\/Published\.ts \(ADR-073\)/);
});

test("Published.ts never imports its own context's Events (ADR-073)", () => {
  const violations = run({
    'src/contexts/identity/Published.ts': 'export { userWasRegistered } from "./Events.js"\n',
  });
  assert.strictEqual(violations.length, 1);
  assert.match(violations[0].reason, /holds only the published events/);
});
