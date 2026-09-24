/**
 * What a page file tells the app about itself. Every `src/pages/<Page>.tsx` exports one as `page`, next to its
 * default component, and `src/routes.tsx` finds it: no page is listed by hand.
 *
 * The values come from slice.json's `screens[].page` (emcli derives them from the screen's contract):
 *
 *   export const page: PageInfo = { path: "/courses/:courseId", title: "Course Page", session: ["studentId"] }
 *
 * `path` is the page's client route: entity-shaped, for people. It is never the API's path (ADR-025): a page
 * calls the API through `src/lib/api.ts` with the paths in slice.json's `apiEndpoint`.
 */
export interface PageInfo {
    /** The client route: `page.route` ("/courses/:courseId"); "/" is the start page */
    path: string
    /** The page's title: `page.title` */
    title: string
    /** Link to it from the header. Only a page without route params can be linked without an ID */
    nav?: boolean
    /** The session keys it reads (`page.params` with `from: "session"`): the page asks for them before it shows */
    session?: string[]
}
