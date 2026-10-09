'use strict';

// A context's events are its own (ADR-059): no file of one context imports another context's Events.ts, to decide
// on, project, or seed tests with them. Another context reads the owner's published read model (as the session lookup
// does) or translates its published event. Within a context, nothing changes.

const fs = require('fs');
const path = require('path');

const IN_CONTEXT = /^src\/contexts\/([^/]+)\/.+\.tsx?$/;
const EVENTS = /^src\/contexts\/([^/]+)\/Events(\.(js|ts))?$/;
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
            reason: `imports ${other[1]}'s events ("${specifier}") — a context's events are its own (ADR-059): read ${other[1]}'s published read model instead, or translate its published event`,
          });
        }
      }
    }
    return violations;
  },
};
