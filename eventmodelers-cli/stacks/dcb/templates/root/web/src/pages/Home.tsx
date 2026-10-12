import { Link, Navigate, useOutletContext } from "react-router"
import type { LayoutContext } from "@/Layout"
import type { PageInfo } from "@/lib/page"
import { useStartPath } from "@/lib/navigation"

export const page: PageInfo = { path: "/", title: "Home", nav: true }

/**
 * The start page. Once the model's menu exists (`src/navigation.json`, ADR-065) it opens the first item the person
 * may use, or Sign in; until then it lists the app's pages. `build-screen` leaves it alone; replace it when the app
 * needs a real one.
 */
export default function Home() {
    const { nav } = useOutletContext<LayoutContext>()
    const start = useStartPath()
    if (start && start !== "/") return <Navigate to={start} replace />
    const others = nav.filter((p) => p.path !== "/")
    return (
        <section className="mock-card">
            {others.length === 0 ? (
                <>
                    <h2>Nothing here yet</h2>
                    <p className="text-sm text-muted-foreground">
                        Screens appear here as the build loop builds the slices that have them.
                    </p>
                </>
            ) : (
                <>
                    <h2>Pages</h2>
                    <ul>
                        {others.map((p) => (
                            <li key={p.path}>
                                <Link to={p.path} className="underline">
                                    {p.title}
                                </Link>
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </section>
    )
}
