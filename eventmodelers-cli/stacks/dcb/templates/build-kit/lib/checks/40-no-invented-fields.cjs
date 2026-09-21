'use strict';

// Heuristic: flags a field name used in a DCB slice's Command/TaggedEvent type literal
// that doesn't appear anywhere in that slice's own slice.json.
//
// Not a real TS/schema-aware check — it regex-extracts fields declared inside
// `Command<'Name', { ... }>` and tagged event factory parameter types.
// Only ever adds violations for fields it is confident about; skips when
// slice.json can't be found/parsed.

const fs = require('fs');
const path = require('path');
const { findSliceJson, normalize } = require('../util/find-slice.cjs');

const COMMON_ALLOWED = new Set(
  ['id', 'userId', 'correlationId', 'causationId', 'type', 'data', 'metadata',
   'createdAt', 'updatedAt', 'timestamp', 'tags', 'event', 'position',
   'courseId', 'studentId', 'studentNumber', 'subscriptionCount', 'subscriberCount',
   'capacity', 'newCapacity', 'newTitle', 'name', 'title', 'number'].map(normalize),
);

const TYPE_LITERALS = [
  /Command<\s*"[^"]+"\s*,\s*{([^}]*)}/g,
  /Command<\s*'[^']+'\s*,\s*{([^}]*)}/g,
];

const FIELD_LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm;

function collectDeclaredFields(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectDeclaredFields(item, out);
  } else if (node && typeof node === 'object') {
    if (typeof node.name === 'string' && ('type' in node || 'optional' in node)) {
      out.add(normalize(node.name));
    }
    for (const key of Object.keys(node)) collectDeclaredFields(node[key], out);
  }
}

module.exports = {
  name: 'no-invented-fields',
  run(ctx) {
    const bySlice = new Map();

    for (const { path: p } of ctx.changes) {
      if (!p.endsWith('.ts') || p.endsWith('.tests.ts')) continue;
      // DCB path: src/contexts/{context}/slices/{slicename}/...
      const m = /^src\/contexts\/([^/]+)\/slices\/([^/]+)\//.exec(p);
      if (!m) continue;
      const key = `${m[1]}/${m[2]}`;
      if (!bySlice.has(key)) bySlice.set(key, { context: m[1], sliceName: m[2], files: [] });
      bySlice.get(key).files.push(p);
    }

    const violations = [];

    for (const { context, sliceName, files } of bySlice.values()) {
      const slice = findSliceJson(ctx.repoRoot, context, sliceName);
      if (!slice) continue;

      const declared = new Set();
      collectDeclaredFields(slice, declared);
      if (declared.size === 0) continue;

      for (const file of files) {
        let content;
        try {
          content = fs.readFileSync(path.join(ctx.repoRoot, file), 'utf8');
        } catch {
          continue;
        }

        for (const pattern of TYPE_LITERALS) {
          pattern.lastIndex = 0;
          let typeMatch;
          while ((typeMatch = pattern.exec(content))) {
            FIELD_LINE.lastIndex = 0;
            let fieldMatch;
            while ((fieldMatch = FIELD_LINE.exec(typeMatch[1]))) {
              const raw = fieldMatch[1];
              const norm = normalize(raw);
              if (COMMON_ALLOWED.has(norm) || declared.has(norm)) continue;
              violations.push({
                path: file,
                reason: `field "${raw}" is not declared anywhere in slice.json for this slice — check for an invented field`,
              });
            }
          }
        }
      }
    }

    return violations;
  },
};
