import { useCallback, useMemo, type ComponentType, type ReactNode } from "react"
import { generatePath, useNavigate, useParams, type NavigateFunction } from "react-router"
import { allows, navigation as fromModel, usePermissions, useReturnTo, type Navigation, type NavigationPage, type PagePart } from "./navigation"
import { built as fromBuilt, slices as fromSlices, type SliceParts } from "./parts"
import { useSessionState, type Session } from "./session"

/**
 * A page of the model (ADR-069), rendered from its entry in `navigation.json`: its heading, then each slice's part in
 * order. Nobody writes a page: the model says what it shows, and each slice exports its parts (`lib/parts.ts`).
 *
 * - **Ids:** each part's `props` come from the route, the session, or (in a list's row) the row.
 * - **Not built yet:** a part whose slice has no folder in `src/slices/` yet is left out until it's built.
 * - **Who sees what:** a gated part shows only to who may use it (its command's permission) or read it; nothing gated
 *   shows until the person's permissions arrive. The API still decides.
 * - **Rows:** a view with `row` puts those forms in each of its rows, with the row's ids.
 * - **Where it goes:** after a form's command, to its `next`, each id from the route, the command or the session; on
 *   the registration page (`register`), to where sign-up was going (`?next=`) first. Without `next`, it stays.
 * - **Lists:** on an entity's list page, rows open the entity's page, the empty state links the new one, and the
 *   person's own list with one row opens it (replacing the list, so Back doesn't return to it).
 */
export function ModelPage({
    path,
    page,
    navigation = fromModel,
    parts = fromSlices,
    built = fromBuilt
}: {
    path: string
    page: NavigationPage
    navigation?: Navigation
    parts?: SliceParts
    /** The slices whose screen is built: a part of another waits, unseen, until its slice is built */
    built?: ReadonlySet<string>
}) {
    const route = useParams()
    const { session, signedIn } = useSessionState()
    const permissions = usePermissions(page.tenant ? route[navigation?.tenantKey ?? "organisationId"] : undefined)
    const navigate = useNavigate()
    const returnTo = useReturnTo()
    const registers = navigation?.register === path

    const shown = (part: PagePart) => {
        if (!part.gate || permissions === undefined) return true
        const gate = part.gate
        const api = "read" in gate ? gate.read : page.actions.find((a) => a.command === gate.action)?.api
        return api === undefined || allows(api, permissions, signedIn)
    }
    const done = (part: PagePart, sent: Record<string, unknown>) => {
        if (registers && returnTo) return void navigate(returnTo)
        if (!part.next) return
        const values = Object.fromEntries(
            Object.entries(part.next.params).map(([name, from]) => [name, from === "route" ? route[name] : from === "session" ? session[name] : sent[name]])
        )
        const to = fill(part.next.route, values)
        if (to) void navigate(to)
    }
    const context: PartContext = { parts, built, route, session, navigate, shown, done }
    return (
        <>
            {page.heading && <h1>{page.heading}</h1>}
            {(page.parts ?? []).map((part) => (
                <Part key={`${part.slice}/${part.component}`} part={part} context={context} />
            ))}
        </>
    )
}

/**
 * Whether the page needs someone signed in: anything it reads or does is declared other than `anonymous` (a permission,
 * `self`, `link`). Its session keys are asked for then too (the stub sign-in); with real sign-in, the sign-in form
 * shows in its place until then.
 */
export function needsSignIn(page: NavigationPage): boolean {
    return !!page.session?.length || [...page.reads, ...page.actions.map((a) => a.api)].some((api) => api !== "anonymous")
}

interface PartContext {
    parts: SliceParts
    built: ReadonlySet<string>
    route: Record<string, string | undefined>
    session: Session
    navigate: NavigateFunction
    shown: (part: PagePart) => boolean
    done: (part: PagePart, sent: Record<string, unknown>) => void
}

/** A route filled from `values`, or undefined when one of its ids is missing (then the page stays where it is) */
function fill(route: string, values: Record<string, unknown>): string | undefined {
    const params: Record<string, string> = {}
    for (const [, name] of route.matchAll(/:(\w+)/g)) {
        const value = values[name]
        if (value === undefined || value === null || value === "") return undefined
        params[name] = String(value)
    }
    return generatePath(route, params)
}

type Row = Record<string, unknown>

function Part({ part, context, row }: { part: PagePart; context: PartContext; row?: Row }) {
    const Component = context.parts[part.slice]?.[part.component] as ComponentType<Record<string, unknown>> | undefined
    const { navigate, done } = context
    const links = part.links
    const onDone = useCallback((sent: Record<string, unknown>) => done(part, sent ?? {}), [done, part])
    const linkTo = useCallback((r: Row) => fill(links!.row!, r) ?? "", [links])
    const onlyOne = useCallback(
        (r: Row) => {
            const to = fill(links!.row!, r)
            if (to) void navigate(to, { replace: true })
        },
        [links, navigate]
    )
    const rowSlot = useCallback(
        (r: Row): ReactNode => (
            <>
                {part.row!.map((form) => (
                    <Part key={`${form.slice}/${form.component}`} part={form} context={context} row={r} />
                ))}
            </>
        ),
        [part.row, context]
    )
    const props = useMemo(() => {
        const values: Record<string, unknown> = {}
        for (const [name, from] of Object.entries(part.props)) {
            values[name] = from === "route" ? context.route[name] : from === "session" ? context.session[name] : row?.[name]
        }
        if (part.kind === "form") values.onDone = onDone
        if (links?.row) values.linkTo = linkTo
        if (links?.row && links.onlyOne) values.onlyOne = onlyOne
        if (links?.create) values.createPath = links.create
        if (part.row?.length) values.row = rowSlot
        return values
    }, [part, context.route, context.session, row, onDone, links, linkTo, onlyOne, rowSlot])
    if (!context.built.has(part.slice)) return null
    if (!Component) {
        throw new Error(`src/slices/${part.slice}/index.ts doesn't export ${part.component}, which navigation.json puts on this page`)
    }
    if (!context.shown(part)) return null
    return <Component {...props} />
}
