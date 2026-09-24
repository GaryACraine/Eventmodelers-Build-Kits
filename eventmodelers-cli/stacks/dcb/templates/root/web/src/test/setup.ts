import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { server } from "../mocks/server"

// Every request in a test is answered by MSW; one it has no handler for fails the test.
beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => {
    server.resetHandlers()
    cleanup()
})
afterAll(() => server.close())
