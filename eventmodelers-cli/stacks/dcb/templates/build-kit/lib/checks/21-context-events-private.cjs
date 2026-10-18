'use strict';

// A context's events are its own (ADR-059): no file of one context imports another context's Events.ts, to decide
// on, project, or seed tests with them. Another context reads the owner's published read model (as the session lookup
// does) or its published events, from the owner's Published.ts (ADR-073). Within a context, nothing changes.
// Published.ts holds only the published events, so it never imports its own Events.ts (it would hand internal events
// to every reader); Events.ts re-exports it instead.

const fs = require('fs');
const path = require('path');

const IN_CONTEXT = /^src\/contexts\/([^/]+)\/.+\.tsx?$/;
const EVENTS = /^src\/contexts\/([^/]+)\/Events(\.(js|ts))?$/;
const PUBLISHED = /^src\/contexts\/([^/]+)\/Published\.tsx?$/;
const IMPORT = /(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

module.exports = {
  name: 'context-events-private',
  run(ctx) {
    const violations = [];
    for (const { path: file, status } of ctx.changes) {
      if (status === 'D') continue;
      const own = IN_CONTEXT.exec(file);
      if (!own) continue;
      let source;
      try {
        source = fs.readFileSync(path.join(ctx.repoRoot, file), 'utf8');
      } catch {
        continue;
      }
      for (const match of source.matchAll(IMPORT)) {
        const specifier = match[1] || match[2];
        if (!specifier.startsWith('.')) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        const other = EVENTS.exec(target);
        if (other && other[1] !== own[1]) {
          violations.push({
            path: file,
            reason: `imports ${other[1]}'s events ("${specifier}") — a context's events are its own (ADR-059): read ${other[1]}'s published read model instead, or a published event from src/contexts/${other[1]}/Published.ts (ADR-073)`,
          });
        } else if (other && PUBLISHED.test(file)) {
          violations.push({
            path: file,
            reason: `Published.ts imports its own Events ("${specifier}") — it holds only the published events, which other contexts read (ADR-073): define them here, and re-export them from Events.ts`,
          });
        }
      }
    }
    return violations;
  },
};
