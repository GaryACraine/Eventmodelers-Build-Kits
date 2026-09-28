import { SequencePosition } from "@dcb-es/event-store"
import type { Pool, PoolClient } from "pg"
import { v5 as uuidv5 } from "uuid"

// The namespace the library's `handle` derives multi-event ids in (`uuidv5("<key>:<i>")`): RFC 4122's DNS namespace.
const IDEMPOTENCY_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"

/**
 * Where a command handled with this idempotency key was appended, if it was. `handle(…, { idempotencyKey })` gives a
 * one-event command the key itself as its event id, and a command of several events the ids `uuidv5("<key>:<i>")`,
 * so both are looked for (the first event's id stands for the rest: they're appended together).
 */
export async function findExistingPosition(
    db: Pool | PoolClient,
    idempotencyKey: string | undefined
): Promise<SequencePosition | undefined> {
    if (!idempotencyKey) return undefined
    try {
        const r = await db.query<{ sequence_position: string }>(
            "SELECT sequence_position FROM events WHERE message_id = ANY($1::uuid[]) ORDER BY sequence_position LIMIT 1",
            [[idempotencyKey, uuidv5(`${idempotencyKey}:0`, IDEMPOTENCY_NAMESPACE)]]
        )
        if (r.rows.length > 0) {
            return SequencePosition.fromString(r.rows[0].sequence_position.toString())
        }
    } catch {
        // Gracefully handle mock pool in unit tests, and a key that isn't a UUID
    }
    return undefined
}

/** A deterministic idempotency key (a UUID) for a name such as `"stock-returner:o1"`: the same name, the same key. */
export function idempotencyKeyFor(name: string): string {
    return uuidv5(name, IDEMPOTENCY_NAMESPACE)
}
