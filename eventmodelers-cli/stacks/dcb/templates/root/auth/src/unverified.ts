import type { Pool } from "pg"

/**
 * Accounts whose email was never verified are removed after `days` (ADR-056 D12: 7 by default,
 * `AUTH_UNVERIFIED_RETENTION_DAYS`). That covers a mistyped address too. Nothing of ours ever recorded them: they never
 * signed in, so no `userId`, organisation or checkout exists for them. Their sessions and accounts go with them
 * (`on delete cascade`). Returns how many were removed.
 */
export async function removeUnverifiedAccounts(pool: Pool, days: number, now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - days * 24 * 3_600_000)
    const { rowCount } = await pool.query(`delete from "user" where "emailVerified" = false and "createdAt" < $1`, [before])
    return rowCount ?? 0
}

/** Runs the removal at start and then every `everyMs` (hourly), in the sign-in service; stopped by the returned function */
export function removeUnverifiedAccountsRegularly(pool: Pool, days: number, everyMs = 3_600_000): () => void {
    const run = () =>
        removeUnverifiedAccounts(pool, days)
            .then(removed => removed && console.log(`[auth] removed ${removed} account(s) never verified in ${days} days`))
            .catch(error => console.error("[auth] couldn't remove unverified accounts:", error))
    void run()
    const timer = setInterval(run, everyMs)
    timer.unref()
    return () => clearInterval(timer)
}
