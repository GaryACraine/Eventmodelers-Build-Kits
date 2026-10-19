import { useEffect, useState } from "react"
import { useSearchParams } from "react-router"
import { api } from "./api"
import { useSessionState } from "./session"

/**
 * The menu, from the model (ADR-065): emcli writes `src/navigation.json` at every export, beside the API contract.
 * Never edited, and no slice touches it: change the model (`emcli navigation` shows it).
 *
 * - `menu`: each top-level entity's list ("Organisations", with its create page), then each area's pages;
 * - `account`: the model's pages for the account menu, after the kit's own (Your account, Sign out);
 * - `pages`: every page by route, with the **permissions** its reads and commands need: the same `resource:action`
 *   strings the API checks and `api/roles.json` grants, or `self` or `link` (anyone signed in), or `anonymous`. Never roles;
 * - `register`: the page where a person who has just signed up registers (ADR-068). Sign-up goes there, carrying
 *   the page the person came from as `?next=`, and the page goes on to it after its command (`useReturnTo`);
 * - each page's `parts` (ADR-069): the slices' forms and views in order, which `ModelPage` renders. No slice edits a
 *   page: the model owns it.
 *
 * What the person holds comes from the API (`GET /my-permissions`, `?organisationId=` on an organisation's pages),
 * from the same role map and lookup as every permission route. Hiding is a courtesy: the API still refuses.
 */
/**
 * One slice's part of a page (ADR-069): `web/src/slices/<slice>/index.ts` exports `component`. Its `props` are the
 * ids it takes and where the page gets each; a gated part shows only to who may use it (`action`, by command) or read
 * it (`read`); a form's `next` is where the page goes once its command succeeds; a view's `links` open a row's page,
 * the new page, and the only row of the person's own list; `row` holds the forms put in each of the view's rows.
 * `external` names the system a view's read model is held by (ADR-075): the view reads that system's client in the
 * browser, never our API, so the page renders it like any other part.
 */
export interface PagePart {
    slice: string
    component: string
    kind: "form" | "view"
    command?: string
    readModel?: string
    gate?: { action: string } | { read: string }
    props: Record<string, "route" | "row" | "session">
    next?: { route: string; params: Record<string, "route" | "command" | "session"> }
    links?: { row?: string; create?: string; onlyOne?: boolean }
    row?: PagePart[]
    external?: string
    /** A form's: the view its confirmation shows, read with the values typed (ADR-077); not a part of its own */
    preview?: string
}

export interface NavigationPage {
    title: string
    /** Its `<h1>`, when the mockups draw one that binds nothing */
    heading?: string
    context: string
    entity?: string
    shape?: "one" | "list" | "new" | "other"
    area?: string
    hidden?: boolean
    /** Its route holds the tenant key: organisation roles count here */
    tenant: boolean
    reads: string[]
    actions: { command: string; api: string }[]
    /** The session keys it reads: the page asks for them (the stub sign-in) before it shows */
    session?: string[]
    /** What it shows, in order (ADR-069); absent in a navigation.json written before it */
    parts?: PagePart[]
}
export interface MenuItem {
    title: string
    path: string
    entity?: string
    create?: string
}
export interface MenuArea {
    area: string
    items: MenuItem[]
}
export interface Navigation {
    tenantKey: string
    entities: Record<string, { label: string; plural: string; parent?: string }>
    menu: (MenuItem | MenuArea)[]
    account: MenuItem[]
    pages: Record<string, NavigationPage>
    register?: string
}

// Absent until the first export that writes it: the layout then falls back to the pages marked `nav`
const files = import.meta.glob<{ default: Navigation }>("../navigation.json", { eager: true })
export const navigation: Navigation | undefined = Object.values(files)[0]?.default

/** May someone holding `permissions` use what needs `api`? Anonymous always; `self` and `link` when signed in; else held. */
export function allows(api: string, permissions: readonly string[], signedIn: boolean): boolean {
    if (api === "anonymous") return true
    if (api === "self" || api === "link") return signedIn
    return signedIn && permissions.includes(api)
}

/** A page is offered when every read it displays is allowed (its actions are offered one by one, `useAllowed`) */
export function pageAllowed(page: NavigationPage | undefined, permissions: readonly string[], signedIn: boolean): boolean {
    return !page || page.reads.every((api) => allows(api, permissions, signedIn))
}

const untyped = api as unknown as {
    GET: (path: string) => Promise<{ data?: { permissions: string[] }; response: Response }>
}

// One answer per organisation (and one for none) while the person stays signed in as the same account
const asked = new Map<string, Promise<string[]>>()
let askedFor: string | undefined

/** Forget what was asked (sign-out, another account, tests) */
export function forgetPermissions(): void {
    asked.clear()
}

/**
 * The permissions the signed-in person holds: platform-wide, plus an organisation's when `organisation` is given.
 * With the stub sign-in (no tokens, development only) there's nothing to ask, so everything is offered: `undefined`.
 */
