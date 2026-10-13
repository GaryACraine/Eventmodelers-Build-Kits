import type { ComponentType } from "react"
import type { RouteObject } from "react-router"
import { Layout } from "./Layout"
import type { PageInfo } from "./lib/page"
import { ModelPage } from "./lib/model-page"
import { navigation } from "./lib/navigation"
import { RequireSession } from "./lib/session"
import { signInMode } from "./lib/auth-client"
import { ForgotPasswordPage, ResetPasswordPage, SignInPage, SignUpPage } from "./lib/sign-in"
import { AccountPage, EMAIL_CHANGED_PAGE } from "./lib/account"

/**
 * Every page of the app. The model's come from `src/navigation.json` (ADR-069): emcli writes each page's parts there
 * at export, and `ModelPage` renders them from what the slices export (`src/slices/<slice>/index.ts`). Nobody writes
 * a model page, and no slice edits one.
 *
 * `src/pages/` holds the kit's own pages (Home, the start page), each exporting `page` (src/lib/page.ts) and a
 * default component. One there for a route the model has is an error: the model owns that page.
 *
 * Routes are entity-shaped, for people (/courses, /courses/:courseId), and derived by emcli from the screens'
 * contracts. They are unrelated to the API's paths (ADR-025).
 */
interface PageModule {
    page?: PageInfo
    default?: ComponentType
}

const modules = import.meta.glob<PageModule>(["./pages/*.tsx", "!./pages/*.test.tsx"], { eager: true })

const own: (PageInfo & { Component: ComponentType })[] = Object.entries(modules).map(([file, module]) => {
    if (!module.page || !module.default) throw new Error(`${file} must export \`page\` and a default component`)
    if (navigation?.pages[module.page.path]?.parts) {
        throw new Error(`${file} is the page ${module.page.path}, which the model owns (navigation.json, ADR-069): remove the file`)
    }
    return { ...module.page, Component: module.default }
})

const fromModel: (PageInfo & { Component: ComponentType })[] = Object.entries(navigation?.pages ?? {})
    .filter(([, page]) => page.parts)
    .map(([path, page]) => ({
        path,
        title: page.title,
        nav: !path.includes(":"),
        session: page.session,
        Component: () => <ModelPage path={path} page={page} />
    }))

export const pages: (PageInfo & { Component: ComponentType })[] = [...own, ...fromModel].sort((a, b) => a.path.localeCompare(b.path))

export const routes: RouteObject[] = [
    {
        path: "/",
        element: <Layout nav={pages.filter((p) => p.nav)} />,
        children: [
            // With real sign-in, the kit's sign-in screens (ADR-056, ADR-057): not pages of the model, never built by the loop
            ...(signInMode === "better-auth"
                ? [
                      { path: "sign-in", element: <SignInPage /> },
                      { path: "sign-up", element: <SignUpPage /> },
                      { path: "forgot-password", element: <ForgotPasswordPage /> },
                      { path: "reset-password", element: <ResetPasswordPage /> },
                      {
                          path: "account",
                          element: (
                              <RequireSession keys={["sub"]}>
                                  <AccountPage
                                      emailChangedPage={pages.some((p) => p.path === EMAIL_CHANGED_PAGE) ? EMAIL_CHANGED_PAGE : undefined}
                                  />
                              </RequireSession>
                          )
                      }
                  ]
                : []),
            ...pages.map(({ path, session, Component }) => ({
            ...(path === "/" ? { index: true } : { path: path.slice(1) }),
            element: session?.length ? (
                <RequireSession keys={session}>
                    <Component />
                </RequireSession>
            ) : (
                <Component />
            )
        }))
        ]
    }
]
