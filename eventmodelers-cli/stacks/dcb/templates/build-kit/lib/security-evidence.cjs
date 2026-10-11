#!/usr/bin/env node
'use strict';

// The security evidence (ADR-056 D14): does every policy in security/POLICY.md name the tests that prove it, and do
// they exist? It warns and never blocks (exit 0), like the model's checks; `--strict` exits 1 on a warning, for CI.
//
//   node .build-kit/lib/security-evidence.cjs [--strict]                    (npm run security:check)
//   node .build-kit/lib/security-evidence.cjs record <name> -- <command…>   (npm run security:record -- <name> -- …)
//
// What it reads:
//   - security/POLICY.md: a table whose rows start with a policy's id (`| AC-1 | … |`);
//   - security/EVIDENCE.md: a table whose rows start with a policy's id, then what proves it, then its last run.
//     A policy may have several rows (a unit test, an end-to-end script, a check by hand).
//     - "Proved by": each `path` (from the project's root) is a test file, script or record that must exist, and each
//       "name" after it is a test's name (or a line the script prints) that must appear in that file;
//     - "Last run": each [link](results/…) is a recorded run (relative to security/) that must exist.
//
// It warns when:
//   - SECURITY.md, security/POLICY.md or security/EVIDENCE.md is missing;
//   - a policy has no evidence row, or a row names no file;
//   - a file, a test's name in it, or a recorded run doesn't exist;
//   - an evidence row names a policy that POLICY.md doesn't have.
//
// `record` runs a command, shows its output, and keeps it in security/results/<date>-<name>.log with the date, the
// commit, the command and its exit code (colour codes removed), so a run is evidence as it happened. It exits with the
// command's code. No run is replaced: the same name again on the same day is <date>-<name>-2.log, then -3, so a failed
// run stays beside the one that passed after it.

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const ROOT = process.cwd();
const SECURITY = path.join(ROOT, 'security');
const ID = /^[A-Z]{2,}-\d+[a-z]?$/;

/** The rows of every markdown table in `text` whose first cell is a policy id: [id, ...cells] */
function rows(text) {
  return text
    .split('\n')
    .filter((line) => /^\s*\|/.test(line))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim())
    )
    .filter((cells) => ID.test(cells[0]));
}

/** The files a "Proved by" cell names, each with the test names after it: [{ file, names }] */
function references(cell) {
  const found = [];
  for (const m of cell.matchAll(/"([^"]+)"|`([^`]+)`/g)) {
    if (m[2] !== undefined) found.push({ file: m[2], names: [] });
    else if (found.length) found[found.length - 1].names.push(m[1]);
  }
  return found;
}

/** The recorded runs a "Last run" cell links to, relative to security/ */
const runs = (cell) => [...(cell ?? '').matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((link) => !/^[a-z]+:/i.test(link));

function check() {
  const warnings = [];
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);
  if (!fs.existsSync(path.join(ROOT, 'SECURITY.md'))) warnings.push('SECURITY.md is missing: it points readers to security/');
  const policy = read(path.join(SECURITY, 'POLICY.md'));
  const evidence = read(path.join(SECURITY, 'EVIDENCE.md'));
  if (policy === undefined) warnings.push('security/POLICY.md is missing');
  if (evidence === undefined) warnings.push('security/EVIDENCE.md is missing');
  if (policy === undefined || evidence === undefined) return { warnings, policies: 0, proved: 0, run: 0 };

  const policies = [...new Set(rows(policy).map(([id]) => id))];
  const proved = new Set();
  const run = new Set();
  for (const [id, provedBy = '', lastRun] of rows(evidence)) {
    if (!policies.includes(id)) warnings.push(`EVIDENCE.md: ${id} isn't a policy in POLICY.md`);
    const named = references(provedBy);
    if (!named.length) warnings.push(`EVIDENCE.md: a row for ${id} names no test`);
    let found = named.length > 0;
    for (const { file, names } of named) {
      const where = path.join(ROOT, file);
      if (!fs.existsSync(where)) {
        warnings.push(`EVIDENCE.md: ${id} names ${file}, which doesn't exist`);
        found = false;
        continue;
      }
      if (!names.length) continue;
      const text = fs.statSync(where).isFile() ? fs.readFileSync(where, 'utf8') : '';
      for (const name of names)
        if (!text.includes(name)) {
          warnings.push(`EVIDENCE.md: ${id} names "${name}", which isn't in ${file}`);
          found = false;
        }
    }
    if (found) proved.add(id);
    for (const link of runs(lastRun)) {
      if (fs.existsSync(path.join(SECURITY, link))) run.add(id);
      else warnings.push(`EVIDENCE.md: ${id}'s last run links to ${link}, which doesn't exist`);
    }
  }
  for (const id of policies) if (!rows(evidence).some(([row]) => row === id)) warnings.push(`POLICY.md: ${id} names no test (no row in EVIDENCE.md)`);
  return { warnings, policies: policies.length, proved: policies.filter((id) => proved.has(id)).length, run: policies.filter((id) => run.has(id)).length };
}

function record(name, command) {
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name) || !command.length) {
    console.error('usage: security-evidence.cjs record <name> -- <command…>   (name: lowercase letters, digits and dashes)');
    process.exit(2);
  }
  const at = new Date();
  const day = at.toISOString().slice(0, 10);
  let commit = 'none';
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    // The recorded runs themselves don't count: an earlier log of the same day isn't a change to what was tested
    if (execSync("git status --porcelain -- . ':!security/results'", { cwd: ROOT, encoding: 'utf8' }).trim()) commit += ' (with uncommitted changes)';
  } catch {
    // not a git repository: the log says so
  }
  const results = path.join(SECURITY, 'results');
  fs.mkdirSync(results, { recursive: true });
  let file = path.join(results, `${day}-${name}.log`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(results, `${day}-${name}-${n}.log`);
  const shown = command.join(' ');
  const output = [];
  const child = spawn(shown, { cwd: ROOT, shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    output.push(chunk);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    output.push(chunk);
  });
  child.on('close', (code) => {
    // eslint-disable-next-line no-control-regex
    const text = Buffer.concat(output).toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const header = `# ${name}\ndate: ${at.toISOString()}\ncommit: ${commit}\ncommand: ${shown}\n\n`;
    fs.writeFileSync(file, `${header}${text}${text.endsWith('\n') ? '' : '\n'}\nexit: ${code}\n`);
    console.error(`\nrecorded: ${path.relative(ROOT, file)} (exit ${code})`);
    process.exit(code ?? 1);
  });
}

const args = process.argv.slice(2);
if (args[0] === 'record') {
  const rest = args.slice(1);
  const dashes = rest.indexOf('--');
  record(rest[0], dashes === -1 ? rest.slice(1) : rest.slice(dashes + 1));
} else {
  const { warnings, policies, proved, run } = check();
  for (const warning of warnings) console.error(`warning: ${warning}`);
  console.log(`security: ${policies} policies, ${proved} proved by tests that exist, ${run} with a recorded run; ${warnings.length} warning(s)`);
  process.exit(args.includes('--strict') && warnings.length ? 1 : 0);
}
