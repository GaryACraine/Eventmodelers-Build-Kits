'use strict';

// src/contexts/{context}/Events.ts holds every event a context records (ADR-017). Events in the store are read for
// good, so a slice commit only adds to it: a removed or changed line would leave stored events no type, or a type
// they don't fit. A released event changes only by a new version (ADR-018). A deliberate removal before release is
// a model change made outside the loop's slice commits (ADR-046).

const { execSync } = require('child_process');

const EVENTS = /^src\/contexts\/[^/]+\/Events\.ts$/;

module.exports = {
  name: 'events-append-only',
  run(ctx) {
    const violations = [];
    for (const { path: file, status } of ctx.changes.filter((c) => EVENTS.test(c.path))) {
      if (status === 'D') {
        violations.push({ path: file, reason: 'deletes the context\'s events — Events.ts only grows (ADR-017)' });
        continue;
      }
      let diff = '';
      try {
        diff = execSync(`git diff HEAD -U0 -- "${file}"`, { cwd: ctx.repoRoot, encoding: 'utf8' });
      } catch {
        continue;
      }
      const removed = diff
        .split('\n')
        .filter((line) => line.startsWith('-') && !line.startsWith('---'))
        .map((line) => line.slice(1).trim())
        .filter((line) => line.length > 0);
      for (const line of removed) {
        violations.push({
          path: file,
          reason: `removes or changes "${line}" — Events.ts only grows: add your events, leave the others; a released event changes only by a new version (ADR-017, ADR-018)`,
        });
      }
    }
    return violations;
  },
};
