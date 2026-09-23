'use strict';

// Run: node --test eventmodelers-cli/stacks/dcb/tests/checks/openapi-registered.test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHECK = require(path.resolve(__dirname, '../../templates/build-kit/lib/checks/60-openapi-registered.cjs'));
const DIR = 'src/contexts/enrollment/slices/changecapacity';

function run(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-registered-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CHECK.run({ repoRoot: root, changes: Object.keys(files).map((p) => ({ status: 'A', path: p })) });
}

const ROUTE = `import { validateBody } from "@dcb-es/event-store-express"
import { ChangeCapacitySchema } from "./schema.js"
export const r = router => {
    router.put(
        "/courses/:courseId/capacity",
        validateBody(ChangeCapacitySchema),
        on(async req => ok)
    )
}
`;

const SCHEMA = `export const ChangeCapacitySchema = z.object({ newCapacity: z.number() })
registerCommand({
    method: "put",
    path: "/courses/:courseId/capacity",
    summary: "Change capacity",
    body: ChangeCapacitySchema,
    success: "noContent",
    errors: { 404: "Course not found" }
})
`;

test('a route registered with the same method and path passes', () => {
  assert.deepStrictEqual(run({ [`${DIR}/route.ts`]: ROUTE, [`${DIR}/schema.ts`]: SCHEMA }), []);
});

test('a route with no registration is rejected', () => {
  const v = run({ [`${DIR}/route.ts`]: ROUTE, [`${DIR}/schema.ts`]: 'export const ChangeCapacitySchema = z.object({})\n' });
  assert.strictEqual(v.length, 1);
  assert.match(v[0].reason, /PUT \/courses\/:courseId\/capacity/);
});

test('a registration with another method or path is rejected', () => {
  const v = run({ [`${DIR}/route.ts`]: ROUTE, [`${DIR}/schema.ts`]: SCHEMA.replace('method: "put"', 'method: "post"') });
  assert.strictEqual(v.length, 1);
  const w = run({ [`${DIR}/route.ts`]: ROUTE, [`${DIR}/schema.ts`]: SCHEMA.replace('/capacity"', '/cap"') });
  assert.strictEqual(w.length, 1);
});

test('a missing schema.ts is rejected', () => {
  const v = run({ [`${DIR}/route.ts`]: ROUTE });
  assert.strictEqual(v.length, 1);
  assert.match(v[0].reason, /missing/);
});

test('route.ts must import ./schema.js', () => {
  const route = ROUTE.replace('import { ChangeCapacitySchema } from "./schema.js"\n', '');
  const v = run({ [`${DIR}/route.ts`]: route, [`${DIR}/schema.ts`]: SCHEMA });
  assert.strictEqual(v.length, 1);
  assert.match(v[0].reason, /does not import/);
  assert.deepStrictEqual(run({ [`${DIR}/route.ts`]: `import "./schema.js"\n${route}`, [`${DIR}/schema.ts`]: SCHEMA }), []);
});

test('a GET needs registerRead; preferWait on the same path counts once', () => {
  const route = `import "./schema.js"
export const r = router => {
    if (waitFn) router.get("/students/:studentId", preferWait({ waitFn }))
    router.get("/students/:studentId", on(async req => ok))
}
`;
  assert.strictEqual(run({ [`${DIR}/route.ts`]: route, [`${DIR}/schema.ts`]: '' }).length, 1);
  const schema = 'registerRead({ path: "/students/:studentId", summary: "Get", response: StudentSchema, wait: true })\n';
  assert.deepStrictEqual(run({ [`${DIR}/route.ts`]: route, [`${DIR}/schema.ts`]: schema }), []);
});

test('readModelRoute needs a schema option, and nothing in schema.ts', () => {
  const route = (options) => `import { S } from "./schema.js"
export const r = deps =>
    readModelRoute(courseSeats, deps.readModels!, "/course-seats/:courseId", {
${options}
    })
`;
  assert.deepStrictEqual(run({ [`${DIR}/route.ts`]: route('        schema: S,\n        pool: deps.pool'), [`${DIR}/readModel.ts`]: '' }), []);
  const v = run({ [`${DIR}/route.ts`]: route('        pool: deps.pool'), [`${DIR}/readModel.ts`]: '' });
  assert.strictEqual(v.length, 1);
  assert.match(v[0].reason, /no `schema:`/);
  const bare = 'export const r = deps => readModelRoute(courseSeats, deps.readModels!, "/course-seats/:courseId")\n';
  assert.strictEqual(run({ [`${DIR}/route.ts`]: bare }).length, 1);
});

test('slices without a route, and /openapi.json, need nothing', () => {
  assert.deepStrictEqual(run({ [`${DIR}/processor.ts`]: '' }), []);
  const openapi = 'export const r = router => router.get("/openapi.json", (_req, res) => res.json(doc))\n';
  assert.deepStrictEqual(run({ ['src/contexts/enrollment/slices/openapi/route.ts']: openapi }), []);
});
