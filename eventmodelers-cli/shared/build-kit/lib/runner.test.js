// node --test shared/build-kit/lib/runner.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  appendMetrics, describeSettings, jobSettings, metricsLine, metricsPath, resetTime, settingsArgs, usageLimit, usageLimitWaitMs,
} from './runner.js';

test("a project pins its jobs' model, effort and budget; a concern's own setting wins over the default", () => {
  const cfg = { models: { backend: 'sonnet' }, model: 'opus', effort: 'medium', efforts: { ui: 'low' }, maxBudgetUsd: 2 };
  assert.deepEqual(jobSettings(cfg, 'backend', {}), { model: 'sonnet', effort: 'medium', maxBudgetUsd: 2 });
  assert.deepEqual(jobSettings(cfg, 'ui', {}), { model: 'opus', effort: 'low', maxBudgetUsd: 2 });
  assert.deepEqual(settingsArgs(jobSettings(cfg, 'backend', {})), ['--model', 'sonnet', '--effort', 'medium', '--max-budget-usd', '2']);
});

test('the RALPH_ environment overrides the config for one run', () => {
  const cfg = { models: { backend: 'sonnet' }, effort: 'medium', maxBudgetUsd: 2 };
  const env = { RALPH_MODEL: 'opus', RALPH_EFFORT: 'high', RALPH_MAX_BUDGET_USD: '5' };
  assert.deepEqual(jobSettings(cfg, 'backend', env), { model: 'opus', effort: 'high', maxBudgetUsd: 5 });
});

test("nothing set: no arguments, so the job inherits the developer's own settings, and the startup line says so", () => {
  const settings = jobSettings({}, 'backend', {});
  assert.deepEqual(settingsArgs(settings), []);
  assert.match(describeSettings(settings), /model inherited from ~\/\.claude\/settings\.json, effort inherited/);
  assert.equal(describeSettings({ model: 'sonnet', effort: 'medium', maxBudgetUsd: 2 }), 'sonnet, effort medium, up to $2 a job');
});

test('an unknown effort or a budget that is not a positive number is refused', () => {
  assert.throws(() => jobSettings({ effort: 'huge' }, 'backend', {}), /isn't one of low, medium, high, xhigh, max/);
  assert.throws(() => jobSettings({ maxBudgetUsd: 'lots' }, 'backend', {}), /must be a positive number/);
});

test('a usage limit is told apart from other failures, with its reset time when the text carries one', () => {
  const limit = usageLimit({ is_error: true, result: 'Claude AI usage limit reached|1790590000' });
  assert.equal(limit.resetAt.getTime(), 1790590000 * 1000);
  assert.ok(usageLimit({ is_error: true, result: "You've hit your limit · resets 3pm (Europe/London)" }));
  assert.equal(usageLimit({ is_error: true, result: 'Tests failed' }), null);
  assert.equal(usageLimit({ is_error: false, result: 'usage limit reached' }), null);
  assert.equal(usageLimit(undefined), null);
});

test("a session limit is a usage limit, and its reset time is read in its time zone", () => {
  const now = Date.UTC(2026, 8, 29, 11, 6, 0); // 12:06 in the Isle of Man (BST, UTC+1)
  const limit = usageLimit({ is_error: true, result: "You've hit your session limit · resets 12:40pm (Europe/Isle_of_Man)" }, now);
  assert.ok(limit);
  assert.equal(limit.resetAt.toISOString(), '2026-09-29T11:40:00.000Z');
  assert.equal(resetTime('resets 3pm (Europe/London)', now).toISOString(), '2026-09-29T14:00:00.000Z');
  // Already past today: tomorrow
  assert.equal(resetTime('resets 9am (Europe/London)', now).toISOString(), '2026-09-30T08:00:00.000Z');
  assert.equal(resetTime('resets 12:40pm (Not/AZone)', now), undefined);
});

test('the loop waits until the reset (plus a minute), or 15 minutes when it is unknown', () => {
  const now = Date.UTC(2026, 8, 28, 12, 0, 0);
  assert.equal(usageLimitWaitMs({ resetAt: new Date(now + 30 * 60_000) }, now), 31 * 60_000);
  assert.equal(usageLimitWaitMs({ resetAt: new Date(now - 60_000) }, now), 60_000);
  assert.equal(usageLimitWaitMs({}, now), 15 * 60_000);
});

test("a job's metrics line: the slice, what it ran on, its cost, tokens, outcome and commit", () => {
  const kitDir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const result = {
    model: 'claude-sonnet-5', duration_ms: 70000, total_cost_usd: 0.61, num_turns: 34,
    usage: { input_tokens: 12, cache_read_input_tokens: 540000, cache_creation_input_tokens: 9000, output_tokens: 6000 },
  };
  const line = metricsLine({
    at: new Date('2026-09-28T12:00:00Z'),
    planned: { id: 's1', title: 'mark order paid', concern: 'backend', ctx: 'restaurant' },
    settings: { model: 'sonnet', effort: 'medium' },
    result, outcome: 'Done', commit: 'ba76f96',
  });
  appendMetrics(kitDir, line);
  appendMetrics(kitDir, { ...line, slice: 'second' });
  const lines = readFileSync(metricsPath(kitDir), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], {
    at: '2026-09-28T12:00:00.000Z', slice: 'mark order paid', sliceId: 's1', concern: 'backend', context: 'restaurant',
    model: 'claude-sonnet-5', effort: 'medium', outcome: 'Done', durationMs: 70000, costUsd: 0.61, turns: 34,
    tokens: { input: 12, cacheRead: 540000, cacheWrite: 9000, output: 6000 }, commit: 'ba76f96',
  });
});
