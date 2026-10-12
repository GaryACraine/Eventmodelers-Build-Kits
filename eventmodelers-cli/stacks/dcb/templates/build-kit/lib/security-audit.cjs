#!/usr/bin/env node
'use strict';

// Security releases (ADR-063): is there a known fix we haven't taken, and is everything held still? It warns and never
// blocks (exit 0), like the model's checks; `--strict` is the release gate: it exits 1 on a warning, or on a high or
// critical advisory in what runs.
//
//   node .build-kit/lib/security-audit.cjs [--strict]     (npm run security:audit)
//
// Record it as evidence with `npm run security:record -- audit -- npm run security:audit -- --strict`.
//
// What it does:
//   - **Advisories:** `npm audit` in every package of the project (each folder with a package.json, outside
//     node_modules). It needs the network: GitHub's advisory database answers it.
//     - **What runs:** the run-time dependencies (`--omit=dev`) of the backend, the sign-in service and the web app.
//     - **Tooling:** the rest: dev dependencies, and every package under e2e/ or .build-kit/ (they never ship).
//   - **Held still, or it warns:**
//     - every package commits a lockfile (without one it can't be audited, and each install resolves afresh);
//     - `better-auth` and `@better-auth/*` are exact versions, the same one everywhere (the sign-in path);
//     - every image in docker-compose.yml and every Dockerfile's FROM names an exact version (`postgres:18.6`, not
//       `postgres:18`) or a digest.
//
// An advisory with no fix, or one that doesn't reach us, can be accepted in security/audit-exceptions.json, with the
// reason and a date to look again. After that date it counts again, with a warning:
//   [{ "advisory": "GHSA-…", "package": "braces", "where": "web", "reason": "…", "review": "2027-01-12" }]

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.cwd();
// Tests point this at a stand-in for npm
const NPM = process.env.SECURITY_AUDIT_NPM || 'npm';
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.eventmodelers']);
const TOOLING = /^(e2e|\.build-kit)(\/|$)/;
const SERIOUS = new Set(['high', 'critical']);

/** Every folder holding a package.json, relative to the root ('.' for the root) */
function packages(dir = ROOT, found = []) {
  if (fs.existsSync(path.join(dir, 'package.json'))) found.push(path.relative(ROOT, dir) || '.');
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
    if (entry.isDirectory() && !SKIP.has(entry.name)) packages(path.join(dir, entry.name), found);
  return found;
}

/** `npm audit --json` in `where`: [{ id, package, severity, title }], or an error */
function audit(where, omitDev) {
  const args = ['audit', '--json', ...(omitDev ? ['--omit=dev'] : [])];
  const r = spawnSync(NPM, args, { cwd: path.join(ROOT, where), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    return { error: (r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n')[0] };
  }
  if (report.error) return { error: report.error.summary || report.error.code || 'npm audit failed' };
  const found = new Map();
  for (const [name, entry] of Object.entries(report.vulnerabilities ?? {}))
    for (const via of entry.via ?? [])
      if (typeof via === 'object') {
        const id = (via.url ?? '').split('/').pop() || String(via.source);
        found.set(`${id} ${name}`, { id, package: name, severity: via.severity, title: via.title });
      }
  return { advisories: [...found.values()] };
}

function exceptions(warnings) {
  const file = path.join(ROOT, 'security', 'audit-exceptions.json');
  if (!fs.existsSync(file)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    return list.filter((e) => {
      if (!e.advisory || !e.reason || !e.review) {
        warnings.push(`audit-exceptions.json: ${e.advisory ?? 'an entry'} needs an advisory, a reason and a review date`);
        return false;
      }
      if (e.review < today) {
        warnings.push(`audit-exceptions.json: ${e.advisory} (${e.package ?? 'any package'}) was due for review on ${e.review}, so it counts again`);
        return false;
      }
      return true;
    });
  } catch (error) {
    warnings.push(`audit-exceptions.json can't be read: ${error.message}`);
    return [];
  }
}

const accepted = (list, where, a) =>
  list.some((e) => e.advisory === a.id && (!e.package || e.package === a.package) && (!e.where || e.where === where));

/** `better-auth` and `@better-auth/*`: exact, and one version everywhere */
function signInPins(found, warnings) {
  const versions = new Map();
  for (const where of found) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, where, 'package.json'), 'utf8'));
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }))
      if (name === 'better-auth' || name.startsWith('@better-auth/')) {
        if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) warnings.push(`${where}/package.json: ${name} is "${version}", not an exact version`);
        versions.set(`${where}: ${name}`, version);
      }
  }
  if (new Set(versions.values()).size > 1)
    warnings.push(`better-auth's packages aren't one version: ${[...versions].map(([at, v]) => `${at} ${v}`).join(', ')}`);
}

