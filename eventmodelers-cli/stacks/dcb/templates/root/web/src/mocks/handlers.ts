import type { HttpHandler } from "msw"

/**
 * Mock responses for every route the app calls, served in mock mode (`npm run dev:mock`) and in tests.
 *
 * Each slice with a screen has its own `src/slices/<slice>/handlers.ts`, exporting `handlers`, built from its
 * **scenario examples** in slice.json: the same values as the mockup and the backend's specs. A rejection
 * scenario answers with its Problem-JSON and message. Never invent data that isn't in a scenario. They're found
 * here, never listed by hand.
 */
const slices = import.meta.glob<{ handlers: HttpHandler[] }>("../slices/*/handlers.ts", { eager: true })

export const handlers: HttpHandler[] = Object.values(slices).flatMap((slice) => slice.handlers)
