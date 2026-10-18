'use strict';

// Run: node --test eventmodelers-cli/stacks/dcb/tests/checks/published-lookup-refresh.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHECK = path.resolve(__dirname, '../../templates/build-kit/lib/checks/24-published-lookup-refresh.cjs');
const RM = 'src/contexts/licensing/slices/organisationoverview/readModel.ts';
const PUBLISHED = `export const userContactDetailsWereUpdated = (d: any) => ({
    event: { type: "userContactDetailsWereUpdated", data: d },
    tags: Tags.fromObj({ userId: d.userId })
})
`;
const lookup = (extra = '') => `export const organisationOverview = defineReadModel({
    lookups: {
        contacts: {
            key: "userId",
            canHandle: ["userContactDetailsWereUpdated"],
            evolve: (_, { event }) => ({ email: event.data.email }),${extra}
        }
    },
})
`;

function repo(readModel, { publishedIn = 'identity' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'published-lookup-'));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write(`src/contexts/${publishedIn}/Published.ts`, PUBLISHED);
  write(RM, readModel);
  return root;
}
const run = (root, status = 'M') => require(CHECK).run({ repoRoot: root, changes: [{ status, path: RM }] });

test('a lookup on another context\'s published event without refresh is refused', () => {
  const v = run(repo(lookup()));
  assert.equal(v.length, 1);
  assert.match(v[0].reason, /folds identity's published event userContactDetailsWereUpdated in a lookup without `refresh`/);
});

test('with refresh it passes', () => {
  assert.deepStrictEqual(run(repo(lookup('\n            refresh: (doc, userId, entry) => doc'))), []);
});

test('the context\'s own published event, a read model not naming it, and a deleted file are left alone', () => {
  assert.deepStrictEqual(run(repo(lookup(), { publishedIn: 'licensing' })), []);
  assert.deepStrictEqual(run(repo(lookup().replace(/userContactDetailsWereUpdated/g, 'organisationWasActivated'))), []);
  assert.deepStrictEqual(run(repo(lookup()), 'D'), []);
});
