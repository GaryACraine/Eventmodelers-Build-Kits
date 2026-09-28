import { proxyActivities } from "@temporalio/workflow"

// A workflow for the kit's own tests (automations.tests.ts): call the outside system, then record the result as our
// command. Each activity is retried by configuration.

export interface LabelActivities {
    printLabel(parcelId: string): Promise<string>
    recordShipped(parcelId: string): Promise<void>
}

const { printLabel, recordShipped } = proxyActivities<LabelActivities>({
    startToCloseTimeout: "10 seconds",
    retry: { initialInterval: "100 milliseconds", backoffCoefficient: 2, maximumAttempts: 5 }
})

export async function printParcelLabel(parcelId: string): Promise<string> {
    const label = await printLabel(parcelId)
    await recordShipped(parcelId)
    return label
}
