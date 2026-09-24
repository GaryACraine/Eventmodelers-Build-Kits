import type { ComponentType } from "react"
import type { RouteObject } from "react-router"
import { Layout } from "./Layout"
import type { PageInfo } from "./lib/page"
import { RequireSession } from "./lib/session"

/**
 * Every page of the app, found in `src/pages/`: one file per page, each exporting `page` (its route and title,
 * src/lib/page.ts) and a default component. `build-screen` adds a page per screen title, composed from the parts
 * each slice builds in `src/slices/<slice>/`. Nothing is listed by hand here.
 *
 * Routes are entity-shaped, for people (/courses, /courses/:courseId), and derived by emcli from the screens'
 * contracts (slice.json `screens[].page.route`). They are unrelated to the API's paths (ADR-025).
 */
interface PageModule {
    page?: PageInfo
    default?: ComponentType
}

const modules = import.meta.glob<PageModule>(["./pages/*.tsx", "!./pages/*.test.tsx"], { eager: true })

export const pages: (PageInfo & { Component: ComponentType })[] = Object.entries(modules)
    .map(([file, module]) => {
        if (!module.page || !module.default) throw new Error(`${file} must export \`page\` and a default component`)
        return { ...module.page, Component: module.default }
    })
    .sort((a, b) => a.path.localeCompare(b.path))

export const routes: RouteObject[] = [
    {
        path: "/",
        element: <Layout nav={pages.filter((p) => p.nav)} />,
        children: pages.map(({ path, session, Component }) => ({
            ...(path === "/" ? { index: true } : { path: path.slice(1) }),
            element: session?.length ? (
                <RequireSession keys={session}>
                    <Component />
                </RequireSession>
            ) : (
                <Component />
            )
        }))
    }
]
