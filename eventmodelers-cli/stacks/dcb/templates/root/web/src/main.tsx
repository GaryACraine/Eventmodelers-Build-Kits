import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import "./styles/design-system.css"

/** In mock mode every API request is answered by MSW from src/mocks/handlers.ts, not the backend. */
async function startMocks() {
    if (import.meta.env.VITE_DATA_MODE !== "mock") return
    const { worker } = await import("./mocks/browser")
    await worker.start({ onUnhandledRequest: "warn" })
}

await startMocks()
createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>
)
