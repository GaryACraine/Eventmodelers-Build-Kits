'use strict';

// Run: node --test eventmodelers-cli/stacks/dcb/tests/checks/query-checks.test.cjs
// The commit checks for ADR-023 queries: query-additive, retype-scope with addQueries, and
// extension-additive counting query blocks. Each test builds a throwaway git repo with the kit
// layout (.build-kit/.slices + a built fold-form slice), makes a change, and runs a check.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const KIT = path.resolve(__dirname, '../../../..');
const CHECKS = path.join(KIT, 'stacks/dcb/templates/build-kit/lib/checks');
const UTIL_SRC = path.join(KIT, 'shared/build-kit/lib/util');
const DCB_UTIL_SRC = path.join(KIT, 'stacks/dcb/templates/build-kit/lib/util');

const SLICE_DIR = 'src/contexts/enrollment/slices/courseseats';
const READ_MODEL = `export const courseSeats = defineReadModel<CourseSeatsDoc>({
    name: "CourseSeats",
    type: "inline-projected",
    key: "courseId",
    collection: "course_seats",
    canHandle: [
        "courseWasRegistered"
    ],
    evolve: (doc, { event }) => doc
})
`;
const TESTS = `import { describe, test } from "vitest"
import { READ_MODEL_TYPES, withType } from "../../../../shared/readModels.js"

describe.each(READ_MODEL_TYPES)("course seats (%s)", type => {
    test("shows the seats", async () => {})
})
`;
const QUERIES = `    queries: {
        availableCourses: {
            path: "/available-courses",
            params: {
                minRemainingSeats: { field: "remainingSeats", op: "gte", type: "number" }
            }
        }
    },
`;
const QUERY_TESTS = `
describe.each(queryTypes(courseSeats, "availableCourses"))("course seats: availableCourses (%s)", type => {
    test("lists courses with a free seat", async () => {})
})
`;

const querySpec = (name) => ({ given: [], when: [{ type: 'SPEC_QUERY', title: name }], then: [] });

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function edit(root, rel, fn) {
  write(root, rel, fn(read(root, rel)));
}

function repo(slice = {}, { status = 'InProgress', readModel = READ_MODEL, tests = TESTS } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-checks-'));
  const sh = (cmd) => execSync(cmd, { cwd: root, stdio: 'pipe' });
  sh('git init -q && git config user.email t@t && git config user.name t');
  write(root, `${SLICE_DIR}/readModel.ts`, readModel);
  write(root, `${SLICE_DIR}/route.tests.ts`, tests);
  sh('git add -A && git commit -q -m init');

  write(root, '.build-kit/.slices/current_context.json', JSON.stringify({ name: 'enrollment' }));
  write(root, '.build-kit/.slices/enrollment/index.json',
    JSON.stringify({ slices: [{ id: 'v1', folder: 'courseseats', status }] }));
  write(root, '.build-kit/.slices/enrollment/courseseats/slice.json', JSON.stringify({
    id: 'v1',
    title: 'course seats',
    addQueries: ['availableCourses'],
    specifications: [{ given: [], when: [], then: [] }, querySpec('availableCourses')],
    ...slice,
  }));
  fs.cpSync(UTIL_SRC, path.join(root, 'lib/util'), { recursive: true });
  fs.cpSync(DCB_UTIL_SRC, path.join(root, 'lib/util'), { recursive: true });
  fs.cpSync(CHECKS, path.join(root, 'lib/checks'), { recursive: true });
  return root;
}

function run(root, file, changed) {
  const check = require(path.join(root, 'lib/checks', file));
  return check.run({ repoRoot: root, changes: changed.map((p) => ({ status: 'M', path: p })) });
}

const RM = `${SLICE_DIR}/readModel.ts`;
const RT = `${SLICE_DIR}/route.tests.ts`;
const queryAdditive = (root, changed = [RM, RT]) => run(root, '16-query-additive.cjs', changed);

// The A4/A5 edit: queries inserted before evolve, a query block appended, queryTypes imported.
function addQuery(root) {
  edit(root, RM, (s) => s.replace('    evolve:', `${QUERIES}    evolve:`));
  edit(root, RT, (s) => s.replace('READ_MODEL_TYPES, withType', 'READ_MODEL_TYPES, queryTypes, withType') + QUERY_TESTS);
}

