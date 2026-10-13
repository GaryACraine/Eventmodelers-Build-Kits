'use strict';

// Run: node --test eventmodelers-cli/stacks/dcb/tests/checks/web-patterns.test.cjs
// A part is put together from the kit's patterns (ADR-072): the check refuses a slice's part that writes what a
// pattern owns, names the pattern, and leaves tests, deleted files and other folders alone.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const check = require(path.resolve(__dirname, '../../templates/build-kit/lib/checks/23-web-patterns.cjs'));

function run(files, status = 'A') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-patterns-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return check.run({ repoRoot: root, changes: Object.keys(files).map((p) => ({ status, path: p })) });
}

const PART = 'web/src/slices/organisation-overview/OrganisationOverviewView.tsx';

test('a part made of patterns passes', () => {
  const source = `import { DataTable, SummaryList, Value, ViewCard } from "@/components/patterns"
export function View({ id }) {
    const overview = useQuery({ queryKey: ["x", id], queryFn })
    return <ViewCard title="Organisation" read={overview}>{(o) => <SummaryList rows={[["Name", o.name]]} />}</ViewCard>
}`;
  assert.deepStrictEqual(run({ [PART]: source }), []);
});

test('a part writing what a pattern owns is refused, naming the pattern', () => {
  const source = [
    'if (overview.isPending) return <p>Loading…</p>',
    '{error && <p role="alert">{error}</p>}',
    '{done && <p role="status">Done.</p>}',
    '<table><tbody /></table>',
    '<dl><dt>Name</dt></dl>',
    '<fieldset><legend>Roles</legend></fieldset>',
    '<p style={{ fontSize: 12 }}>Organisation</p>',
    '<p className="text-[#6b7280]">x</p>',
  ].join('\n');
  const found = run({ [PART]: source });
  const by = (line) => found.find((v) => v.path === `${PART}:${line}`)?.reason ?? '';
  assert.match(by(1), /a read's states .* use ViewCard/);
  assert.match(by(2), /an alert .* written by hand: use FormCard's `error`/);
  assert.match(by(3), /a status line .* FormCard's `done`/);
  assert.match(by(4), /a <table> written by hand: use DataTable/);
  assert.match(by(5), /a <dl> written by hand: use SummaryList/);
  assert.match(by(6), /a <fieldset> written by hand: use ChoiceGroup/);
  assert.match(by(7), /inline style/);
  assert.match(by(8), /a hard-coded colour/);
  assert.match(by(1), /ADR-072\). If no pattern fits, block with request-feedback/);
});

test('tests, comments, deleted parts and files outside a slice are left alone', () => {
  assert.deepStrictEqual(run({ 'web/src/slices/x/View.test.tsx': 'expect(screen.getByRole("alert"))\n<table />' }), []);
  assert.deepStrictEqual(run({ [PART]: '// shown as <table> by DataTable, never role="alert"\n * <dl> in the mockup\n' }), []);
  assert.deepStrictEqual(run({ 'web/src/providers/paddle/Summary.tsx': '<table />' }), []);
  assert.deepStrictEqual(run({ [PART]: '<table />' }, 'D'), []);
});