export function usePermissions(organisation?: string): string[] | undefined {
    return usePermissionState(organisation).permissions
}

/** `usePermissions`, and whether the answer is still on its way (nothing to wait for with the stub, or signed out) */
function usePermissionState(organisation?: string): { permissions: string[] | undefined; loading: boolean } {
    const { signedIn, mode, session } = useSessionState()
    const asks = mode === "better-auth" && signedIn
    const key = organisation ?? ""
    const [permissions, setPermissions] = useState<{ key: string; list: string[] }>()
    useEffect(() => {
        if (!asks) return
        if (askedFor !== session.sub) {
            asked.clear()
            askedFor = session.sub
        }
        let current = true
        if (!asked.has(key)) {
            const tenantKey = navigation?.tenantKey ?? "organisationId"
            const query = organisation ? `?${new URLSearchParams({ [tenantKey]: organisation })}` : ""
            asked.set(key, untyped.GET(`/my-permissions${query}`).then(({ data }) => data?.permissions ?? [], () => []))
        }
        void asked.get(key)!.then((list) => current && setPermissions({ key, list }))
        return () => {
            current = false
        }
    }, [asks, key, organisation, session.sub])
    if (mode !== "better-auth") return { permissions: undefined, loading: false }
    const answered = asks && permissions?.key === key
    return { permissions: answered ? permissions.list : [], loading: asks && !answered }
}

/** The menu and the account menu, holding only what the person may use */
export function useMenu(from: Navigation | undefined = navigation): { menu: Navigation["menu"]; account: MenuItem[] } | undefined {
    const { signedIn } = useSessionState()
    const permissions = usePermissions()
    if (!from) return undefined
    const shown = (item: MenuItem) => permissions === undefined || pageAllowed(from.pages[item.path], permissions, signedIn)
    const menu = from.menu
        .map((m) => ("items" in m ? { ...m, items: m.items.filter(shown) } : m))
        .filter((m) => ("items" in m ? m.items.length > 0 : shown(m)))
        .map((m) => ("items" in m || !m.create || shown({ title: "", path: m.create }) ? m : { ...m, create: undefined }))
    return { menu, account: from.account.filter(shown) }
}

/**
 * Whether the person may use a command on this page (to offer its action): the command's permission, checked in the
 * organisation the page names: `useAllowed("/organisations/:organisationId", "reportCheckoutCompleted", organisationId)`.
 * A page of the model gets this from `ModelPage` (a part's `gate`, ADR-069); the kit's own pages call it.
 */
export function useAllowed(route: string, command: string, organisation?: string): boolean {
    const { signedIn } = useSessionState()
    const page = navigation?.pages[route]
    const permissions = usePermissions(page?.tenant ? organisation : undefined)
    const action = page?.actions.find((a) => a.command === command)
    if (!action || permissions === undefined) return true
    return allows(action.api, permissions, signedIn)
}

/**
 * Where the start page sends the person (ADR-065): the first menu item they may use, once their permissions are
 * known; Sign in when they're signed out (real sign-in only). Undefined: stay (still finding out, or nothing to open).
 */
export function useStartPath(from: Navigation | undefined = navigation): string | undefined {
    const { signedIn, mode, pending } = useSessionState()
    const { loading } = usePermissionState()
    const menu = useMenu(from)
    if (!from || pending) return undefined
    if (mode === "better-auth" && !signedIn) return "/sign-in"
    if (loading || !menu) return undefined
    const first = menu.menu[0]
    return first ? ("items" in first ? first.items[0]?.path : first.path) : undefined
}

/**
 * May the person read what needs `api` (a read model's declaration, e.g. `invitation:list`), in `organisation` when the
 * page's route names one? A page shows a part only then (ADR-068), as it offers an action only by `useAllowed`. Not
 * shown while the answer is on its way, so a part never asks the API for what it would refuse; everything with the stub
 * sign-in.
 */
export function useCanRead(api: string, organisation?: string): boolean {
    const { signedIn } = useSessionState()
    const permissions = usePermissions(organisation)   // nothing is held until the answer arrives
    if (permissions === undefined) return true
    return allows(api, permissions, signedIn)
}

/** A path on this site, never another origin */
const local = (path: string | null | undefined): path is string => !!path && path.startsWith("/") && !path.startsWith("//")

/**
 * Where the verification link of a sign-up lands (ADR-068): the registration page, carrying `next` unless it's the
 * start page or the registration page itself. A model with no registration page lands on `next` itself.
 */
export function afterSignUp(next: string, from: Navigation | undefined = navigation): string {
    const register = from?.register
    if (!register) return next
    if (next === "/" || next === register || next.startsWith(`${register}?`)) return register
    return `${register}?next=${encodeURIComponent(next)}`
}

/** The page a registration page goes on to: `?next=` when sign-up carried one, else undefined (its own next page) */
export function useReturnTo(): string | undefined {
    const [params] = useSearchParams()
    const next = params.get("next")
    return local(next) ? next : undefined
}
