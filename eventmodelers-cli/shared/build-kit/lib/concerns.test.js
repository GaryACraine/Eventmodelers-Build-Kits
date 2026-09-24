// node --test shared/build-kit/lib/concerns.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concernsOf, deriveStatus, inProgressConcerns, nextWork, setConcernStatus, settleEntries } from './concerns.js';

const entry = (id, concerns, extra = {}) => ({ id, slice: id, status: deriveStatus(concerns, 'Created'), concerns, definition: { id, status: deriveStatus(concerns, 'Created') }, ...extra });

test('an entry without concerns is one backend concern: the whole slice', () => {
  assert.deepEqual(concernsOf({ id: 'a', status: 'Planned' }), { backend: { status: 'Planned' } });
});

test('the slice status follows its concerns', () => {
  assert.equal(deriveStatus({ backend: { status: 'Done' }, ui: { status: 'Blocked' } }), 'Blocked');
  assert.equal(deriveStatus({ backend: { status: 'InProgress' }, ui: { status: 'Planned' } }), 'InProgress');
  assert.equal(deriveStatus({ backend: { status: 'Done' }, ui: { status: 'Planned' } }), 'Planned');
  assert.equal(deriveStatus({ backend: { status: 'Done' }, ui: { status: 'Done' } }), 'Done');
  assert.equal(deriveStatus({}, 'Created'), 'Created');
});

test('the next job: a Planned backend, or a Planned UI once its backend is Done, in timeline order', () => {
  const entries = [
    entry('a', { backend: { status: 'Done' }, ui: { status: 'Done' } }),
    entry('b', { backend: { status: 'Planned' }, ui: { status: 'Planned' } }),
    entry('c', { backend: { status: 'Done' }, ui: { status: 'Planned' } }),
  ];
  assert.deepEqual(nextWork(entries), { id: 'b', title: 'b', concern: 'backend' });
  entries[1].concerns.backend.status = 'Done';
  assert.deepEqual(nextWork(entries), { id: 'b', title: 'b', concern: 'ui' });
  // a UI never goes before its backend; a blocked backend leaves its UI waiting, and the loop moves on
  entries[1].concerns.backend.status = 'Blocked';
  assert.deepEqual(nextWork(entries), { id: 'c', title: 'c', concern: 'ui' });
  // a UI-only slice (no backend concern) can go
  assert.deepEqual(nextWork([entry('d', { ui: { status: 'Planned' } })]), { id: 'd', title: 'd', concern: 'ui' });
  // an entry from before concerns: the whole slice
  assert.deepEqual(nextWork([{ id: 'e', slice: 'e', status: 'Planned' }]), { id: 'e', title: 'e', concern: 'backend' });
  assert.equal(nextWork([entry('f', { backend: { status: 'Done' } })]), null);
});

test('setting one concern updates it, the derived status and the definition; leaving Blocked drops the record', () => {
  const e = entry('a', { backend: { status: 'Done' }, ui: { status: 'Planned' } });
  assert.equal(setConcernStatus(e, 'ui', 'InProgress'), 'InProgress');
  assert.equal(setConcernStatus(e, 'ui', 'Blocked', { blockedReason: 'web-tests failed', blockedAt: 't' }), 'Blocked');
  assert.equal(e.definition.status, 'Blocked');
  assert.deepEqual(e.concerns.backend, { status: 'Done' });
  assert.equal(setConcernStatus(e, 'ui', 'Planned'), 'Planned');
  assert.deepEqual(e.concerns.ui, { status: 'Planned' });
  const legacy = { id: 'b', status: 'Planned', definition: { status: 'Planned' } };
  assert.equal(setConcernStatus(legacy, 'backend', 'Done'), 'Done');
  assert.equal(legacy.definition.status, 'Done');
});

test('in-progress concerns are listed per concern', () => {
  const entries = [entry('a', { backend: { status: 'Done' }, ui: { status: 'InProgress' } }), { id: 'b', slice: 'b', status: 'InProgress' }];
  assert.deepEqual(inProgressConcerns(entries), [
    { id: 'a', title: 'a', concern: 'ui' },
    { id: 'b', title: 'b', concern: 'backend' },
  ]);
});

test('settling after a run stamps blockedAt where missing and derives the status again', () => {
  const agentSetOnlyItsConcern = { id: 'a', slice: 'a', status: 'InProgress', definition: { status: 'InProgress' },
    concerns: { backend: { status: 'Done' }, ui: { status: 'Blocked', blockedReason: 'x' } } };
  const legacy = { id: 'b', status: 'Blocked' };
  const done = entry('c', { backend: { status: 'Done' } });
  assert.deepEqual(settleEntries([agentSetOnlyItsConcern, legacy, done], 'T'), ['a', 'b']);
  assert.equal(agentSetOnlyItsConcern.status, 'Blocked');
  assert.equal(agentSetOnlyItsConcern.definition.status, 'Blocked');
  assert.equal(agentSetOnlyItsConcern.concerns.ui.blockedAt, 'T');
  assert.equal(legacy.blockedAt, 'T');
});
