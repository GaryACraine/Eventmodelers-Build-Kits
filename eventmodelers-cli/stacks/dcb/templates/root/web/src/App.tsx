import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createBrowserRouter, createMemoryRouter, RouterProvider } from "react-router"
import { routes } from "./routes"

/** The app: server state through TanStack Query, pages through the router. `initialPath` is for tests. */
export function App({ initialPath }: { initialPath?: string }) {
    const [queryClient] = useState(
        () => new QueryClient({ defaultOptions: { queries: { retry: initialPath ? false : 1, refetchOnWindowFocus: false } } })
    )
    const [router] = useState(() =>
        initialPath ? createMemoryRouter(routes, { initialEntries: [initialPath] }) : createBrowserRouter(routes)
    )
    return (
        <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
        </QueryClientProvider>
    )
}