// --- query-additive -------------------------------------------------------------------------

test('query-additive: inserting queries, a query block and the queryTypes import passes', () => {
  const root = repo();
  addQuery(root);
  assert.deepStrictEqual(queryAdditive(root), []);
});

test('query-additive: appending to an existing queries block (`}` re-added as `},`) passes', () => {
  const existing = READ_MODEL.replace('    evolve:', `${QUERIES.replace('availableCourses', 'fullCourses')}    evolve:`);
  const root = repo({}, { readModel: existing });
  edit(root, RM, (s) => s.replace(
    '            }\n        }\n    },',
    '            }\n        },\n        availableCourses: {\n            params: {}\n        }\n    },',
  ));
  edit(root, RT, (s) => s + QUERY_TESTS);
  assert.deepStrictEqual(queryAdditive(root), []);
});

test('query-additive: a change outside the queries block is rejected', () => {
  const root = repo();
  addQuery(root);
  edit(root, RM, (s) => s.replace('"courseWasRegistered"', '"courseWasRegistered",\n        "courseWasCancelled"'));
  const v = queryAdditive(root);
  // Both canHandle lines: the `,` re-add is only allowed inside the queries block.
  assert.strictEqual(v.length, 2);
  assert.ok(v.every((x) => /outside the queries block/.test(x.reason)));
});

test('query-additive: a removed line is rejected', () => {
  const root = repo();
  addQuery(root);
  edit(root, RM, (s) => s.replace('    collection: "course_seats",\n', ''));
  const v = queryAdditive(root);
  assert.strictEqual(v.length, 1);
  assert.match(v[0].reason, /removed\/changed line: collection/);
});

