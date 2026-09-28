/*
    Every external automation's workflow, for the Temporal worker (ADR-033). The worker bundles this file into
    Temporal's sandbox, so it may import only workflow code: each slice's `workflow.ts` adds one line, and lines are
    never changed or removed (like Events.ts).

    export { paymentRequest } from "./contexts/restaurant/slices/request-payment/workflow.js"
*/
export {}
