import { setupServer } from "msw/node"
import { handlers } from "./handlers"

/** Mock mode in tests (src/test/setup.ts). A test can add its own with `server.use(...)`. */
export const server = setupServer(...handlers)