test('query-additive: every addQueries name must be declared', () => {
  const root = repo({ addQueries: ['availableCourses', 'fullCourses'] });
  addQuery(root);
  edit(root, RT, (s) => s + QUERY_TESTS.replaceAll('availableCourses', 'fullCourses'));
  const v = queryAdditive(root);
  assert.strictEqual(v.length, 1);
  assert.match(v[0].reason, /"fullCourses" but readModel.ts doesn't declare it/);
});

test('query-additive: the tests must change, with a block per added query', () => {
  const root = repo();
  addQuery(root);
  write(root, RT, TESTS);
  let v = queryAdditive(root, [RM]);
  assert.strictEqual(v.length, 1);
  assert.match(v[0].reason, /needs their tests/);

  write(root, RT, `${TESTS}\ndescribe("something else", () => { test("x", () => {}) })\n`);
  v = queryAdditive(root);
  assert.strictEqual(v.length, 1);
  assert.match(v[0].reason, /no describe.each\(queryTypes\(…\)\)\("course seats: availableCourses \(%s\)"\)/);
});

test('query-additive: one test per specification that runs the query', () => {
  const root = repo({
    specifications: [querySpec('availableCourses'), querySpec('availableCourses')],
  });
  addQuery(root);
  const v = queryAdditive(root);
  assert.strictEqual(v.length, 1);
  assert.match(v[0].reason, /has 1 test\(\.\.\.\) block\(s\) but 2 specification\(s\) run availableCourses/);
});

test('query-additive: existing tests stay as they are', () => {
  const root = repo();
  addQuery(root);
  edit(root, RT, (s) => s.replace('test("shows the seats"', 'test("shows seats"'));
  const v = queryAdditive(root);
  assert.strictEqual(v.length, 1);
  assert.match(v[0].reason, /removed\/changed line: test\("shows the seats"/);
});

test('query-additive: other slice files and other slices are rejected', () => {
  const root = repo();
  addQuery(root);
  const v = queryAdditive(root, [RM, RT, `${SLICE_DIR}/route.ts`, 'src/contexts/enrollment/slices/other/readModel.ts']);
  assert.deepStrictEqual(v.map((x) => x.path), [`${SLICE_DIR}/route.ts`, 'src/contexts/enrollment/slices/other/readModel.ts']);
});

test('query-additive: the type line is off limits without a retype', () => {
  const root = repo();
  addQuery(root);
  edit(root, RM, (s) => s.replace('type: "inline-projected"', 'type: "live-report"'));
  const v = queryAdditive(root);
  assert.strictEqual(v.length, 2);
  assert.ok(v.every((x) => /doesn't change the read model's type/.test(x.reason)));
});

test('query-additive: does nothing without addQueries, when not in progress, or for an extension', () => {
  for (const root of [
    repo({ addQueries: undefined }),
    repo({}, { status: 'Planned' }),
    repo({ extends: { originContext: 'enrollment', originSliceTitle: 'course seats' } }),
  ]) {
    edit(root, RM, (s) => s.replace('"course_seats"', '"seats"'));
    assert.deepStrictEqual(queryAdditive(root), []);
  }
});

// --- retype-scope with addQueries -----------------------------------------------------------

const RETYPE = { retype: { from: 'inline-projected', to: 'live-report' } };
const retypeScope = (root, changed) => run(root, '17-retype-scope.cjs', changed);

test('retype + addQueries: the retype commit is a one-line type change, and query-additive agrees', () => {
  const root = repo(RETYPE);
  edit(root, RM, (s) => s.replace('type: "inline-projected"', 'type: "live-report"'));
  assert.deepStrictEqual(retypeScope(root, [RM]), []);
  assert.deepStrictEqual(queryAdditive(root, [RM]), []);
});

test('retype + addQueries: the queries commit after it passes both checks', () => {
  const root = repo(RETYPE, { readModel: READ_MODEL.replace('inline-projected', 'live-report') });
  addQuery(root);
  assert.deepStrictEqual(retypeScope(root, [RM, RT]), []);
  assert.deepStrictEqual(queryAdditive(root), []);
});

test('retype + addQueries: the type change and the queries in one commit is rejected', () => {
  const root = repo(RETYPE);
  addQuery(root);
  edit(root, RM, (s) => s.replace('type: "inline-projected"', 'type: "live-report"'));
  const v = retypeScope(root, [RM, RT]);
  assert.deepStrictEqual(v.map((x) => x.path), [RT, RM]);
});

test('retype without addQueries still rejects query lines', () => {
  const root = repo({ ...RETYPE, addQueries: undefined });
  addQuery(root);
  assert.ok(retypeScope(root, [RM, RT]).length > 0);
});

// --- extension-additive counting query blocks -----------------------------------------------

const EXT = {
  id: 'v1',
  title: 'course seats capacity',
  extends: { originContext: 'enrollment', originSliceTitle: 'courseseats' },
  addQueries: undefined,
};
const EXT_KEYED = `
describe.each(READ_MODEL_TYPES)("course seats capacity (%s)", type => {
    test("shows capacity", async () => {})
})
`;
const EXT_QUERY = `
describe.each(queryTypes(courseSeats, "availableCourses"))("course seats capacity: availableCourses (%s)", type => {
    test("lists courses with a free seat", async () => {})
})
`;
const TRAILING = `
describe("course seats later", () => {
    test("a", () => {})
    test("b", () => {})
})
`;
const extensionAdditive = (root) => run(root, '15-extension-additive.cjs', [RM, RT]);

test('extension-additive: tests in the extension\'s keyed and query blocks count together', () => {
  const root = repo(EXT);
  edit(root, RM, (s) => s.replace('    evolve:', `${QUERIES}    evolve:`));
  edit(root, RT, (s) => s + EXT_KEYED + EXT_QUERY);
  assert.deepStrictEqual(extensionAdditive(root), []);
});

test('extension-additive: a query block ends at the next top-level describe', () => {
  const root = repo({ ...EXT, specifications: [querySpec('availableCourses'), querySpec('availableCourses')] });
  edit(root, RT, (s) => s + EXT_QUERY + TRAILING);
  const v = extensionAdditive(root);
  assert.strictEqual(v.length, 1);
  assert.match(v[0].reason, /have 1 test\(\.\.\.\) block\(s\) but the extension declares 2/);
});

// --- spec-coverage --------------------------------------------------------------------------

test('spec-coverage: query tests count towards the slice file', () => {
  const root = repo();
  addQuery(root);
  fs.mkdirSync(path.join(root, '.build-kit/.slices/enrollment/courseseats'), { recursive: true });
  assert.deepStrictEqual(run(root, '50-spec-coverage.cjs', [RT]), []);
});
