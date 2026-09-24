import { NavLink, Outlet } from "react-router"
import type { PageInfo } from "@/lib/page"
import { useSessionState } from "@/lib/session"
import { cn } from "@/lib/utils"

/** What the pages can read from the layout: `useOutletContext<LayoutContext>()` */
export interface LayoutContext {
    nav: PageInfo[]
}

/** The frame around every page: a header with the pages marked `nav` and who is signed in, and the page below it. */
export function Layout({ nav }: { nav: PageInfo[] }) {
    const { session, signOut } = useSessionState()
    const signedIn = Object.entries(session)
    const link = ({ isActive }: { isActive: boolean }) =>
        cn("text-sm text-muted-foreground hover:text-foreground", isActive && "text-foreground font-semibold")
    return (
        <div className="min-h-screen">
            <header className="border-b bg-card">
                <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-3">
                    <span className="font-semibold">App</span>
                    {nav.map((page) => (
                        <NavLink key={page.path} to={page.path} end className={link}>
                            {page.title}
                        </NavLink>
                    ))}
                    {signedIn.length > 0 && (
                        <span className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
                            {signedIn.map(([key, value]) => `${key} ${value}`).join(", ")}
                            <button type="button" className="underline hover:text-foreground" onClick={signOut}>
                                Sign out
                            </button>
                        </span>
                    )}
                </nav>
            </header>
            <main className="mx-auto max-w-5xl px-6 py-8">
                <Outlet context={{ nav } satisfies LayoutContext} />
            </main>
        </div>
    )
}
