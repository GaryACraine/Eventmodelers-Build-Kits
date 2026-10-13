'use strict';

// An event's tags are the model's (ADR-071): slice.json gives each event its `eventTags`, and a new event factory in
// src/contexts/{context}/Events.ts is written with exactly those, an optional one as a conditional spread
// (`...(paddleEventId ? { paddleEventId } : {})`). Only a factory this commit adds is checked: an existing one changes
// only by a deliberate tag change outside the loop (plan-change). An event no slice.json gives `eventTags` (an export
// from before ADR-071) isn't checked.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const EVENTS = /^src\/contexts\/([^/]+)\/Events\.ts$/;

/** The tags of each event factory in an Events.ts: { name: [{ key, optional }] } */
function factoryTags(source) {
  const out = {};
  const factory = /type:\s*"(\w+)"[\s\S]*?tags:\s*Tags\.fromObj\(\{([\s\S]*?)\}\s*\)/g;
  let m;
  while ((m = factory.exec(source)) !== null) {
    const keys = [];
    const body = m[2];
    const conditional = /\.\.\.\(\s*[^?]*\?\s*\{\s*(\w+)/g;
    let c;
    while ((c = conditional.exec(body)) !== null) keys.push({ key: c[1], optional: true });
    const plain = body.replace(/\.\.\.\([^)]*\)/g, '');
    for (const part of plain.split(',')) {
      const key = part.split(':')[0].trim();
      if (/^\w+$/.test(key)) keys.push({ key, optional: false });
    }
    out[m[1]] = keys;
  }
  return out;
}

/** The tags the model gives each event, from every slice.json of the context: { name: [{ key, optional }] } */
function modelTags(repoRoot, context) {
  const out = {};
  const dir = path.join(repoRoot, '.build-kit/.slices', context);
  if (!fs.existsSync(dir)) return out;
  for (const folder of fs.readdirSync(dir)) {
    let slice;
    try {
      slice = JSON.parse(fs.readFileSync(path.join(dir, folder, 'slice.json'), 'utf8'));
    } catch {
      continue;
    }
    for (const e of slice.events ?? []) {
      if (Array.isArray(e.eventTags) && !out[e.title]) out[e.title] = e.eventTags.map((t) => ({ key: t.key, optional: !!t.optional }));
    }
  }
  return out;
}

const describe = (tags) => tags.map((t) => t.key + (t.optional ? ' (when present)' : '')).sort().join(', ') || 'none';

module.exports = {
  name: 'event-tags',
  run(ctx) {
    const violations = [];
    for (const { path: file, status } of ctx.changes.filter((c) => EVENTS.test(c.path))) {
      if (status === 'D') continue;
      const context = file.match(EVENTS)[1];
      let before = '';
      try {
        before = execSync(`git show HEAD:"${file}"`, { cwd: ctx.repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        before = '';
      }
      const after = fs.readFileSync(path.join(ctx.repoRoot, file), 'utf8');
      const existing = factoryTags(before);
      const model = modelTags(ctx.repoRoot, context);
      for (const [name, tags] of Object.entries(factoryTags(after))) {
        if (existing[name] || !model[name]) continue;
        if (describe(tags) !== describe(model[name])) {
          violations.push({
            path: file,
            reason: `${name} is tagged ${describe(tags)}, but the model's eventTags are ${describe(model[name])}: write exactly the model's tags (ADR-071); if a rule needs others, block the job and say which (the model changes)`,
          });
        }
      }
    }
    return violations;
  },
};
