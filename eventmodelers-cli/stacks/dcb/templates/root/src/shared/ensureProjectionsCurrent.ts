import type { Pool } from "pg"
import type { EventStore } from "@dcb-es/event-store"
import { rebuildProjection, type Projection } from "@dcb-es/event-store-postgres"

/**
 * Keep async projections consistent as read models grow one event at a time.
 *
 * A projection's consumer only reads the event types in `canHandle`, from its
 * bookmark onward. When an extension slice adds an event type, events of that
 * type recorded *before* the upgrade sit behind the bookmark and would never be
 * projected. The same is true when an extension derives a new field from an
 * event the projection already handled (signalled by bumping `version`).
 *
 * Each projection's fingerprint — `version` plus its sorted `canHandle` — is
 * stored. On startup, any projection whose fingerprint changed is rebuilt
 * (truncate → replay from the beginning) before consumers start. A projection
 * seen for the first time is only recorded: its consumer starts from the
 * beginning anyway.
 *
 * Call after `projection.init()` and `ensureHandlersInstalled()`, before
 * `createConsumer()`.
 */
export async function ensureProjectionsCurrent(
    pool: Pool,
    eventStore: EventStore,
    projections: Projection[],
    bookmarkTableName = "_handler_bookmarks"
): Promise<string[]> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS _projection_fingerprints (
            name        TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)

    const rebuilt: string[] = []
    for (const projection of projections) {
        const fingerprint = projectionFingerprint(projection)
        const stored = await pool.query<{ fingerprint: string }>(
            "SELECT fingerprint FROM _projection_fingerprints WHERE name = $1",
            [projection.name]
        )
        const previous = stored.rows[0]?.fingerprint

        if (previous !== undefined && previous !== fingerprint) {
            console.log(`Rebuilding ${projection.name}: ${previous} → ${fingerprint}`)
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

export function projectionFingerprint(projection: Projection): string {
    return `v${projection.version ?? 1}:${[...projection.canHandle].sort().join(",")}`
}
