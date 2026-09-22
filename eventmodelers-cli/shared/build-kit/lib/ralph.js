// Common runtime for the ralph loop + realtime agent.
// Not meant to be run directly — use ralph-claude.js or ralph-local-ai.js.
//
// startRalph({ kitDir, projectDir, onTask, onPlannedSlice })
//   onTask(prompt) — called when tasks.json has entries
//   onPlannedSlice(prompt) — called when .slices/ has a "Planned" entry (omit to skip)

import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname, relative } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { createRealtimeAdapter } from './adapters/realtime-adapter.js';

// ── HTTP helpers ──────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${body}`);
    this.status = status;
  }
}

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new HttpError(res.status, await res.text());
  return res.json();
}

async function retryOn401(label, fn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        if (attempt < maxRetries) {
          console.warn(`[agent] ${label} — 401, retrying (${attempt}/${maxRetries})...`);
          continue;
        }
        console.error(`[agent] ${label} — 401 after ${maxRetries} retries, shutting down`);
        process.exit(1);
      }
      throw err;
    }
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

// Config is resolved by walking from the kit dir up through every ancestor
// directory's .eventmodelers/config.json, merging fields as we go — a value
// set by a closer (more specific) directory always wins over a farther one.
// The walk stops as soon as the merged config has full connection credentials
// (see hasCredentials); anthropicBaseUrl/model are picked up opportunistically
// along the way but never force the walk to continue further up.
function* configCandidates(kitDir) {
  yield join(kitDir, '.eventmodelers', 'config.json');
  let dir = dirname(kitDir);
  while (true) {
    yield join(dir, '.eventmodelers', 'config.json');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort: the walk above only passes through $HOME if the project happens
  // to live under it. A project outside $HOME (e.g. /tmp/foo) never sees it, so
  // check it explicitly — this is where `eventmodelers init-config --global` writes
  // account-wide defaults (organizationId/token) shared across every project.
  yield join(homedir(), '.eventmodelers', 'config.json');
}

function loadLocalConfig(kitDir) {
  const merged = {};
  const sources = [];

  for (const candidate of configCandidates(kitDir)) {
    if (sources.includes(candidate) || !existsSync(candidate)) continue;
    let cfg;
    try {
      cfg = JSON.parse(readFileSync(candidate, 'utf-8'));
    } catch {
      console.warn(`[ralph] Skipping invalid config at ${candidate}`);
      continue;
    }
    for (const [key, value] of Object.entries(cfg)) {
      if (merged[key] === undefined) merged[key] = value;
    }
    sources.push(candidate);
    if (hasCredentials(merged)) break;
  }

  if (process.env.BASE_URL) merged.baseUrl = process.env.BASE_URL;
  else if (!merged.baseUrl) merged.baseUrl = 'https://api.eventmodelers.ai';

  if (sources.length > 1) {
    console.log(`[ralph] Merged config from: ${sources.join(', ')}`);
  } else if (sources.length === 1 && sources[0] !== join(kitDir, '.eventmodelers', 'config.json')) {
    console.log(`[ralph] Using credentials from ${sources[0]}`);
  } else if (sources.length === 0) {
    console.warn(`[ralph] Note: no .eventmodelers/config.json found — platform sync disabled.`);
    console.warn(`        To enable board sync, follow: https://app.eventmodelers.ai/documentation#build`);
    console.warn(`        Code generation from local slice definitions will still run.`);
  }

  return merged;
}

function hasCredentials(cfg) {
  return !!(cfg.token && cfg.organizationId && cfg.boardId && cfg.baseUrl);
}

// Distinguishes this agent process from any other agent pinging the same
// token/board — e.g. a build-kit and a bridge-kit install in the same project
// share one root config.json, and without a per-agent id both would upsert the
// same alive row and race each other. The platform already keys the alive-ping
// on the (agent_type, agent_id) pair, so one shared file works: agentIds is
// namespaced by agentType (BUILD/BRIDGE/MODELING/...) inside the project ROOT
// .eventmodelers/config.json — the same file credentials already live in —
// instead of each kit dir keeping its own separate config.json. Falls back to
// a pre-existing kit-local agentId (older installs, before this consolidation)
// so an upgrade doesn't mint a new identity the platform hasn't seen before.
function ensureAgentId(kitDir, agentType) {
  const rootConfigPath = join(dirname(kitDir), '.eventmodelers', 'config.json');
  let rootCfg = {};
  if (existsSync(rootConfigPath)) {
    try {
      rootCfg = JSON.parse(readFileSync(rootConfigPath, 'utf-8'));
    } catch {
      console.warn(`[ralph] Skipping invalid config at ${rootConfigPath}`);
    }
  }
  rootCfg.agentIds = rootCfg.agentIds || {};
  if (rootCfg.agentIds[agentType]) return rootCfg.agentIds[agentType];

  const legacyKitConfigPath = join(kitDir, '.eventmodelers', 'config.json');
  let legacyAgentId;
  if (existsSync(legacyKitConfigPath)) {
    try {
      legacyAgentId = JSON.parse(readFileSync(legacyKitConfigPath, 'utf-8')).agentId;
    } catch {
      console.warn(`[ralph] Skipping invalid config at ${legacyKitConfigPath}`);
    }
  }

  const agentId = legacyAgentId || randomUUID();
  rootCfg.agentIds[agentType] = agentId;
  mkdirSync(dirname(rootConfigPath), { recursive: true });
  writeFileSync(rootConfigPath, JSON.stringify(rootCfg, null, 2));
  return agentId;
}

// `x-agent-id` on every platform call this loop makes, when it knows its own agent id (see
// ensureAgentId above / RALPH_AGENT_ID). The heartbeat says this agent is alive; the header says
// which calls are its, so its board writes are attributed to it and a prompt the user addressed
// to one preferred agent is only ever claimed by that agent.
function agentHeaders(cfg) {
  const agentId = cfg?.agentId || process.env.RALPH_AGENT_ID || process.env.EVENTMODELERS_AGENT_ID || '';
  return agentId ? { 'x-agent-id': agentId } : {};
}

async function fetchPlatformConfig(local) {
  const remote = await fetchJSON(`${local.baseUrl}/api/config`, {
    headers: { 'x-token': local.token, ...agentHeaders(local) },
  });
  return { ...local, ...remote };
}

// ── Realtime agent ────────────────────────────────────────────────────────────

async function getRealtimeToken(cfg) {
  const { token } = await fetchJSON(
    `${cfg.baseUrl}/api/org/${cfg.organizationId}/prompts/realtime-token`,
    { headers: { 'x-token': cfg.token, ...agentHeaders(cfg) } },
  );
  return token;
}

function slugify(str) {
  return str.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

async function fetchAndPersistSlices(cfg, kitDir) {
  const url = `${cfg.baseUrl}/api/org/${cfg.organizationId}/boards/${cfg.boardId}/slicedata/slices`;
  const { slices } = await fetchJSON(url, {
    headers: { 'x-token': cfg.token, 'x-board-id': cfg.boardId, ...agentHeaders(cfg) },
  });
  const slicesDir = join(kitDir, '.slices');
  mkdirSync(slicesDir, { recursive: true });

  // Group by context slug
  const contexts = {};
  for (const slice of slices) {
    const contextSlug = slice.contextName ? slugify(slice.contextName) : 'default';
    if (!contexts[contextSlug]) contexts[contextSlug] = { name: slice.contextName || 'default', slices: [] };
    contexts[contextSlug].slices.push(slice);
  }

  // current_context.json is STICKY. We work within ONE context at a time and must
  // not auto-jump to another context just because it happens to have planned work.
  // Keep the existing context if it still exists; only seed it when absent or stale.
  const ctxPath = join(slicesDir, 'current_context.json');
  let activeCtx = null;
  if (existsSync(ctxPath)) {
    try { activeCtx = JSON.parse(readFileSync(ctxPath, 'utf-8')).name; } catch {}
  }
  if (!activeCtx || !contexts[activeCtx]) {
    // First run (or the current context disappeared): seed with a context that
    // has planned work, else the first one. This is the ONLY place we choose it.
    const plannedCtx = Object.keys(contexts).find(c => contexts[c].slices.some(s => (s.status || '').toLowerCase() === 'planned'));
    activeCtx = plannedCtx || Object.keys(contexts)[0] || 'default';
    writeFileSync(ctxPath, JSON.stringify({ name: activeCtx }, null, 2), 'utf-8');
  }

  // Write per-context index.json and per-slice slice.json.
  //
  // This endpoint (`/slicedata/slices`) is the CHEAP summary one — `{ id, title, status }`
  // only, no commands/events/specifications/codeGen prompts. Its whole job here is to keep
  // `status` fresh so hasPendingTasks/getFirstPlannedSliceTitle see live transitions; it must
  // NEVER clobber the richer slice.json a full fetch (`/load-slice`, `eventmodelers fetch`,
  // `eventmodelers listen`) already wrote for the same slice. So every write below merges
  // onto whatever's already on disk — spreading the existing object first, the fresh summary
  // fields second — instead of replacing it wholesale.
  for (const [contextSlug, { slices: ctxSlices }] of Object.entries(contexts)) {
    const contextDir = join(slicesDir, contextSlug);
    mkdirSync(contextDir, { recursive: true });

    const indexPath = join(contextDir, 'index.json');
    const existingIndex = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf-8')) : { slices: [] };
    const existingById = new Map((existingIndex.slices ?? []).map((e) => [e.id, e]));

    const indexSlices = ctxSlices.map((s, i) => {
      const folder = (s.title ?? s.id).replaceAll(' ', '').toLowerCase();
      const existing = existingById.get(s.id);
      return {
        ...existing,
        id: s.id,
        slice: s.title,
        index: i,
        contextName: s.contextName || contextSlug,
        contextSlug,
        folder,
        status: s.status,
        definition: { ...existing?.definition, id: s.id, title: s.title, status: s.status },
      };
    });
    writeFileSync(indexPath, JSON.stringify({ slices: indexSlices }, null, 2), 'utf-8');

    for (const slice of ctxSlices) {
      const folder = (slice.title ?? slice.id).replaceAll(' ', '').toLowerCase();
      const sliceDir = join(contextDir, folder);
      mkdirSync(sliceDir, { recursive: true });
      const sliceJsonPath = join(sliceDir, 'slice.json');
      const existingSlice = existsSync(sliceJsonPath) ? JSON.parse(readFileSync(sliceJsonPath, 'utf-8')) : {};
      writeFileSync(sliceJsonPath, JSON.stringify({ ...existingSlice, ...slice }, null, 2), 'utf-8');
    }
  }

  console.log(`[agent] Persisted ${slices.length} slice(s)`);
}

async function writeTask(payload, kitDir) {
  const tasksPath = join(kitDir, 'tasks.json');
  const existing = existsSync(tasksPath) ? JSON.parse(readFileSync(tasksPath, 'utf-8')) : [];
  const filtered = existing.filter(t => t.payload?.sliceId !== payload.sliceId);
  const task = { id: randomUUID(), createdAt: new Date().toISOString(), payload };
  filtered.push(task);
  writeFileSync(tasksPath, JSON.stringify(filtered, null, 2), 'utf-8');
  console.log(`[agent] Task written — slice="${payload.sliceTitle}" status="${payload.sliceStatus}"`);
}

async function handleSliceChanged(payload, cfg, kitDir, queueAllStatuses) {
  console.log(`[agent] slice:changed — slice="${payload.sliceTitle}" status="${payload.sliceStatus}"`);
  await retryOn401('fetchAndPersistSlices', () => fetchAndPersistSlices(cfg, kitDir)).catch((err) =>
    console.error('[agent] Slice persist error:', err),
  );
  // Planned slices are handled by onPlannedSlice directly — no task needed.
  // queueAllStatuses opts out of that split entirely (e.g. bridge has no
  // onPlannedSlice consumer, so a lingering Planned slice would otherwise
  // never naturally clear its own trigger — see lib/ralph.js callers).
  if (queueAllStatuses || (payload.sliceStatus || '').toLowerCase() !== 'planned') {
    await writeTask(payload, kitDir).catch((err) => console.error('[agent] writeTask error:', err));
  }
}

async function startRealtimeAgent(cfg, kitDir, { agentType = 'BUILD', queueAllStatuses = false } = {}) {
  let realtimeToken = await retryOn401('getRealtimeToken', () => getRealtimeToken(cfg));

  await retryOn401('fetchAndPersistSlices', () => fetchAndPersistSlices(cfg, kitDir)).catch((err) =>
    console.error('[agent] Initial slice fetch error:', err),
  );

  const channelName = `board:${cfg.boardId}-slicechanged`;
  const realtime = await createRealtimeAdapter(cfg, realtimeToken);

  // Shared by the scheduled timer, a CHANNEL_ERROR/TIMED_OUT subscribe status, and a
  // 401 from the alive-ping — whichever notices the token is bad first wins; the rest
  // just await the same in-flight refresh instead of firing duplicate mint requests.
  const ts = () => new Date().toISOString();
  let refreshing = null;
  const refreshToken = (reason) => {
    if (!refreshing) {
      const startedAt = Date.now();
      console.log(`[agent] ${ts()} Refreshing realtime token (reason: ${reason})...`);
      refreshing = (async () => {
        try {
          realtimeToken = await retryOn401('getRealtimeToken (refresh)', () => getRealtimeToken(cfg));
          await realtime.setAuth(realtimeToken);
          console.log(`[agent] ${ts()} Token refreshed (reason: ${reason}, took ${Date.now() - startedAt}ms)`);
        } catch (err) {
          console.error(`[agent] ${ts()} Token refresh FAILED (reason: ${reason}):`, err);
          throw err;
        } finally {
          refreshing = null;
        }
      })();
    }
    return refreshing;
  };

  // A subscribe that errors on a stale token needs a fresh token AND a new join
  // attempt — setAuth alone doesn't re-join a channel that already errored out.
  // Capped so a non-expiry auth failure (e.g. genuinely revoked access) can't turn
  // into a tight resubscribe loop hammering the platform forever.
  let channelErrorStreak = 0;
  const subscribeChannel = () => {
    realtime.subscribe(
      channelName,
      {
        // A kill names exactly one agent: {type: 'kill', id: '<agentId>', instruction: 'exit'}.
        // Anything that doesn't name this agent is ignored — a broadcast reaches every agent on
        // the board, and the older signal (the bare string "Exit") took all of them down at once.
        // That string form is gone for good, not just unhandled: Supabase's broadcast API rejects
        // a non-object payload with 422, so it never actually arrived here.
        message: (payload) => {
          if (payload?.type !== 'kill' || payload?.id !== cfg.agentId) return;
          console.log(`[agent] ${ts()} Received kill (instruction: ${payload.instruction ?? 'exit'}) — shutting down`);
          process.exit(0);
        },
        'slice:changed': (payload) => handleSliceChanged(payload, cfg, kitDir, queueAllStatuses),
      },
      async (status) => {
        if (status !== 'CHANNEL_ERROR' && status !== 'TIMED_OUT') {
          if (channelErrorStreak > 0) {
            console.log(`[agent] ${ts()} Channel "${channelName}": ${status} — recovered after ${channelErrorStreak} failed attempt(s)`);
          } else {
            console.log(`[agent] ${ts()} Channel "${channelName}": ${status}`);
          }
          channelErrorStreak = 0;
          return;
        }
        channelErrorStreak += 1;
        console.warn(`[agent] ${ts()} Channel "${channelName}": ${status} (attempt ${channelErrorStreak}/5)`);
        if (channelErrorStreak > 5) {
          console.error(`[agent] ${ts()} Channel "${channelName}" failed ${channelErrorStreak} times in a row — giving up until the next scheduled token refresh (every 10min)`);
          return;
        }
        try {
          await refreshToken(`channel ${status}`);
          await new Promise((r) => setTimeout(r, 2_000));
          console.log(`[agent] ${ts()} Resubscribing to channel "${channelName}" (attempt ${channelErrorStreak}/5)...`);
          subscribeChannel();
        } catch (err) {
          console.error(`[agent] ${ts()} Token refresh after channel error failed, will not resubscribe this round:`, err);
        }
      },
    );
  };
  subscribeChannel();

  setInterval(() => {
    refreshToken('scheduled 10min refresh').catch((err) => console.error(`[agent] ${ts()} Scheduled token refresh failed:`, err));
  }, 10 * 60 * 1000);

  let lastPingFailed = false;
  const ping = async () => {
    try {
      const res = await fetch(`${cfg.baseUrl}/api/agent-alive`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${realtimeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: cfg.token, board_id: cfg.boardId, agent_type: agentType, agent_id: cfg.agentId, ...(cfg.agentName ? { agent_name: cfg.agentName } : {}) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.error(`[agent] ${ts()} Ping failed: ${res.status} ${await res.text().catch(() => '')}`);
        lastPingFailed = true;
        if (res.status === 401) {
          await refreshToken('ping-401').catch((err) => console.error(`[agent] ${ts()} Token refresh after 401 ping failed:`, err));
        }
        return;
      }
      if (lastPingFailed) console.log(`[agent] ${ts()} Ping recovered`);
      lastPingFailed = false;
    } catch (err) {
      console.error(`[agent] ${ts()} Ping error:`, err);
      lastPingFailed = true;
    }
  };
  await ping();
  setInterval(ping, 15_000);
}

// ── Ralph loop ────────────────────────────────────────────────────────────────

function hasPendingTasks(kitDir) {
  const tasksPath = join(kitDir, 'tasks.json');
  if (!existsSync(tasksPath)) return false;
  try {
    const tasks = JSON.parse(readFileSync(tasksPath, 'utf-8'));
    return Array.isArray(tasks) && tasks.length > 0;
  } catch {
    return false;
  }
}

function readCurrentContext(kitDir) {
  const ctxPath = join(kitDir, '.slices', 'current_context.json');
  if (!existsSync(ctxPath)) return null;
  try { return JSON.parse(readFileSync(ctxPath, 'utf-8')).name || null; } catch { return null; }
}

// Returns the first Planned slice IN THE CURRENT CONTEXT ONLY. If the current
// context has no planned work, returns null so the loop waits — it must NEVER
// cross into another context to find something to build.
function getFirstPlannedSlice(kitDir) {
  const currentCtx = readCurrentContext(kitDir);
  if (!currentCtx) return null;
  const indexPath = join(kitDir, '.slices', currentCtx, 'index.json');
  if (!existsSync(indexPath)) return null;
  try {
    const { slices } = JSON.parse(readFileSync(indexPath, 'utf-8'));
    const planned = slices && slices.find((s) => (s.status || '').toLowerCase() === 'planned');
    if (planned) return { id: planned.id ?? null, title: planned.slice || planned.id || null, ctx: currentCtx };
  } catch {}
  return null;
}

// If the exact same Planned slice (by id) comes back up this many times in a
// row without its status ever leaving "Planned", onPlannedSlice is stuck on
// it — declining to build it, or building it but its own status change keeps
// getting reverted (e.g. a failed check). Rather than retry it forever (or
// crash the whole loop, which would take down every other slice with it),
// mark it Blocked with a note explaining why and move on to other work.
// Critical for unsupervised/CI runs, which have no human watching to notice
// a stall. Configurable for teams that want more slack.
const MAX_PLANNED_ATTEMPTS = Number(process.env.RALPH_MAX_PLANNED_ATTEMPTS) || 2;

// Writes a slice's status into its context's index.json (entry + definition) and its
// slice.json, merging `extra` fields alongside. Returns false if the slice isn't found.
function setLocalSliceStatus(kitDir, ctx, id, status, extra = {}) {
  const indexPath = join(kitDir, '.slices', ctx, 'index.json');
  let folder;
  try {
    const indexData = JSON.parse(readFileSync(indexPath, 'utf-8'));
    const entry = (indexData.slices ?? []).find((s) => s.id === id);
    if (!entry) return false;
    Object.assign(entry, { status, ...extra });
    if (entry.definition) entry.definition.status = status;
    folder = entry.folder;
    writeFileSync(indexPath, JSON.stringify(indexData, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[ralph] Failed to write ${status} status to ${indexPath}:`, err.message);
    return false;
  }

  if (folder) {
    const sliceJsonPath = join(kitDir, '.slices', ctx, folder, 'slice.json');
    try {
      if (existsSync(sliceJsonPath)) {
        const sliceData = JSON.parse(readFileSync(sliceJsonPath, 'utf-8'));
        Object.assign(sliceData, { status, ...extra });
        writeFileSync(sliceJsonPath, JSON.stringify(sliceData, null, 2), 'utf-8');
      }
    } catch (err) {
      console.error(`[ralph] Failed to write ${status} status to ${sliceJsonPath}:`, err.message);
    }
  }
  return true;
}

function appendProgressNote(kitDir, heading, lines) {
  try {
    const progressPath = join(dirname(kitDir), 'progress.txt');
    const existing = existsSync(progressPath) ? readFileSync(progressPath, 'utf-8') : '';
    const note = `\n## ${new Date().toISOString()} — ${heading}\n\n${lines.join('\n')}\n---\n`;
    writeFileSync(progressPath, existing + note, 'utf-8');
  } catch (err) {
    console.error('[ralph] Failed to append progress.txt note:', err.message);
  }
}

// Best-effort: also reflect a status on the board itself so a synced fetch
// doesn't just pull the old status back down over our local fix. Never fatal —
// this loop must keep going locally even if the board call fails.
async function syncSliceStatusToBoard(cfg, id, status) {
  try {
    await fetchJSON(`${cfg.baseUrl}/api/org/${cfg.organizationId}/boards/${cfg.boardId}/nodes/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-token': cfg.token, 'x-board-id': cfg.boardId, 'x-user-id': 'ralph-loop', ...agentHeaders(cfg) },
      body: JSON.stringify([{
        id: randomUUID(),
        eventType: 'node:changed',
        nodeId: id,
        boardId: cfg.boardId,
        timestamp: Date.now(),
        changedAttributes: ['sliceStatus'],
        meta: { sliceStatus: status },
      }]),
    });
  } catch (err) {
    console.error(`[ralph] Failed to sync ${status} status to the board:`, err.message);
  }
}

// Marks a stuck slice Blocked (locally, and on the board if credentialed) and
// records why, so the loop can move on instead of looping or exiting.
async function blockStuckSlice(kitDir, cfg, credentialed, planned, attempts) {
  const reason = `Ralph loop picked up this slice ${attempts} times in a row without its status ever leaving ` +
    `"Planned" — the build agent kept declining to build it, or kept building it but its own status change kept ` +
    `getting reverted (e.g. a failed check). Auto-blocked to stop the loop from retrying it forever.`;

  setLocalSliceStatus(kitDir, planned.ctx, planned.id, 'Blocked', { blockedReason: reason, blockedAt: new Date().toISOString() });
  appendProgressNote(kitDir, 'Slice auto-blocked', [`Slice: ${planned.title} (id=${planned.id}, context=${planned.ctx})`, '', `- ${reason}`]);
  if (credentialed) await syncSliceStatusToBoard(cfg, planned.id, 'Blocked');

  console.error(`[ralph] ${reason} Marked "${planned.title}" (id=${planned.id}) as Blocked — moving on.`);
}

// ── Interrupted-run recovery ──────────────────────────────────────────────────
//
// The build agent claims a slice by setting it InProgress, and only it moves the slice on
// to Done or Blocked. If the agent dies mid-slice (Claude usage limit, crash, the terminal
// closed), the slice stays InProgress, and a retried agent only picks up Planned slices, so
// the loop idles forever. The loop runs one agent at a time, so once an agent run has ended,
// any slice that run claimed and left InProgress is stale: its partial work is stashed and
// the slice goes back to Planned, to be rebuilt from scratch.
//
// Only in local-only mode: there, index.json is written by this loop's agent alone, so a
// slice that became InProgress during a run is provably its claim. With board sync, another
// agent's claim reaches index.json through the realtime channel mid-run, and resetting it
// would steal that agent's slice — so a credentialed loop only reports the stale slice.
//
// A marker file records each run while it is in flight, so a loop that was killed outright
// (terminal closed, Ctrl+C) recovers its run the next time it starts.

const RUN_MARKER = '.ralph-run.json';

function isInProgress(status) {
  return (status || '').toLowerCase().replace(/[\s_-]/g, '') === 'inprogress';
}

function inProgressSlices(kitDir, ctx) {
  const indexPath = join(kitDir, '.slices', ctx, 'index.json');
  if (!existsSync(indexPath)) return [];
  try {
    const { slices } = JSON.parse(readFileSync(indexPath, 'utf-8'));
    return (slices ?? []).filter((s) => isInProgress(s.status)).map((s) => ({ id: s.id, title: s.slice || s.id }));
  } catch {
    return [];
  }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// HEAD plus every dirty path (tracked or untracked, relative to the repo root) with the
// hash of its current content, so a later snapshot can tell which paths a run touched.
// Null outside a git work tree.
function snapshotWorktree(projectDir) {
  let root;
  try {
    root = git(projectDir, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return null;
  }
  let head = null;
  try { head = git(root, ['rev-parse', 'HEAD']).trim(); } catch {}
  try {
    const paths = git(root, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all'])
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(3));
    const dirty = {};
    const present = paths.filter((p) => existsSync(join(root, p)));
    for (const p of paths) dirty[p] = null;
    if (present.length) {
      const hashes = git(root, ['hash-object', '--', ...present]).trim().split('\n');
      present.forEach((p, i) => { dirty[p] = hashes[i]; });
    }
    return { root, head, dirty };
  } catch (err) {
    console.error(`[ralph] Couldn't snapshot the working tree (${err.message.trim()}) — an interrupted slice will be reset without stashing.`);
    return null;
  }
}

function beginRun(kitDir, projectDir, ctx) {
  const run = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ctx,
    inProgress: inProgressSlices(kitDir, ctx).map((s) => s.id),
    worktree: snapshotWorktree(projectDir),
  };
  try {
    writeFileSync(join(kitDir, '.slices', RUN_MARKER), JSON.stringify(run, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[ralph] Failed to write run marker:`, err.message);
  }
  return run;
}

function endRun(kitDir) {
  try { unlinkSync(join(kitDir, '.slices', RUN_MARKER)); } catch {}
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Recovers the slices `run` claimed and left InProgress. Returns true if it recovered any.
function recoverInterruptedRun(kitDir, projectDir, run) {
  const stale = inProgressSlices(kitDir, run.ctx).filter((s) => !run.inProgress.includes(s.id));
  if (!stale.length) return false;
  const names = stale.map((s) => `"${s.title}"`).join(', ');
  const before = run.worktree;
  const now = before && snapshotWorktree(projectDir);
  if (before && !now) {
    console.error(`[ralph] ${names} left InProgress by an interrupted agent — leaving it InProgress, since its partial work can't be stashed.`);
    return false;
  }

  // The agent commits a slice only once its checks pass, and marks it Done right after.
  // A commit made during the run means the slice is partly (or fully) in history, which a
  // from-scratch rebuild would collide with — leave it for a human instead.
  if (now && now.head !== before.head) {
    const reason = `The build agent was interrupted after committing (HEAD moved from ${before.head?.slice(0, 7) ?? 'none'} ` +
      `to ${now.head?.slice(0, 7) ?? 'none'}) but before marking the slice Done. Check those commits and the working tree, ` +
      `then set the slice to Done, or revert them and set it to Planned.`;
    for (const s of stale) setLocalSliceStatus(kitDir, run.ctx, s.id, 'Blocked', { blockedReason: reason, blockedAt: new Date().toISOString() });
    appendProgressNote(kitDir, 'Interrupted slice blocked', [`Slice(s): ${names} (context=${run.ctx})`, '', `- ${reason}`]);
    console.error(`[ralph] ${names} left InProgress by an interrupted agent. ${reason} Marked Blocked.`);
    return true;
  }

  const lines = [`Slice(s): ${names} (context=${run.ctx})`, '', `- The build agent was interrupted before finishing. Reset to Planned to be rebuilt from scratch.`];
  if (now) {
    // Stash only what the run itself touched: paths that became dirty during it. Paths that
    // were already dirty when it started are the developer's work in progress and stay put.
    // The slice-status files are the loop's own bookkeeping, never partial work.
    const slicesDir = relative(now.root, join(kitDir, '.slices'));
    const own = (p) => p !== slicesDir && !p.startsWith(`${slicesDir}/`);
    const touched = Object.keys(now.dirty).filter((p) => own(p) && !(p in before.dirty));
    const overlapping = Object.keys(before.dirty).filter((p) => own(p) && before.dirty[p] !== (now.dirty[p] ?? null));
    if (touched.length) {
      const message = `ralph: interrupted slice ${names} (${run.startedAt})`;
      try {
        git(now.root, ['stash', 'push', '--include-untracked', '-m', message, '--', ...touched]);
        lines.push(`- Stashed its partial work (${touched.length} path(s)) as "${message}". Review with \`git stash list\`.`);
        console.log(`[ralph] Stashed ${touched.length} path(s) left by the interrupted agent: ${touched.join(', ')}`);
      } catch (err) {
        // Without the stash the rebuild would start on top of half-written files — don't reset.
        console.error(`[ralph] ${names} left InProgress by an interrupted agent, but stashing its partial work failed: ${err.message.trim()}. ` +
          `Leaving it InProgress — stash or remove those files, then set it back to Planned.`);
        return false;
      }
    }
    if (overlapping.length) {
      lines.push(`- Left in place, changed during the run but already modified before it: ${overlapping.join(', ')}`);
      console.warn(`[ralph] Left in place (already modified before the agent started, changed since): ${overlapping.join(', ')}`);
    }
  }
  for (const s of stale) setLocalSliceStatus(kitDir, run.ctx, s.id, 'Planned');
  appendProgressNote(kitDir, 'Interrupted slice reset to Planned', lines);
  console.log(`[ralph] ${names} left InProgress by an interrupted agent — reset to Planned.`);
  return true;
}

// On startup: a marker whose loop is gone means the previous loop died mid-run.
function recoverPreviousRun(kitDir, projectDir) {
  const markerPath = join(kitDir, '.slices', RUN_MARKER);
  if (!existsSync(markerPath)) return;
  let run;
  try {
    run = JSON.parse(readFileSync(markerPath, 'utf-8'));
  } catch {
    endRun(kitDir);
    return;
  }
  if (run.pid !== process.pid && isAlive(run.pid)) {
    console.warn(`[ralph] Another loop (pid ${run.pid}) is building in this project — leaving its run alone.`);
    return;
  }
  console.log(`[ralph] The previous loop stopped mid-run (started ${run.startedAt}) — checking for an interrupted slice...`);
  recoverInterruptedRun(kitDir, projectDir, run);
  endRun(kitDir);
}

// Credentialed loops can't tell their own stale claim from another agent's live one — say so.
const reportedStale = new Set();
function reportStaleClaims(kitDir, ctx) {
  for (const s of inProgressSlices(kitDir, ctx)) {
    if (reportedStale.has(s.id)) continue;
    reportedStale.add(s.id);
    console.warn(`[ralph] "${s.title}" is InProgress. If no agent is building it (an interrupted run), stash its partial ` +
      `work and set it back to Planned on the board — with board sync on, the loop can't tell an interrupted claim ` +
      `from another agent's.`);
  }
}

async function runWithRetry(label, fn) {
  while (true) {
    try {
      console.log(`[ralph] ${label}`);
      await fn();
      return;
    } catch (err) {
      console.error(`[ralph] Error — retrying in 60s:`, err.message);
      await new Promise((r) => setTimeout(r, 60_000));
    }
  }
}

async function ralphLoop(kitDir, projectDir, cfg, onTask, onPlannedSlice, localOnly = false) {
  const promptFile = join(kitDir, 'lib', 'prompt.md');
  const backendPromptFile = join(kitDir, 'lib', 'backend-prompt.md');
  // --local must mean zero board contact even when .eventmodelers/config.json
  // happens to hold valid credentials — never let a locally-present token flip
  // this back on.
  const credentialed = !localOnly && hasCredentials(cfg);
  let lastIdleCtx;
  // Tracks consecutive sightings of the same Planned slice id — see
  // MAX_PLANNED_ATTEMPTS above.
  let stuckSlice = { id: null, count: 0 };

  if (!credentialed) recoverPreviousRun(kitDir, projectDir);

  while (true) {
    let didWork = false;

    if (credentialed && hasPendingTasks(kitDir)) {
      const prompt = readFileSync(promptFile, 'utf-8');
      await runWithRetry('onTask: loading slice from board...', () => onTask(prompt));
      await fetchAndPersistSlices(cfg, kitDir).catch(() => {});
      didWork = true;
    }

    const planned = onPlannedSlice && getFirstPlannedSlice(kitDir);
    if (planned) {
      stuckSlice = planned.id !== null && planned.id === stuckSlice.id
        ? { id: stuckSlice.id, count: stuckSlice.count + 1 }
        : { id: planned.id, count: 1 };

      if (stuckSlice.count > MAX_PLANNED_ATTEMPTS) {
        await blockStuckSlice(kitDir, cfg, credentialed, planned, stuckSlice.count);
        stuckSlice = { id: null, count: 0 };
        didWork = true;
        continue;
      }

      const prompt = readFileSync(backendPromptFile, 'utf-8');
      await runWithRetry(`onPlannedSlice: building slice "${planned.title}"...`, async () => {
        if (credentialed) return onPlannedSlice(prompt);
        // Recovered before a retry, too: a retried agent only builds Planned slices.
        const run = beginRun(kitDir, projectDir, planned.ctx);
        try {
          await onPlannedSlice(prompt);
        } finally {
          try {
            recoverInterruptedRun(kitDir, projectDir, run);
          } catch (err) {
            console.error(`[ralph] Interrupted-slice recovery failed:`, err.message);
          }
          endRun(kitDir);
        }
      });
      console.log(`[ralph] Slice build complete — waiting for next slice`);
      if (credentialed) await fetchAndPersistSlices(cfg, kitDir).catch(() => {});
      didWork = true;
    }

    if (!didWork) {
      // No planned work in the current context — wait, do NOT switch contexts.
      const ctx = readCurrentContext(kitDir);
      if (credentialed && ctx) reportStaleClaims(kitDir, ctx);
      if (ctx !== lastIdleCtx) {
        console.log(`[ralph] No planned slices in current context "${ctx}" — waiting. Switch context on the board to continue.`);
        lastIdleCtx = ctx;
      }
      await new Promise((r) => setTimeout(r, 10_000));
    } else {
      lastIdleCtx = undefined;
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export { loadLocalConfig, fetchPlatformConfig, retryOn401, startRealtimeAgent };

export async function startRalph({ kitDir, projectDir, onTask, onPlannedSlice, agentType = 'BUILD', queueAllStatuses = false, localOnly = false }) {
  const local = loadLocalConfig(kitDir);
  // RALPH_AGENT_ID/RALPH_AGENT_NAME are `eventmodelers run --id/--name`, passed down as env
  // (see cli.js's run dispatcher): a per-run identity override so a second agent of the same
  // type can run side by side without the two overwriting each other's heartbeat row, and so
  // the board can show a name instead of a bare uuid. An override skips ensureAgentId rather
  // than overwriting it — the project's stable id stays on disk for the next plain run.
  local.agentId = process.env.RALPH_AGENT_ID || ensureAgentId(kitDir, agentType);
  if (process.env.RALPH_AGENT_NAME) local.agentName = process.env.RALPH_AGENT_NAME;

  console.log(`Ralph — kit: ${kitDir}`);
  console.log(`         project: ${projectDir}`);
  console.log(`         agent: ${local.agentName ? `${local.agentName} (${local.agentId})` : local.agentId}`);

  // localOnly (set via `eventmodelers run --local`) forces this branch even when
  // credentials are present — it skips fetchPlatformConfig's network call to
  // ${baseUrl}/api/config and startRealtimeAgent entirely, so the loop never
  // reaches out to the platform at all.
  if (localOnly || !hasCredentials(local)) {
    console.log(`         mode: local-only (no platform sync)${localOnly ? ' — forced by --local' : ''}\n`);
    await ralphLoop(kitDir, projectDir, local, onTask, onPlannedSlice, localOnly);
    return;
  }

  const cfg = await retryOn401('fetchPlatformConfig', () => fetchPlatformConfig(local));
  console.log(`         org=${cfg.organizationId}, board=${cfg.boardId}, base=${cfg.baseUrl}\n`);

  await Promise.all([
    startRealtimeAgent(cfg, kitDir, { agentType, queueAllStatuses }),
    ralphLoop(kitDir, projectDir, cfg, onTask, onPlannedSlice),
  ]);
}
