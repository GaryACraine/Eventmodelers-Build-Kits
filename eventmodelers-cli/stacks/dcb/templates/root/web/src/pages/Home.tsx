import { Link, useOutletContext } from "react-router"
import type { LayoutContext } from "@/Layout"
import type { PageInfo } from "@/lib/page"

export const page: PageInfo = { path: "/", title: "Home", nav: true }

/** The start page: the app's pages. `build-screen` leaves it alone; replace it when the app needs a real one. */
export default function Home() {
    const { nav } = useOutletContext<LayoutContext>()
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
