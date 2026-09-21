#!/usr/bin/env node
'use strict';

// Runner for the DCB slice commit-scope guard. Loads every check module from
// ./checks/*.cjs and runs it against the currently changed files.
//
// Check interface:
//   module.exports = {
//     name: 'my-check',
//     skipIfAlreadyFailing: false,
//     run(ctx) {
//       return [{ path: 'some/file.ts', reason: 'why this is a problem' }];
//     },
//   };
//
// `ctx` passed to every check:
//   changes        [{status, path}] — changed files
//   touchesSlice    true when this commit touches src/contexts/{context}/slices/{slicename}/**
//   repoRoot        absolute path to this project's own root
//   SLICE_PATTERN   RegExp matching a path inside a DCB slice's own folder
//
// Invoked as: node .build-kit/lib/check-commit-scope.cjs [--staged]

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SLICE_PATTERN = /^src\/contexts\/[^/]+\/slices\/[^/]+\//;

function parseNameStatus(out) {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status: status[0], path: rest.join('\t') };
    });
}

function stagedChanges() {
  return parseNameStatus(execSync('git diff --cached --name-status --no-renames --relative', { encoding: 'utf8' }));
}

function allChanges() {
  const tracked = parseNameStatus(execSync('git diff HEAD --name-status --no-renames --relative', { encoding: 'utf8' }));
  const untracked = execSync('git ls-files --others --exclude-standard', { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((p) => ({ status: 'A', path: p }));
  return [...tracked, ...untracked];
}

function loadChecks() {
  const checksDir = path.join(__dirname, 'checks');
  if (!fs.existsSync(checksDir)) return [];
  return fs
    .readdirSync(checksDir)
    .filter((f) => f.endsWith('.cjs'))
    .sort()
    .map((f) => {
      let mod;
      try {
        mod = require(path.join(checksDir, f));
      } catch (err) {
        console.error(`check-commit-scope: failed to load checks/${f} — ${err.message}`);
        return null;
      }
      if (typeof mod?.run !== 'function') {
        console.error(`check-commit-scope: skipping checks/${f} — does not export { name, run(ctx) }`);
        return null;
      }
      return { file: f, name: mod.name || f, run: mod.run, skipIfAlreadyFailing: !!mod.skipIfAlreadyFailing };
    })
    .filter(Boolean);
}

function main() {
  const staged = process.argv.includes('--staged');
  let changes;
  try {
    changes = staged ? stagedChanges() : allChanges();
  } catch (err) {
    console.error(`check-commit-scope: could not read ${staged ? 'staged' : 'uncommitted'} changes —`, err.message);
    process.exit(1);
  }

  if (changes.length === 0) process.exit(0);

  const touchesSlice = changes.some((c) => SLICE_PATTERN.test(c.path));
  if (!touchesSlice) process.exit(0);

  const ctx = {
    changes,
    touchesSlice,
    repoRoot: process.cwd(),
    SLICE_PATTERN,
  };

  const checks = loadChecks();
  const violations = [];
  const claimedPaths = new Set();

  for (const check of checks) {
    if (check.skipIfAlreadyFailing && violations.length > 0) continue;

    let result;
    try {
      result = check.run(ctx) || [];
    } catch (err) {
      violations.push({ path: '(check error)', reason: `[${check.name}] threw: ${err.message}` });
      continue;
    }

    for (const v of result) {
      if (claimedPaths.has(v.path)) continue;
      claimedPaths.add(v.path);
      violations.push({ path: v.path, reason: `[${check.name}] ${v.reason}` });
    }
  }

  if (violations.length > 0) {
    console.error('\n❌ commit blocked — slice commit-scope guard found issues:\n');
    for (const v of violations) console.error(`  - ${v.path} — ${v.reason}`);
    console.error('\nSee .build-kit/lib/checks/ for what each check enforces.\n');
    process.exit(1);
  }

  process.exit(0);
}

main();
