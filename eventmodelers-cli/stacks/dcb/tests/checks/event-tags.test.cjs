'use strict';

// Run: node --test eventmodelers-cli/stacks/dcb/tests/checks/event-tags.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const CHECK = path.resolve(__dirname, '../../templates/build-kit/lib/checks/22-event-tags.cjs');
const EVENTS = 'src/contexts/licensing/Events.ts';
const factory = (name, tags) => `export const ${name} = (d: any): TaggedEvent<any> => ({
    event: { type: "${name}", data: d },
    tags: Tags.fromObj({ ${tags} })
})
`;
const BEFORE = factory('seatWasAssigned', 'organisationId');

function repo(eventTags) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'event-tags-'));
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: root });
  fs.mkdirSync(path.join(root, 'src/contexts/licensing'), { recursive: true });
  fs.writeFileSync(path.join(root, EVENTS), BEFORE);
  fs.mkdirSync(path.join(root, '.build-kit/.slices/licensing/removemember'), { recursive: true });
  fs.writeFileSync(path.join(root, '.build-kit/.slices/licensing/removemember/slice.json'), JSON.stringify({
    events: [
      { title: 'seatWasReleased', eventTags },
      { title: 'seatWasAssigned', eventTags: [{ key: 'organisationId' }, { key: 'userId' }] },
    ],
  }));
  execSync('git add -A && git commit -q -m init', { cwd: root });
  return root;
}
const run = (root) => require(CHECK).run({ repoRoot: root, changes: [{ status: 'M', path: EVENTS }] });
const add = (root, text) => fs.writeFileSync(path.join(root, EVENTS), BEFORE + text);

test('a new factory with exactly the model\'s tags passes', () => {
  const root = repo([{ key: 'organisationId' }, { key: 'userId' }]);
  add(root, factory('seatWasReleased', 'organisationId, userId'));
  assert.deepStrictEqual(run(root), []);
});

test('a new factory missing a tag, or adding one, is refused', () => {
  const root = repo([{ key: 'organisationId' }, { key: 'userId' }]);
  add(root, factory('seatWasReleased', 'organisationId'));
  assert.match(run(root)[0].reason, /seatWasReleased is tagged organisationId, but the model's eventTags are organisationId, userId/);
  add(root, factory('seatWasReleased', 'organisationId, userId, seatType'));
  assert.equal(run(root).length, 1);
});

test('a conditional tag is refused, whatever the model says: every tag is always present', () => {
  const root = repo([{ key: 'organisationId' }, { key: 'paddleEventId' }]);
  add(root, factory('seatWasReleased', 'organisationId, ...(d.paddleEventId ? { paddleEventId: d.paddleEventId } : {})'));
  assert.match(run(root)[0].reason, /seatWasReleased tags paddleEventId only when present: every tag is always present/);
  add(root, factory('seatWasReleased', 'organisationId, paddleEventId'));
  assert.deepStrictEqual(run(root), []);
});

test('an existing factory is left alone (its tags change only by a deliberate change), and an event the model gives no tags isn\'t checked', () => {
  const root = repo([{ key: 'organisationId' }, { key: 'userId' }]);
  // seatWasAssigned differs from the model's tags, but it was there before this commit
  add(root, factory('somethingOld', 'whatever'))
  assert.deepStrictEqual(run(root), []);
});
