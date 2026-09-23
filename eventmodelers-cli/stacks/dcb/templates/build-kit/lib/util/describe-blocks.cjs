'use strict';

// Top-level describe blocks in a DCB route.tests.ts, for the commit checks that count a slice's tests.
//
// A block starts at a line-leading `describe("title", …)` or `describe.each(…)("title", …)` — the
// `.each` argument may nest one level of calls, as in `describe.each(queryTypes(courseSeats, "q"))`
// (ADR-023 query blocks) — and runs to the next top-level describe or the end of the file.

const TOP_LEVEL_DESCRIBE = /^describe(?:\.each\((?:[^()]|\([^()]*\))*\))?\(\s*(["'`])((?:\\.|(?!\1).)*)\1/gm;
const TEST_BLOCK = /\b(?:test|it)(?:\.(?:only|skip))?\s*\(/g;

/** [{ title, tests }] for every top-level describe block, in file order. */
function describeBlocks(content) {
  const starts = [...content.matchAll(TOP_LEVEL_DESCRIBE)].map((m) => ({ index: m.index, title: m[2] }));
  return starts.map(({ index, title }, i) => {
    const block = content.slice(index, i + 1 < starts.length ? starts[i + 1].index : content.length);
    return { title, tests: (block.match(TEST_BLOCK) || []).length };
  });
}

/** `title`, or a fold-form contract block `title (%s)`. */
function isSliceBlock(blockTitle, sliceTitle) {
  return blockTitle === sliceTitle || blockTitle === `${sliceTitle} (%s)`;
}

/** A query block (build-state-view Step 6b): `{slice title}: {query} (%s)`. Returns the query name or null. */
function queryOfBlock(blockTitle, sliceTitle) {
  const prefix = `${sliceTitle}: `;
  if (!blockTitle.startsWith(prefix) || !blockTitle.endsWith(' (%s)')) return null;
  return blockTitle.slice(prefix.length, -' (%s)'.length) || null;
}

/** Specifications per query name: the title of each spec's *when* SPEC_QUERY step. */
function specsPerQuery(slice) {
  const counts = new Map();
  for (const spec of Array.isArray(slice?.specifications) ? slice.specifications : []) {
    for (const step of Array.isArray(spec?.when) ? spec.when : []) {
      if (step?.type === 'SPEC_QUERY' && step.title) counts.set(step.title, (counts.get(step.title) || 0) + 1);
    }
  }
  return counts;
}

module.exports = { describeBlocks, isSliceBlock, queryOfBlock, specsPerQuery };
