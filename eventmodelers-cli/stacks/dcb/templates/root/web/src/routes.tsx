import type { RouteObject } from "react-router"
import { Layout } from "./Layout"
import { Home } from "./pages/Home"

/**
 * Every page of the app, in one place. `build-screen` adds a page per screen title (a screen shared by several
 * slices is one page, composed from each slice's part in src/slices/).
 *
 * Open decision (Build-Kits PLAN, "Entity-oriented routing"): people see a system as entities, and in a DCB
 * model an entity's identity is its ID attribute, the tag its events carry (courseId, studentId). The routes
 * should read that way (/courses, /courses/:courseId) even though the backend stores events. Until that's
 * decided, don't invent an entity structure here: add only the pages the screens ask for.
 */
export const routes: RouteObject[] = [
    {
        path: "/",
        element: <Layout />,
        children: [{ index: true, element: <Home /> }]
    }
]
