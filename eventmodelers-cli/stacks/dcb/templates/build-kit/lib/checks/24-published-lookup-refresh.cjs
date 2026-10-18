'use strict';

// A read model that folds another context's published event declares `refresh` (ADR-074). A published event carries
// the owner's *current* details (ADR-073), so the value changes after a document shows it, and without `refresh` the
// document keeps the old one until an event of its own key arrives. Fold form only: a changed readModel.ts naming
// an event another context's Published.ts defines must declare `refresh`.

const fs = require('fs');
const path = require('path');

const READ_MODEL = /^src\/contexts\/([^/]+)\/slices\/[^/]+\/readModel\.ts$/;
const EVENT_TYPE = /type:\s*["'`](\w+)["'`]/g;

function publishedByOthers(repoRoot, own) {
  const names = new Map();
  let contexts;
  try {
    contexts = fs.readdirSync(path.join(repoRoot, 'src', 'contexts'));
  } catch {
    return names;
  }
  for (const context of contexts) {
    if (context === own) continue;
    let source;
    try {
      source = fs.readFileSync(path.join(repoRoot, 'src', 'contexts', context, 'Published.ts'), 'utf8');
    } catch {
      continue;
    }
    for (const match of source.matchAll(EVENT_TYPE)) names.set(match[1], context);
  }
  return names;
}

module.exports = {
  name: 'published-lookup-refresh',
  run(ctx) {
    const violations = [];
    for (const { path: file, status } of ctx.changes) {
      if (status === 'D') continue;
      const own = READ_MODEL.exec(file);
      if (!own) continue;
      let source;
      try {
        source = fs.readFileSync(path.join(ctx.repoRoot, file), 'utf8');
      } catch {
        continue;
      }
      if (/\brefresh\s*[:(]/.test(source)) continue;
      for (const [name, owner] of publishedByOthers(ctx.repoRoot, own[1])) {
        if (!new RegExp(`["'\`]${name}["'\`]`).test(source)) continue;
        violations.push({
          path: file,
          reason: `folds ${owner}'s published event ${name} in a lookup without \`refresh\` — its details change after a document shows them, so declare refresh(doc, relatedId, entry) on that lookup to put the new value on every document showing it (ADR-074, build-state-view)`,
        });
      }
    }
    return violations;
  },
};
