import { NavLink, Outlet, useLocation } from "react-router"
import type { PageInfo } from "@/lib/page"
import { navigation as fromModel, useMenu, type MenuItem, type Navigation } from "@/lib/navigation"
import { useSessionState } from "@/lib/session"
import { LinkExpired } from "@/lib/sign-in"
import { cn } from "@/lib/utils"

/** What the pages can read from the layout: `useOutletContext<LayoutContext>()` */
export interface LayoutContext {
    nav: PageInfo[]
}

const link = ({ isActive }: { isActive: boolean }) =>
    cn("text-sm text-muted-foreground hover:text-foreground", isActive && "text-foreground font-semibold")

/** A group of links under one name (an area with several pages, the account menu), opened by its name */
function Group({ name, label, children }: { name: string; label?: string; children: React.ReactNode }) {
    return (
        <details className="relative">
            <summary className="cursor-pointer list-none text-sm text-muted-foreground hover:text-foreground" aria-label={label}>
                {name}
            </summary>
            <ul className="absolute right-0 z-10 mt-2 min-w-48 rounded-md border bg-card p-2 shadow-md">{children}</ul>
        </details>
    )
}

const Item = ({ item }: { item: MenuItem }) => (
    <li className="px-2 py-1">
        <NavLink to={item.path} end className={link}>
            {item.title}
        </NavLink>
    </li>
)

/**
 * The frame around every page: the menu, the account menu, and the page below it.
 *
 * The menu comes from the model (`src/navigation.json`, ADR-065): the entities, then the areas, holding only what the
 * signed-in person may use. Until the model's first export writes it, the pages marked `nav` are linked instead.
 * The account menu is the kit's (utility navigation, ADR-065): signed out, Sign in and Sign up; signed in, the
 * person's email opens Your account, the model's account pages, and Sign out.
 */
export function Layout({ nav, navigation = fromModel }: { nav: PageInfo[]; navigation?: Navigation }) {
    const { session, signOut, mode, signedIn } = useSessionState()
    const menu = useMenu(navigation)
    // Signing in or up from the header comes back to this page (an invitation's, say: ADR-068), as the page's own form does
    const { pathname, search } = useLocation()
    const back = pathname === "/sign-in" || pathname === "/sign-up" ? new URLSearchParams(search).get("next") : pathname === "/" ? null : `${pathname}${search}`
    const carry = back ? `?next=${encodeURIComponent(back)}` : ""
    const typed = Object.entries(session)
    return (
        <div className="min-h-screen">
            <header className="border-b bg-card">
                <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-3">
                    <span className="font-semibold">App</span>
                    {menu
                        ? menu.menu.map((m) =>
                              "items" in m ? (
                                  m.items.length === 1 ? (
                                      <NavLink key={m.area} to={m.items[0].path} end className={link}>
                                          {m.items[0].title}
                                      </NavLink>
                                  ) : (
                                      <Group key={m.area} name={m.area}>
                                          {m.items.map((item) => (
                                              <Item key={item.path} item={item} />
                                          ))}
                                      </Group>
                                  )
                              ) : (
                                  <NavLink key={m.path} to={m.path} end className={link}>
                                      {m.title}
                                  </NavLink>
                              )
                          )
                        : nav.map((page) => (
                              <NavLink key={page.path} to={page.path} end className={link}>
                                  {page.title}
                              </NavLink>
                          ))}
                    <span className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
                        {mode === "better-auth" ? (
                            signedIn ? (
                                <Group name={session.email ?? "Your account"} label="Your account">
                                    <Item item={{ title: "Your account", path: "/account" }} />
                                    {menu?.account.map((item) => <Item key={item.path} item={item} />)}
                                    <li className="px-2 py-1">
                                        <button type="button" className="text-sm underline hover:text-foreground" onClick={signOut}>
                                            Sign out
                                        </button>
                                    </li>
                                </Group>
                            ) : (
                                <>
                                    <NavLink to={`/sign-in${carry}`} className={link}>
                                        Sign in
                                    </NavLink>
                                    <NavLink to={`/sign-up${carry}`} className={link}>
                                        Sign up
                                    </NavLink>
                                </>
                            )
                        ) : (
                            // The stub: the typed IDs, the model's account pages, and Sign out
                            typed.length > 0 && (
                                <>
                                    {typed.map(([key, value]) => `${key} ${value}`).join(", ")}
                                    {menu?.account.map((item) => (
                                        <NavLink key={item.path} to={item.path} className={link}>
                                            {item.title}
                                        </NavLink>
                                    ))}
                                    <button type="button" className="underline hover:text-foreground" onClick={signOut}>
                                        Sign out
                                    </button>
                                </>
                            )
                        )}
                    </span>
                </nav>
            </header>
            <main className="mx-auto max-w-5xl px-6 py-8">
                {mode === "better-auth" && <LinkExpired />}
                <Outlet context={{ nav } satisfies LayoutContext} />
            </main>
        </div>
    )
}
