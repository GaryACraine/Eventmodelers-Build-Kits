// A slice's build work, split by concern (PLAN 14.7b, ADR-027).
//
// A slice holds backend elements (commands, events, read models, processors) and, once its screen has a mockup,
// a UI. Each is its own job with its own status, in the slice's index.json entry:
//
//   { "status": "Blocked", "concerns": { "backend": { "status": "Done" },
//                                        "ui": { "status": "Blocked", "blockedReason": "…", "blockedAt": "…" } } }
//
// The entry's `status` is derived from them (Blocked > InProgress > Planned > Created > Done), so everything that
// reads `status` keeps working. The loop takes one concern at a time: a slice's backend, or its UI once that
// backend is Done. Nothing waits for a UI. An entry without `concerns` (another kit, or an older export) is one
// backend concern: the whole slice.
//
// emcli's export writes `concerns` (model/buildKit.ts); the loop claims a concern and its agent finishes it.

export const CONCERNS = ['backend', 'ui'];

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s_-]/g, '');

/** Whether an entry tracks its work per concern. */
export function hasConcerns(entry) {
  return !!entry?.concerns && typeof entry.concerns === 'object' && Object.keys(entry.concerns).length > 0;
}

/** The entry's concerns, or the whole slice as one backend concern when it has none. */
export function concernsOf(entry) {
  return hasConcerns(entry) ? entry.concerns : { backend: { status: entry?.status ?? 'Created' } };
}

/** The slice's status from its concerns: Blocked > InProgress > Planned > Created > Done. */
export function deriveStatus(concerns, fallback) {
  const statuses = Object.values(concerns ?? {}).map((c) => norm(c?.status));
  if (statuses.length === 0) return fallback;
  if (statuses.includes('blocked')) return 'Blocked';
  if (statuses.includes('inprogress')) return 'InProgress';
  if (statuses.includes('planned')) return 'Planned';
  if (statuses.includes('created')) return 'Created';
  return 'Done';
}

/**
 * The next job, in timeline order: a slice's Planned backend, or its Planned UI once its backend is Done (a UI
 * needs its own slice's routes and types). Returns { id, title, concern, tracked } or null; `tracked` is false for
 * an entry without concerns (another kit's export), whose agent picks and claims its slice itself, as before.
 */
export function nextWork(entries) {
  for (const entry of entries ?? []) {
    const concerns = concernsOf(entry);
    const job = (concern) => ({ id: entry.id ?? null, title: entry.slice || entry.id || null, concern, tracked: hasConcerns(entry) });
    if (concerns.backend && norm(concerns.backend.status) === 'planned') return job('backend');
    if (concerns.ui && norm(concerns.ui.status) === 'planned'
      && (!concerns.backend || norm(concerns.backend.status) === 'done')) return job('ui');
  }
  return null;
}

/** Every concern InProgress: [{ id, title, concern }]. */
export function inProgressConcerns(entries) {
  return (entries ?? []).flatMap((entry) => Object.entries(concernsOf(entry))
    .filter(([, state]) => norm(state?.status) === 'inprogress')
    .map(([concern]) => ({ id: entry.id, title: entry.slice || entry.id, concern })));
}

/**
 * Sets one concern's status (and fields like blockedReason / blockedAt) on an index entry, then the entry's
 * derived status and its definition's. Leaving Blocked drops the block's record. Without concerns, the whole
 * slice changes. Returns the entry's new status.
 */
export function setConcernStatus(entry, concern, status, extra = {}) {
  if (!hasConcerns(entry)) {
    Object.assign(entry, { status, ...extra });
  } else {
    const next = { ...(entry.concerns[concern] ?? {}), status, ...extra };
    if (norm(status) !== 'blocked') {
      delete next.blockedReason;
      delete next.blockedAt;
    }
    entry.concerns[concern] = next;
    entry.status = deriveStatus(entry.concerns, entry.status);
  }
  if (entry.definition) entry.definition.status = entry.status;
  return entry.status;
}

/**
 * After an agent's run: every Blocked concern gets a `blockedAt` if it has none (so planning the slice again can
 * be compared with it), and every entry's status is derived again from its concerns (an agent that set only its
 * concern leaves the slice's status to the loop). Returns the ids whose entry changed.
 */
export function settleEntries(entries, now = new Date().toISOString()) {
  const changed = [];
  for (const entry of entries ?? []) {
    const before = JSON.stringify(entry);
    if (hasConcerns(entry)) {
      for (const state of Object.values(entry.concerns)) {
        if (norm(state?.status) === 'blocked' && !state.blockedAt) state.blockedAt = now;
      }
      entry.status = deriveStatus(entry.concerns, entry.status);
      if (entry.definition) entry.definition.status = entry.status;
    } else if (norm(entry.status) === 'blocked' && !entry.blockedAt) {
      entry.blockedAt = now;
    }
    if (JSON.stringify(entry) !== before) changed.push(entry.id);
  }
  return changed;
}
