import type { ReactElement } from "react"
import { render } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router"
import { SessionProvider, type Session } from "@/lib/session"
import { WritesProvider } from "@/lib/writes"

/**
 * Renders a slice's component the way the app would: TanStack Query (no retries), a session that isn't
 * remembered, read-your-writes and a router (for links). MSW answers its requests (src/test/setup.ts).
 *
 *   renderWithProviders(<SubscribeStudentForm courseId="c1" />, { session: { studentId: "s1" } })
 */
export function renderWithProviders(ui: ReactElement, { session, path = "/" }: { session?: Session; path?: string } = {}) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={queryClient}>
            <SessionProvider initial={session} remember={false}>
                <WritesProvider>
                    <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
                </WritesProvider>
            </SessionProvider>
        </QueryClientProvider>
    )
}
