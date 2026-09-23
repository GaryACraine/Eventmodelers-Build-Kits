'use strict';

// Every route a DCB slice serves is in /openapi.json, so a frontend can generate its client from it
// (PLAN 14.1). For each slice folder the commit touches that has a route.ts:
//
//  1. each hand-written route — router.get/post/put/patch/delete("<path>", …) — has a matching
//     registerCommand({ method, path }) or registerRead({ path }) (GET) in the slice's schema.ts,
//     with the path written exactly as route.ts writes it;
//  2. route.ts imports ./schema.js, so the registration runs when the route is wired;
//  3. each readModelRoute(…) call passes `schema:` (the document's Zod schema from schema.ts). The
//     route documents the keyed GET and every query itself from it; tsc checks it against the Doc.
//
// The openapi slice's own /openapi.json is exempt.

const fs = require('fs');
const path = require('path');

const SLICE_KEY_PATTERN = /^src\/contexts\/([^/]+)\/slices\/([^/]+)\//;
const ROUTE_CALL = /router\.(get|post|put|patch|delete)\(\s*(["'`])([^"'`]+)\2/g;
const REGISTER_CALL = /register(Command|Read)\(\s*\{/g;
const EXEMPT_PATHS = new Set(['/openapi.json']);
const READ_MODEL_ROUTE = /readModelRoute\s*\(/g;

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// The text of the bracketed expression starting at `open` (the index of its `{` or `(`), balanced.
function balancedAt(text, open) {
  const [o, c] = text[open] === '(' ? ['(', ')'] : ['{', '}'];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === o) depth++;
    else if (text[i] === c && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

function registrations(schemaText) {
  const found = new Set();
  for (const m of schemaText.matchAll(REGISTER_CALL)) {
    const body = balancedAt(schemaText, m.index + m[0].length - 1);
    const p = /\bpath\s*:\s*(["'`])([^"'`]+)\1/.exec(body)?.[2];
    if (!p) continue;
    const method = m[1] === 'Read' ? 'get' : /\bmethod\s*:\s*(["'`])(\w+)\1/.exec(body)?.[2];
    if (method) found.add(`${method} ${p}`);
  }
  return found;
}

module.exports = {
  name: 'openapi-registered',
  run(ctx) {
    const sliceDirs = new Set();
    for (const { path: p } of ctx.changes) {
      const m = p.match(SLICE_KEY_PATTERN);
      if (m) sliceDirs.add(`src/contexts/${m[1]}/slices/${m[2]}`);
    }

    const violations = [];
    for (const dir of sliceDirs) {
      const route = readText(path.join(ctx.repoRoot, dir, 'route.ts'));
      if (!route) continue;

      for (const m of route.matchAll(READ_MODEL_ROUTE)) {
        if (!/\bschema\s*:/.test(balancedAt(route, m.index + m[0].length - 1))) {
          violations.push({
            path: `${dir}/route.ts`,
            reason: 'readModelRoute(…) has no `schema:` — pass the document\'s Zod schema from schema.ts, so /openapi.json shows its body',
          });
        }
      }

      const routes = new Set();
      for (const m of route.matchAll(ROUTE_CALL)) {
        if (!EXEMPT_PATHS.has(m[3])) routes.add(`${m[1]} ${m[3]}`);
      }
      if (routes.size === 0) continue;

      const schema = readText(path.join(ctx.repoRoot, dir, 'schema.ts'));
      if (schema === null) {
        violations.push({
          path: `${dir}/schema.ts`,
          reason: `missing — route.ts serves ${[...routes].map((r) => r.replace(/^\w+/, (m) => m.toUpperCase())).join(', ')}; document each with registerCommand/registerRead (src/shared/openapi.ts)`,
        });
        continue;
      }
      const registered = registrations(schema);
      for (const r of routes) {
        if (!registered.has(r)) {
          const [method, p] = r.split(' ');
          violations.push({
            path: `${dir}/schema.ts`,
            reason: `route.ts serves ${method.toUpperCase()} ${p} but schema.ts doesn't register it — add ${
              method === 'get' ? 'registerRead' : 'registerCommand'
            }({ ${method === 'get' ? '' : `method: "${method}", `}path: "${p}", … }) so it reaches /openapi.json`,
          });
        }
      }
      if (!/(?:from\s+|import\s+)(["'`])\.\/schema\.js\1/.test(route)) {
        violations.push({
          path: `${dir}/route.ts`,
          reason: 'does not import ./schema.js, so its OpenAPI registration never runs',
        });
      }
    }
    return violations;
  },
};
