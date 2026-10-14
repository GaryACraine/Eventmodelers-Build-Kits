'use strict';

// A part is put together from the kit's patterns (ADR-072, web/src/components/patterns/), never restyled by hand. A
// slice's form or view (web/src/slices/{slice}/*.tsx, tests aside) that this commit adds or changes is refused when it
// writes itself what a pattern owns: a read's states, an alert or status line, a table, a key-facts list, a group of
// choices, or its own styling. Each refusal names the pattern. Nothing here judges looks: those are the mockup's.

const fs = require('fs');
const path = require('path');

const PART = /^web\/src\/slices\/[^/]+\/[^/]+\.tsx$/;
const TEST = /\.test\.tsx$/;

const RULES = [
  { re: /\.(isPending|isError)\b/, what: 'a read\'s states (isPending / isError)', use: 'ViewCard (or ReadStates) with the query\'s result: it shows loading, still updating, the empty state and the alert in one order' },
  { re: /role\s*=\s*["'{]\s*["']?alert/, what: 'an alert (role="alert")', use: 'FormCard\'s `error`, RowAction\'s `error`, or ViewCard (a failed read), with errorText(e) for the words' },
  { re: /role\s*=\s*["'{]\s*["']?status/, what: 'a status line (role="status")', use: 'FormCard\'s `done` (success) or ViewCard (loading)' },
  { re: /<table\b/, what: 'a <table>', use: 'DataTable (rows named, the actions column named, the empty state, Load more)' },
  { re: /<dl\b/, what: 'a <dl>', use: 'SummaryList, with Value for each value' },
  { re: /<fieldset\b/, what: 'a <fieldset>', use: 'ChoiceGroup (checkboxes or radios under their question, the error named by the group)' },
  { re: /style\s*=\s*\{\{/, what: 'inline style (style={{ … }})', use: 'the design system\'s classes and tokens (web/src/styles/design-system.css)' },
  { re: /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])/, what: 'a hard-coded colour', use: 'the design system\'s tokens (text-muted-foreground, bg-primary, …)' },
];

/** What a part's source writes that a pattern owns: [{ line, what, use }] */
function findings(source) {
  const out = [];
  source.split('\n').forEach((text, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) return; // comments
    for (const rule of RULES) if (rule.re.test(text)) out.push({ line: i + 1, what: rule.what, use: rule.use });
  });
  return out;
}

module.exports = {
  name: 'web-patterns',
  scope: 'web',
  findings,
  run(ctx) {
    const violations = [];
    for (const { status, path: p } of ctx.changes) {
      if (status === 'D' || !PART.test(p) || TEST.test(p)) continue;
      let source;
      try {
        source = fs.readFileSync(path.join(ctx.repoRoot, p), 'utf8');
      } catch {
        continue;
      }
      for (const f of findings(source)) {
        violations.push({
          path: `${p}:${f.line}`,
          reason: `${f.what} written by hand: use ${f.use} from @/components/patterns (ADR-072). If no pattern fits, block with request-feedback: the kit adds one`,
        });
      }
    }
    return violations;
  },
};
