import type { Pool } from "pg"
import type { EventStore } from "@dcb-es/event-store"
import { ensureHandlersInstalled, rebuildProjection, type Projection } from "@dcb-es/event-store-postgres"

export interface EnsureProjectionsCurrentOptions {
    /** The inline projections passed to `new PostgresEventStore({ inlineProjections })`. */
    inline?: Projection[]
    bookmarkTableName?: string
}

/**
 * Keep projections consistent as read models grow one event at a time.
 *
 * An async projection's consumer only reads the event types in `canHandle`, from its
 * bookmark onward. An inline projection only sees the events appended after it was
 * deployed. Either way, when an extension slice adds an event type, events of that
 * type recorded *before* the upgrade would never be projected. The same is true when
 * an extension derives a new field from an event the projection already handled
 * (signalled by bumping `version`).
 *
 * Each projection's fingerprint — `version` plus its sorted `canHandle`, prefixed
 * `inline:` for an inline projection — is stored. On startup, any projection whose
 * fingerprint changed is rebuilt (truncate → replay from the beginning) before the
 * app takes requests. A projection seen for the first time is:
 * - async: only recorded — its consumer starts from the beginning anyway;
 * - inline: rebuilt — nothing else would ever project the history recorded before it.
 * Switching a projection between async and inline changes its fingerprint, so it is
 * rebuilt too.
 *
 * Call after `eventStore.ensureInstalled()`, the async projections' `init()` and
 * `ensureHandlersInstalled()`, and before `createConsumer()` and `startAPI()`.
 */
export async function ensureProjectionsCurrent(
    pool: Pool,
    eventStore: EventStore,
    projections: Projection[],
    options: EnsureProjectionsCurrentOptions = {}
): Promise<string[]> {
    const bookmarkTableName = options.bookmarkTableName ?? "_handler_bookmarks"
    await pool.query(`
        CREATE TABLE IF NOT EXISTS _projection_fingerprints (
            name        TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)

    // rebuildProjection() replays through a temporary consumer, which needs a bookmark row. An inline
    // projection has no consumer of its own, so nothing else creates one (nor the table, in an app
    // whose projections are all inline).
    const inlineNames = (options.inline ?? []).map(p => p.name)
    if (inlineNames.length > 0) await ensureHandlersInstalled(pool, inlineNames, bookmarkTableName)

    const all = [
        ...projections.map(projection => ({ projection, inline: false })),
        ...(options.inline ?? []).map(projection => ({ projection, inline: true }))
    ]

    const rebuilt: string[] = []
    for (const { projection, inline } of all) {
        const fingerprint = projectionFingerprint(projection, inline)
        const stored = await pool.query<{ fingerprint: string }>(
            "SELECT fingerprint FROM _projection_fingerprints WHERE name = $1",
            [projection.name]
        )
        const previous = stored.rows[0]?.fingerprint

        const changed = previous !== undefined && previous !== fingerprint
        const newInline = previous === undefined && inline
        if (changed || newInline) {
            console.log(`Rebuilding ${projection.name}: ${previous ?? "(new inline projection)"} → ${fingerprint}`)
            await rebuildProjection({ pool, eventStore, projection, bookmarkTableName })
            rebuilt.push(projection.name)
        }

        if (previous !== fingerprint) {
            await pool.query(
                `INSERT INTO _projection_fingerprints (name, fingerprint) VALUES ($1, $2)
                 ON CONFLICT (name) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, updated_at = now()`,
                [projection.name, fingerprint]
            )
        }
    }
    return rebuilt
}

export function projectionFingerprint(projection: Projection, inline = false): string {
    const base = `v${projection.version ?? 1}:${[...projection.canHandle].sort().join(",")}`
    return inline ? `inline:${base}` : base
}
