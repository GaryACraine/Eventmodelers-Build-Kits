'use strict';

// src/workflows.ts lists every external automation's workflow for the Temporal worker (ADR-033). Like Events.ts
// (ADR-017), it only grows: a slice adds its export line and never changes or removes another's. A removed line
// here would unregister a workflow that running work may still need.

const { execSync } = require('child_process');

const WORKFLOWS = 'src/workflows.ts';

module.exports = {
  name: 'workflows-append-only',
  run(ctx) {
    if (!ctx.changes.some((c) => c.path === WORKFLOWS)) return [];
    let diff = '';
    try {
      diff = execSync(`git diff HEAD -U0 -- ${WORKFLOWS}`, { cwd: ctx.repoRoot, encoding: 'utf8' });
    } catch {
      return [];
    }
    const removed = diff
      .split('\n')
      .filter((line) => line.startsWith('-') && !line.startsWith('---'))
      .map((line) => line.slice(1).trim())
      .filter((line) => line.length > 0 && line !== 'export {}');
    return removed.map((line) => ({
      path: WORKFLOWS,
      reason: `removes or changes "${line}" — workflows.ts only grows: add your slice's export line, leave the others`,
    }));
  },
};
