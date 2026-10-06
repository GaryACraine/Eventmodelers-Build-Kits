'use strict';

// While the loop has a backend job InProgress, that job changes only its own slice's folder (ADR-046), or, for an
// extension slice, its origin's (extension-additive holds it to adding). slice-scope keeps each commit to one slice;
// this keeps the job to *its* slice, across commits.
//
// It looks at the working tree as well as the commit: tsc-build checks the whole tree, so an edit to another slice
// left uncommitted would let the job's own commit build. The developer doesn't edit while the loop builds, so a dirty
// slice folder during a job is the job's own doing.
//
// A job that can't build without changing another slice means the plan is wrong: the change alters something other
// slices use. plan-change ("A change other slices use") plans it as expand, switch, contract instead.
//
// The job is the entry the loop marked InProgress in the current context's index.json. None → this check does nothing.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { normalize } = require('../util/find-slice.cjs');

const SLICE_KEY_PATTERN = /^src\/contexts\/([^/]+)\/slices\/([^/]+)\//;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function backendInProgress(entry) {
  const status = entry.concerns ? entry.concerns.backend?.status : entry.status;
  return String(status || '').toLowerCase() === 'inprogress';
}

// [{ title, folders: Set of normalized slice folder names the job may change }]
function inProgressJobs(repoRoot) {
  const slicesDir = path.join(repoRoot, '.build-kit', '.slices');
  const ctx = readJson(path.join(slicesDir, 'current_context.json'));
  if (!ctx?.name) return [];
  const index = readJson(path.join(slicesDir, ctx.name, 'index.json'));
  return (index?.slices ?? []).filter(backendInProgress).map((entry) => {
    const slice = readJson(path.join(slicesDir, ctx.name, entry.folder, 'slice.json')) ?? {};
    const title = slice.title || entry.slice || entry.folder;
    const folders = new Set([normalize(entry.folder), normalize(title)]);
    if (slice.extends?.originSliceTitle) folders.add(normalize(slice.extends.originSliceTitle));
    return { title, folders };
  });
}

function workingTreePaths(repoRoot) {
  try {
    const tracked = execSync('git diff HEAD --name-only --no-renames', { cwd: repoRoot, encoding: 'utf8' });
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: repoRoot, encoding: 'utf8' });
    return [...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  name: 'job-scope',
  run(ctx) {
    const jobs = inProgressJobs(ctx.repoRoot);
    if (jobs.length === 0) return [];
    const allowed = new Set(jobs.flatMap((j) => [...j.folders]));
    const titles = jobs.map((j) => `"${j.title}"`).join(', ');

    const paths = new Set([...ctx.changes.map((c) => c.path), ...workingTreePaths(ctx.repoRoot)]);
    const violations = [];
    for (const p of paths) {
      const m = p.match(SLICE_KEY_PATTERN);
      if (!m || allowed.has(normalize(m[2]))) continue;
      violations.push({
        path: p,
        reason: `the loop's job is ${titles}; "${m[2]}" is another slice, which this job may not change (ADR-046). ` +
          `If the job can't build without changing it, the plan is wrong: block the job, naming the file and the line ` +
          `(plan-change, "A change other slices use")`,
      });
    }
    return violations;
  },
};
