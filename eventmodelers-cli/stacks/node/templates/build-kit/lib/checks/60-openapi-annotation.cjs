'use strict';

// Every HTTP handler in a slice's routes.ts must carry an `@openapi` JSDoc block
// directly above it. src/swagger.ts builds the published OpenAPI document by
// scanning ./src/slices/**/routes.ts for those blocks, so a handler without one
// is a working endpoint that never appears in Swagger UI (/api-docs) or in
// /swagger.json — and swagger.ts itself is shared infra a slice commit may not
// touch, so the block in routes.ts is the only place the endpoint can be
// documented. See the build-state-change / build-state-view SKILL.md files for
// the block template and the slice.json -> OpenAPI field mapping.
//
// Heuristic, not an OpenAPI parser: it checks that a block exists between the
// previous handler and this one, and that the block names this handler's own
// path (express `:param` rewritten as `{param}`). An invalid schema, or a
// placeholder left unreplaced, still slips through — the rendered /api-docs
// page is the real check.

const fs = require('fs');
const path = require('path');

const ROUTES_FILE = /^src\/slices\/[^/]+\/[^/]+\/routes\.ts$/;
const ROUTE_CALL = /\brouter\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]+)\2/g;
const OPENAPI_BLOCK = /\/\*\*(?:[\s\S]*?)@openapi(?:[\s\S]*?)\*\//g;

// /api/foo/:id -> /api/foo/{id}
const toOpenApiPath = (p) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

module.exports = {
  name: 'openapi-annotation',
  run(ctx) {
    const violations = [];

    for (const { path: p } of ctx.changes) {
      if (!ROUTES_FILE.test(p)) continue;

      let content;
      try {
        content = fs.readFileSync(path.join(ctx.repoRoot, p), 'utf8');
      } catch {
        continue; // deleted — nothing to check
      }

      ROUTE_CALL.lastIndex = 0;
      let cursor = 0; // start of the text belonging to the handler being checked
      let call;
      while ((call = ROUTE_CALL.exec(content))) {
        const [, method, , routePath] = call;
        const preceding = content.slice(cursor, call.index);
        cursor = ROUTE_CALL.lastIndex;

        const blocks = preceding.match(OPENAPI_BLOCK) || [];
        if (blocks.length === 0) {
          violations.push({
            path: p,
            reason: `${method.toUpperCase()} ${routePath} has no @openapi JSDoc block above it — the endpoint would be missing from /api-docs and /swagger.json`,
          });
          continue;
        }

        const documented = toOpenApiPath(routePath);
        if (!blocks[blocks.length - 1].includes(documented)) {
          violations.push({
            path: p,
            reason: `the @openapi block above ${method.toUpperCase()} ${routePath} does not document "${documented}" — the path key must match the registered route, with express ":param" written as "{param}"`,
          });
        }
      }
    }

    return violations;
  },
};
