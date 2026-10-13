import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createBrowserRouter, createMemoryRouter, RouterProvider } from "react-router"
import { routes } from "./routes"
import { retryRead } from "./lib/api"
import { SessionProvider, type Session } from "./lib/session"
import { StepUpProvider } from "./lib/step-up"
import { WritesProvider } from "./lib/writes"


/**
 * The app: server state through TanStack Query, the signed-in user through the session, pages through the router.
 * `initialPath` (tests) runs it in memory: no retries, and a `session` that isn't remembered.
 */
export function App({ initialPath, session }: { initialPath?: string; session?: Session }) {
    const [queryClient] = useState(
        () => new QueryClient({ defaultOptions: { queries: { retry: initialPath ? false : retryRead, refetchOnWindowFocus: false } } })
    )
    const [router] = useState(() =>
        initialPath ? createMemoryRouter(routes, { initialEntries: [initialPath] }) : createBrowserRouter(routes)
    )
    return (
        <QueryClientProvider client={queryClient}>
            <SessionProvider initial={session} remember={!initialPath}>
                <StepUpProvider>
                    <WritesProvider>
                        <RouterProvider router={router} />
                    </WritesProvider>
                </StepUpProvider>
            </SessionProvider>
        </QueryClientProvider>
    )
}
