import { setupWorker } from "msw/browser"
import { handlers } from "./handlers"

/** Mock mode in the browser: a service worker answers the API from the handlers. */
export const worker = setupWorker(...handlers)
