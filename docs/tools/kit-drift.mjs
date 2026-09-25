#!/usr/bin/env node
// Kit drift: which of a project's kit files differ from this repo's kit (PLAN 14.10a finding).
//
//   node docs/tools/kit-drift.mjs <project> [--stack dcb] [--root]
//
// Compares what `eventmodelers init` installs, in the same overlay order, with what the project has:
//   shared/build-kit/**                 → <project>/.build-kit/**   (the stack's own files overlay it)
//   stacks/<stack>/templates/build-kit/** → <project>/.build-kit/**
//   stacks/<stack>/templates/.claude/skills/** → <project>/.claude/skills/**
// A project's own files are skipped: `.build-kit/learnings/` (its lessons, ADR-028) and `.eventmodelers/`.
// --root also lists the scaffold (stacks/<stack>/templates/root/**) as information: app code there is the
// project's to change, so it never fails the check.
//
// Exit code 1 when a kit or skill file differs or is missing: run it before and after every kit update.

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);
const project = args.find((a) => !a.startsWith('--'));
const stack = args.includes('--stack') ? args[args.indexOf('--stack') + 1] : 'dcb';
const withRoot = args.includes('--root');
if (!project) {
  console.error('usage: node docs/tools/kit-drift.mjs <project> [--stack dcb] [--root]');
  process.exit(2);
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(repo, 'eventmodelers-cli');
const SKIP = new Set(['node_modules', '.eventmodelers', 'learnings', '.DS_Store']);

function files(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, base) : [relative(base, path)];
  });
}

// target path in the project → source path in this repo (later sources overlay earlier ones, as init does)
function sources(pairs) {
  const map = new Map();
  for (const [src, dest] of pairs) for (const f of files(src)) map.set(join(dest, f), join(src, f));
  return map;
}

function compare(map) {
  const out = { same: 0, differ: [], missing: [] };
  for (const [target, source] of [...map].sort()) {
    const path = join(project, target);
    if (!existsSync(path)) out.missing.push(target);
    else if (!readFileSync(path).equals(readFileSync(source))) out.differ.push(target);
    else out.same++;
  }
  return out;
}

const templates = join(cli, 'stacks', stack, 'templates');
const kit = compare(sources([
  [join(cli, 'shared', 'build-kit'), '.build-kit'],
  [join(templates, 'build-kit'), '.build-kit'],
  [join(templates, '.claude', 'skills'), join('.claude', 'skills')],
]));

console.log(`Kit drift: ${project} against ${relative(process.cwd(), cli) || cli} (stack ${stack})`);
console.log(`  kit and skills: ${kit.same} same, ${kit.differ.length} differ, ${kit.missing.length} missing`);
for (const f of kit.differ) console.log(`    DIFFER  ${f}`);
for (const f of kit.missing) console.log(`    MISSING ${f}`);

if (withRoot) {
  const root = compare(sources([[join(templates, 'root'), '.']]));
  // Missing scaffold files are mostly the kit's example app, which scripts/start-empty.sh removes: counted, not listed.
  console.log(`  scaffold (information only; app code is the project's): ${root.same} same, ${root.differ.length} differ, ${root.missing.length} not in the project`);
  for (const f of root.differ) console.log(`    differ  ${f}`);
}

process.exit(kit.differ.length + kit.missing.length > 0 ? 1 : 0);
