// What a loop job runs on, what it cost, and how a usage limit is told apart from a crash (PLAN 15.9).
//
// A project pins the loop's model, effort and per-job budget in .eventmodelers/config.json, so runs don't inherit
// whatever the developer's own ~/.claude/settings.json says:
//
//   { "models": { "backend": "sonnet", "ui": "sonnet" }, "effort": "medium", "maxBudgetUsd": 2 }
//
// Each has a per-concern form (`models`, `efforts`, `maxBudgetsUsd`: { backend, ui }) and a default (`model`,
// `effort`, `maxBudgetUsd`). RALPH_MODEL, RALPH_EFFORT and RALPH_MAX_BUDGET_USD override them for one run.
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The model, effort and budget for a concern's jobs: env override, then the concern's own, then the default. */
export function jobSettings(cfg = {}, concern, env = process.env) {
  const pick = (envKey, perConcern, fallback) =>
    env[envKey] || (concern && cfg[perConcern]?.[concern]) || cfg[fallback] || undefined;
  const model = pick('RALPH_MODEL', 'models', 'model');
  const effort = pick('RALPH_EFFORT', 'efforts', 'effort');
  const budget = pick('RALPH_MAX_BUDGET_USD', 'maxBudgetsUsd', 'maxBudgetUsd');
  if (effort && !EFFORTS.includes(effort)) throw new Error(`effort "${effort}" isn't one of ${EFFORTS.join(', ')}`);
  const maxBudgetUsd = budget === undefined ? undefined : Number(budget);
  if (maxBudgetUsd !== undefined && !(maxBudgetUsd > 0)) throw new Error(`maxBudgetUsd "${budget}" must be a positive number`);
  return { model, effort, maxBudgetUsd };
}

/** The `claude` arguments that pin a job's settings. */
export function settingsArgs({ model, effort, maxBudgetUsd }) {
  return [
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    ...(maxBudgetUsd ? ['--max-budget-usd', String(maxBudgetUsd)] : []),
  ];
}

/** For the startup line: "sonnet, effort medium, up to $2 a job", or what's inherited. */
export function describeSettings({ model, effort, maxBudgetUsd }) {
  return [
    model ?? 'model inherited from ~/.claude/settings.json',
    effort ? `effort ${effort}` : 'effort inherited',
    ...(maxBudgetUsd ? [`up to $${maxBudgetUsd} a job`] : []),
  ].join(', ');
}

/**
 * Whether a run ended on the account's usage limit, from its result message (`is_error`, the text naming a limit).
 * Returns `{ resetAt }` (a Date when the text carries one: "…|<epoch seconds>"), or null for any other outcome.
 */
export function usageLimit(result) {
  if (!result?.is_error) return null;
  const text = String(result.result ?? result.error ?? '');
  if (!/usage limit|rate limit|hit your limit|limit reached|limit will reset|resets? at/i.test(text)) return null;
  const epoch = text.match(/\|(\d{10})\b/);
  return { resetAt: epoch ? new Date(Number(epoch[1]) * 1000) : undefined, text: text.trim().slice(0, 200) };
}

/** How long to wait on a usage limit: until its reset (plus a minute), else 15 minutes. */
export function usageLimitWaitMs(limit, now = Date.now()) {
  if (limit?.resetAt) return Math.max(60_000, limit.resetAt.getTime() - now + 60_000);
  return 15 * 60_000;
}

/** One job's line in .build-kit/metrics/runs.jsonl. */
export function metricsLine({ at = new Date(), planned, settings, result, outcome, commit }) {
  const usage = result?.usage ?? {};
  return {
    at: at.toISOString(),
    slice: planned?.title ?? null,
    sliceId: planned?.id ?? null,
    concern: planned?.concern ?? 'backend',
    context: planned?.ctx ?? null,
    model: result?.model ?? settings?.model ?? null,
    effort: settings?.effort ?? null,
    outcome,
    durationMs: result?.duration_ms ?? null,
    costUsd: result?.total_cost_usd ?? null,
    turns: result?.num_turns ?? null,
    tokens: {
      input: usage.input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
    },
    commit: commit ?? null,
  };
}

export function metricsPath(kitDir) {
  return join(kitDir, 'metrics', 'runs.jsonl');
}

export function appendMetrics(kitDir, line) {
  const dir = join(kitDir, 'metrics');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(metricsPath(kitDir), `${JSON.stringify(line)}\n`, 'utf-8');
}
