// node --test shared/build-kit/lib/memory.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  LEARNINGS_CAP, backendCommitBody, countLessons, journalEntries, journalTag, memoryBlock, openNotes, pruneJournal, usesLearnings,
} from './memory.js';

// A scratch project: <root>/.build-kit (with learnings/ unless `learnings: false`) and <root>/progress.txt.
function project({ learnings = { shared: '# Shared\n\n- s1', backend: '# Backend\n\n- b1\n- b2', ui: '# UI\n\n- u1' }, journal } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-test-'));
  const kitDir = join(root, '.build-kit');
  mkdirSync(kitDir);
  if (learnings) {
    mkdirSync(join(kitDir, 'learnings'));
    for (const [name, text] of Object.entries(learnings)) writeFileSync(join(kitDir, 'learnings', `${name}.md`), text);
  }
  if (journal !== undefined) writeFileSync(join(root, 'progress.txt'), journal);
  return { root, kitDir };
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' });
function commit(root, message) {
  writeFileSync(join(root, `f${Math.random()}`), 'x');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
}

const note = (id, concern, heading = 'Slice auto-blocked') => `## 2026-09-25T10:00:00Z — ${heading} ${journalTag({ id, concern })}\n\n- why\n---\n`;

test('only a kit that ships learnings/ uses them', () => {
  assert.equal(usesLearnings(project().kitDir), true);
  assert.equal(usesLearnings(project({ learnings: false }).kitDir), false);
});

test('a backend job gets the shared and backend lessons, never the UI ones', () => {
  const { root, kitDir } = project();
  const { text, summary } = memoryBlock({ kitDir, projectDir: root, planned: { id: 'a', title: 'a', concern: 'backend' } });
  assert.match(text, /### Shared learnings .*1 lesson\)/);
  assert.match(text, /### Backend learnings .*2 lessons\)/);
  assert.match(text, /- b2/);
  assert.doesNotMatch(text, /UI learnings|- u1/);
  assert.equal(summary, 'shared, backend');
});

test("a UI job gets the shared and UI lessons, and its backend's commit body", () => {
  const { root, kitDir } = project();
  git(root, 'init', '-q');
  commit(root, 'feat: [rate course]\n\nBuilt: POST /rate-course\nFor the UI: 422 "Student is not subscribed"\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  const { text, summary } = memoryBlock({ kitDir, projectDir: root, planned: { id: 'a', title: 'rate course', concern: 'ui' } });
  assert.match(text, /### UI learnings/);
  assert.doesNotMatch(text, /Backend learnings|- b1/);
  assert.match(text, /### What the backend job recorded[\s\S]*For the UI: 422/);
  assert.doesNotMatch(text, /Co-Authored-By/);
  assert.equal(summary, 'shared, ui, backend commit');
});

test('missing files are skipped, and nothing at all gives no block', () => {
  const { root, kitDir } = project({ learnings: { backend: '- b1' } });
  assert.equal(memoryBlock({ kitDir, projectDir: root, planned: { id: 'a', concern: 'backend' } }).summary, 'backend');
  const empty = project({ learnings: {} });
  assert.equal(memoryBlock({ kitDir: empty.kitDir, projectDir: empty.root, planned: { id: 'a', concern: 'ui' } }).text, '');
});

test('a learnings file over the cap says so', () => {
  const many = Array.from({ length: LEARNINGS_CAP + 1 }, (_, i) => `- lesson ${i}`).join('\n');
  const { root, kitDir } = project({ learnings: { backend: many } });
  const block = memoryBlock({ kitDir, projectDir: root, planned: { id: 'a', concern: 'backend' } });
  assert.match(block.text, /has 41 lessons \(cap 40\): merge or drop lessons before adding one/);
  assert.deepEqual(block.overCap, ['backend.md (41)']);
  assert.equal(countLessons(`- a\n  - nested\n- b`), 2);
});

test("a job's open journal notes are in its memory, other jobs' aren't", () => {
  const { root, kitDir } = project({ journal: '# Journal\n' + note('a', 'ui') + note('a', 'backend') + note('b', 'ui') });
  const block = memoryBlock({ kitDir, projectDir: root, planned: { id: 'a', title: 'a', concern: 'ui' } });
  assert.match(block.text, /### Open notes on this job/);
  assert.equal((block.text.match(/Slice auto-blocked/g) ?? []).length, 1);
  assert.equal(openNotes(join(root, 'progress.txt'), { id: 'b', concern: 'backend' }).length, 0);
});

test('the journal parses back to the same text', () => {
  const journal = '# Journal\n\n' + note('a', 'ui') + '## an untagged note\n\n- by hand\n---\n';
  const { preamble, entries } = journalEntries(journal);
  assert.equal(preamble + entries.map((e) => e.text).join(''), journal);
  assert.deepEqual(entries.map((e) => [e.slice, e.concern]), [['a', 'ui'], [null, null]]);
});

test("pruning removes the notes of Done jobs and keeps open, unknown and untagged ones", () => {
  const journal = '# Journal\n' + note('a', 'backend') + note('a', 'ui') + note('b', 'backend') + note('gone', 'ui') + '## by hand\n\n- keep\n---\n';
  const { root } = project({ journal });
  const index = [
    { id: 'a', concerns: { backend: { status: 'Done' }, ui: { status: 'Blocked' } } },
    { id: 'b', concerns: { backend: { status: 'Planned' } } },
  ];
  const path = join(root, 'progress.txt');
  assert.equal(pruneJournal(path, index), 1);
  const left = journalEntries(readFileSync(path, 'utf-8')).entries.map((e) => `${e.slice}:${e.concern}`);
  assert.deepEqual(left, ['a:ui', 'b:backend', 'gone:ui', 'null:null']);
  index[0].concerns.ui.status = 'Done';
  assert.equal(pruneJournal(path, index), 1);
  assert.equal(pruneJournal(path, index), 0);
  assert.ok(readFileSync(path, 'utf-8').startsWith('# Journal\n'));
});

test("the backend commit is found by either subject, never the screen's or another slice's", () => {
  const { root } = project();
  git(root, 'init', '-q');
  commit(root, 'feat: rate course\n\nBuilt: old');
  assert.equal(backendCommitBody(root, 'rate course'), 'Built: old');
  commit(root, 'feat: [rate course]\n\nBuilt: new');
  commit(root, 'feat: [rate course] screen\n\nBuilt: the form');
  commit(root, 'feat: [rate course ratings]\n\nBuilt: other');
  assert.equal(backendCommitBody(root, 'rate course'), 'Built: new');
  assert.equal(backendCommitBody(root, 'course (ratings)'), '');
  assert.equal(backendCommitBody(join(tmpdir(), 'not-a-repo-xyz'), 'rate course'), '');
});