/** Is an image reference exact: a digest, or a tag with at least major.minor? */
const exactImage = (image) => /@sha256:[0-9a-f]{64}$/.test(image) || /:v?\d+\.\d+[\w.-]*$/.test(image);

function images(warnings) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(at);
      else if (entry.name === 'Dockerfile' || /^docker-compose.*\.ya?ml$/.test(entry.name)) files.push(at);
    }
  };
  walk(ROOT);
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const text = fs.readFileSync(file, 'utf8');
    if (path.basename(file) === 'Dockerfile') {
      const stages = new Set();
      for (const m of text.matchAll(/^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/gim)) {
        if (!stages.has(m[1]) && !exactImage(m[1])) warnings.push(`${rel}: FROM ${m[1]} isn't an exact version`);
        if (m[2]) stages.add(m[2]);
      }
    } else {
      for (const m of text.matchAll(/^\s*image:\s*["']?([^"'\s#]+)/gm))
        if (!exactImage(m[1])) warnings.push(`${rel}: image ${m[1]} isn't an exact version`);
    }
  }
}

function check() {
  const warnings = [];
  const found = packages();
  const accept = exceptions(warnings);
  const runs = [];
  const tooling = [];
  const acceptedFound = [];
  for (const where of found) {
    if (!fs.existsSync(path.join(ROOT, where, 'package-lock.json'))) {
      warnings.push(`${where}: no package-lock.json, so it can't be audited and every install resolves afresh`);
      continue;
    }
    const all = audit(where, false);
    if (all.error) {
      warnings.push(`${where}: npm audit failed (${all.error})`);
      continue;
    }
    const shipped = TOOLING.test(where) ? { advisories: [] } : audit(where, true);
    if (shipped.error) {
      warnings.push(`${where}: npm audit --omit=dev failed (${shipped.error})`);
      continue;
    }
    const atRunTime = new Set(shipped.advisories.map((a) => `${a.id} ${a.package}`));
    for (const a of all.advisories) {
      const item = { ...a, where };
      if (accepted(accept, where, a)) acceptedFound.push(item);
      else (atRunTime.has(`${a.id} ${a.package}`) ? runs : tooling).push(item);
    }
  }
  signInPins(found, warnings);
  images(warnings);
  return { warnings, packages: found.length, runs, tooling, accepted: acceptedFound };
}

if (require.main === module) {
  const { warnings, packages: count, runs, tooling, accepted: ok } = check();
  const line = (a) => `  ${a.severity} ${a.package} (${a.where}) ${a.id}: ${a.title}`;
  if (runs.length) console.log(`what runs:\n${runs.map(line).join('\n')}`);
  if (tooling.length) console.log(`tooling:\n${tooling.map(line).join('\n')}`);
  if (ok.length) console.log(`accepted (security/audit-exceptions.json):\n${ok.map(line).join('\n')}`);
  for (const warning of warnings) console.error(`warning: ${warning}`);
  const serious = runs.filter((a) => SERIOUS.has(a.severity)).length;
  console.log(
    `security audit: ${count} packages; what runs: ${runs.length} advisories (${serious} high or critical); tooling: ${tooling.length}; accepted: ${ok.length}; ${warnings.length} warning(s)`
  );
  process.exit(process.argv.includes('--strict') && (warnings.length || serious) ? 1 : 0);
}

module.exports = { check, exactImage };
