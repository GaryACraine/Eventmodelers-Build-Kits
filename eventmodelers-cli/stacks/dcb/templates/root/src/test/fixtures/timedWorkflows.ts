import { proxyActivities, sleep } from "@temporalio/workflow"

// Workflows for the kit's own tests of timed work (ADR-042): a sweep a schedule starts, and a watch that tries on
// timers until its item is closed.

export interface TimedActivities {
    sweepOnce(): Promise<void>
    isOpen(key: string): Promise<boolean>
    fetchFor(key: string): Promise<void>
}

const { sweepOnce, isOpen, fetchFor } = proxyActivities<TimedActivities>({ startToCloseTimeout: "30 seconds" })

export async function sweep(): Promise<void> {
    await sweepOnce()
}

/** Try after each wait, stopping as soon as the item is closed; the number of tries made. */
export async function watch(key: string, waitsMs: number[]): Promise<number> {
    let tries = 0
    for (const wait of waitsMs) {
        await sleep(wait)
        if (!(await isOpen(key))) break
        await fetchFor(key)
        tries++
    }
    return tries
}
