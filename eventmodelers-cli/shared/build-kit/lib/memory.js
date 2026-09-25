// The loop's memory, by concern, with git as the record (PLAN 14.10a, DCB ADR-028).
//
// A kit that ships `learnings/` (in the project: `.build-kit/learnings/{shared,backend,ui}.md`) gets:
//   - its lessons injected into each job's prompt: the shared file plus the job's concern's file, never the other
//     discipline's;
//   - `progress.txt` as a journal of what has no commit (a blocked or interrupted job, an open question). Each
//     entry is tagged `[slice:<id> concern:<backend|ui>]` and removed once that concern is Done. Completed work is
//     recorded in its commit's body instead. A UI job is given its backend's commit body, unless the project has an
//     API contract (`api/openapi.json`), which replaces it.
// A kit without `learnings/` keeps today's prompts and files untouched.

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { execFileSync } from 'child_process';

/** A learnings file past this many lessons must be merged before one is added. */
export const LEARNINGS_CAP = 40;

const LABELS = { shared: 'Shared learnings', backend: 'Backend learnings', ui: 'UI learnings' };

/** Whether the kit uses learnings by concern (it ships `learnings/`). */
export function usesLearnings(kitDir) {
  return existsSync(join(kitDir, 'learnings'));
}

/** The journal: the project's `progress.txt`, next to the kit dir. */
export function journalPath(kitDir) {
  return join(dirname(kitDir), 'progress.txt');
}

/**
 * The project's API contract (PLAN 14.10, ADR-029): written by emcli at export, next to the kit dir. With it a UI
 * builds from the contract alone: it doesn't wait for its backend, and isn't given the backend's commit body.
 */
export function contractPath(kitDir) {
  return join(dirname(kitDir), 'api', 'openapi.json');
}

/** The tag that makes a journal entry prunable: `[slice:<id> concern:<concern>]`. */
export function journalTag({ id, concern }) {
  return `[slice:${id} concern:${concern ?? 'backend'}]`;
}

const TAG = /\[slice:([^\s\]]+) concern:(backend|ui)\]\s*$/;

/**
 * Splits a journal into its preamble (anything before the first `## ` heading) and its entries, each
 * `{ text, slice, concern }` (`slice`/`concern` null for an untagged entry). Joining preamble + texts gives the
 * original back.
 */
export function journalEntries(text) {
  const parts = String(text ?? '').split(/(?=^## )/m);
  const preamble = parts[0].startsWith('## ') ? '' : parts.shift();
  const entries = parts.map((part) => {
    const heading = part.split('\n', 1)[0];
    const tag = heading.match(TAG);
    return { text: part, slice: tag?.[1] ?? null, concern: tag?.[2] ?? null };
  });
  return { preamble, entries };
}

/**
 * Removes the journal entries whose tagged concern is Done in `indexEntries` (index.json's slices). Untagged
 * entries, and entries for slices the index doesn't know, are kept. Returns how many were removed.
 */
export function pruneJournal(path, indexEntries) {
  if (!existsSync(path)) return 0;
  const done = new Set();
  for (const entry of indexEntries ?? []) {
    for (const [concern, state] of Object.entries(entry?.concerns ?? {})) {
      if (String(state?.status ?? '').toLowerCase() === 'done') done.add(`${entry.id}:${concern}`);
    }
  }
  const { preamble, entries } = journalEntries(readFileSync(path, 'utf-8'));
  const kept = entries.filter((e) => !(e.slice && done.has(`${e.slice}:${e.concern}`)));
  const removed = entries.length - kept.length;
  if (removed > 0) writeFileSync(path, preamble + kept.map((e) => e.text).join(''), 'utf-8');
  return removed;
}

/** The journal entries still open for one job (slice + concern). */
export function openNotes(path, { id, concern }) {
  if (!existsSync(path)) return [];
  return journalEntries(readFileSync(path, 'utf-8')).entries
    .filter((e) => e.slice === id && e.concern === (concern ?? 'backend'))
    .map((e) => e.text.trim());
}

/** How many lessons (top-level `- ` bullets) a learnings file holds. */
export function countLessons(text) {
  return (String(text ?? '').match(/^- /gm) ?? []).length;
}

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The body of the slice's backend commit (`feat: [<slice>]` or `feat: <slice>`, never its `… screen` commit),
 * without the subject and trailers; '' when there's none.
 */
export function backendCommitBody(projectDir, title) {
  let message = '';
  try {
    message = execFileSync('git', ['log', '-E', `--grep=^feat: \\[?${escapeRegex(title)}\\]?$`, '-1', '--format=%B'], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
  return message
    .split('\n')
    .slice(1)
    .filter((line) => !/^[a-z-]+-by: /i.test(line))
    .join('\n')
    .trim();
}

/**
 * The memory a job starts with, as markdown to put between the task header and the routine: the shared lessons,
 * the job's concern's lessons, its open journal notes, and for a UI job its backend's commit body. Returns
 * { text, summary, overCap }; `text` is '' when there's nothing to give.
 */
export function memoryBlock({ kitDir, projectDir, planned }) {
  const concern = planned?.concern === 'ui' ? 'ui' : 'backend';
  const sections = [];
  const summary = [];
  const overCap = [];

  for (const name of ['shared', concern]) {
    const path = join(kitDir, 'learnings', `${name}.md`);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf-8').trim();
    const lessons = countLessons(text);
    const lines = [`### ${LABELS[name]} (\`.build-kit/learnings/${name}.md\`, ${lessons} lesson${lessons === 1 ? '' : 's'})`, '', text || '(none yet)'];
    if (lessons > LEARNINGS_CAP) {
      lines.push('', `**This file has ${lessons} lessons (cap ${LEARNINGS_CAP}): merge or drop lessons before adding one.**`);
      overCap.push(`${name}.md (${lessons})`);
    }
    sections.push(lines.join('\n'));
    summary.push(name);
  }

  const notes = openNotes(journalPath(kitDir), { id: planned?.id, concern });
  if (notes.length) {
    sections.push(['### Open notes on this job (`progress.txt`)', '', ...notes].join('\n'));
    summary.push(`${notes.length} open note${notes.length === 1 ? '' : 's'}`);
  }

  if (concern === 'ui' && planned?.title && !existsSync(contractPath(kitDir))) {
    const body = backendCommitBody(projectDir ?? dirname(kitDir), planned.title);
    if (body) {
      sections.push(['### What the backend job recorded (its commit body)', '', body].join('\n'));
      summary.push('backend commit');
    }
  }

  if (sections.length === 0) return { text: '', summary: '', overCap };
  const text = [
    "## What the loop remembers (read this; don't go looking for more)",
    '',
    `Your ${concern === 'ui' ? 'UI' : 'backend'} memory, given by the loop (ADR-028). Don't read \`progress.txt\`, ` +
      '`.build-kit/AGENTS.md` or the other learnings files.',
    '',
    sections.join('\n\n'),
    '',
    '---',
    '',
    '',
  ].join('\n');
  return { text, summary: summary.join(', '), overCap };
}
