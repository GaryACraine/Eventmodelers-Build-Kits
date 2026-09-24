import { NavLink, Outlet } from "react-router"
import { cn } from "@/lib/utils"

/** The frame around every page: a header with the app's navigation, and the page below it. */
export function Layout() {
    const link = ({ isActive }: { isActive: boolean }) =>
        cn("text-sm text-muted-foreground hover:text-foreground", isActive && "text-foreground font-semibold")
    return (
        <div className="min-h-screen">
            <header className="border-b bg-card">
                <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-3">
                    <span className="font-semibold">App</span>
                    <NavLink to="/" end className={link}>
                        Home
                    </NavLink>
                </nav>
            </header>
            <main className="mx-auto max-w-5xl px-6 py-8">
                <Outlet />
            </main>
        </div>
    )
}
