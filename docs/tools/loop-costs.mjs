#!/usr/bin/env node
// Loop costs: what each slice cost the Ralph loop, from <project>/.build-kit/metrics/runs.jsonl (PLAN 15.9).
//
//   node docs/tools/loop-costs.mjs <project> [--since <ISO date>]
//
// Every agent run is one line there (the loop writes it after each job): the slice and concern, the model and
// effort, cost, turns, tokens and how it ended. This prints the cost per slice (all its runs, retries included), per
// kind of slice (write, read, extension, automation), per model and effort, the totals, and what runs that didn't
// finish a job (blocked, interrupted, a usage limit, an error) cost.
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const args = process.argv.slice(2);
const project = args.find((a) => !a.startsWith('--'));
const since = args.includes('--since') ? new Date(args[args.indexOf('--since') + 1]) : null;
if (!project) {
  console.error('usage: node docs/tools/loop-costs.mjs <project> [--since <ISO date>]');
  process.exit(2);
}
const kitDir = join(resolve(project), '.build-kit');
const file = join(kitDir, 'metrics', 'runs.jsonl');
if (!existsSync(file)) {
  console.error(`No runs recorded yet: ${file} doesn't exist (the loop writes it from PLAN 15.9's kit on).`);
  process.exit(1);
}

const runs = readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => !since || new Date(r.at) >= since);

// The kind of each slice, from the loop's index.json (its definition's sliceType, and `extends` for an extension).
const kinds = new Map();
for (const ctx of existsSync(join(kitDir, '.slices')) ? readdirSafe(join(kitDir, '.slices')) : []) {
  const indexFile = join(kitDir, '.slices', ctx, 'index.json');
  if (!existsSync(indexFile)) continue;
  for (const entry of JSON.parse(readFileSync(indexFile, 'utf-8')).slices ?? []) {
    const sliceFile = join(kitDir, '.slices', ctx, entry.folder ?? '', 'slice.json');
    let kind = 'unknown';
    if (existsSync(sliceFile)) {
      const slice = JSON.parse(readFileSync(sliceFile, 'utf-8'));
      kind = slice.extends ? 'extension' : ({ STATE_CHANGE: 'write', STATE_VIEW: 'read', AUTOMATION: 'automation' }[slice.sliceType] ?? slice.sliceType ?? 'unknown');
    }
    kinds.set(entry.id, kind);
  }
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

const usd = (n) => `$${n.toFixed(2)}`;
const k = (n) => `${Math.round(n / 1000)}k`;
const read = (r) => (r.tokens?.input ?? 0) + (r.tokens?.cacheRead ?? 0) + (r.tokens?.cacheWrite ?? 0);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function group(by) {
  const groups = new Map();
  for (const r of runs) {
    const key = by(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

function table(title, groups) {
  console.log(`\n${title}`);
  const rows = [...groups].map(([key, rs]) => {
    const cost = rs.reduce((n, r) => n + (r.costUsd ?? 0), 0);
    return {
      key, runs: rs.length, cost,
      turns: rs.reduce((n, r) => n + (r.turns ?? 0), 0),
      read: rs.reduce((n, r) => n + read(r), 0),
      out: rs.reduce((n, r) => n + (r.tokens?.output ?? 0), 0),
      outcome: rs[rs.length - 1].outcome,
    };
  }).sort((a, b) => b.cost - a.cost);
  const width = Math.max(...rows.map((r) => String(r.key).length), 10);
  console.log(`  ${'what'.padEnd(width)}  runs    cost  turns  tokens in  out   last outcome`);
  for (const r of rows) {
    console.log(`  ${String(r.key).padEnd(width)}  ${String(r.runs).padStart(4)}  ${usd(r.cost).padStart(6)}  ${String(r.turns).padStart(5)}  ${k(r.read).padStart(9)}  ${k(r.out).padStart(4)}   ${r.outcome}`);
  }
}

const total = runs.reduce((n, r) => n + (r.costUsd ?? 0), 0);
const finished = runs.filter((r) => r.outcome === 'Done');
const wasted = runs.filter((r) => r.outcome !== 'Done');
console.log(`Loop costs: ${resolve(project)}${since ? ` (since ${since.toISOString()})` : ''}`);
console.log(`  ${runs.length} runs, ${usd(total)} in all; ${finished.length} finished a job (median ${usd(median(finished.map((r) => r.costUsd ?? 0)))}); ` +
  `${wasted.length} didn't (${usd(wasted.reduce((n, r) => n + (r.costUsd ?? 0), 0))}: ` +
  `${[...group((r) => r.outcome)].filter(([o]) => o !== 'Done').map(([o, rs]) => `${rs.length} ${o}`).join(', ') || 'none'})`);

table('Per slice (all its runs)', group((r) => `${r.slice}${r.concern === 'ui' ? ' (UI)' : ''}`));
table('Per kind of slice', group((r) => `${kinds.get(r.sliceId) ?? 'unknown'} ${r.concern ?? 'backend'}`));
table('Per model and effort', group((r) => `${r.model ?? 'inherited'}, ${r.effort ? `effort ${r.effort}` : 'effort inherited'}`));
