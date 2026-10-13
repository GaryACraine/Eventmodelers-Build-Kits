import type { ReactNode } from "react"
import type { Navigation, PagePart } from "./navigation"

/**
 * The slices' parts (ADR-069): what each `src/slices/<slice>/index.ts` exports, by the slice's folder. A page is
 * never written by hand: `ModelPage` puts the parts `navigation.json` names on it, so a slice only builds and exports
 * its own.
 *
 *   // src/slices/invitemember/index.ts
 *   export { InviteMemberForm } from "./InviteMemberForm"
 *
 * The export's name is the one `navigation.json` gives (`emcli navigation` shows it): `{Command}Form` for a form,
 * `{ReadModel}View` for a view. A component named otherwise is exported under that name
 * (`export { CourseList as CourseListView } from "./CourseList"`).
 */
export type SliceParts = Record<string, Record<string, unknown>>

const modules = import.meta.glob<Record<string, unknown>>("../slices/*/index.ts", { eager: true })

export const slices: SliceParts = Object.fromEntries(
    Object.entries(modules).map(([file, exported]) => [file.split("/").at(-2)!, exported])
)

/** The slices whose screen is built: a folder in `src/slices/` with a component. A part of one not built yet waits */
export const built: ReadonlySet<string> = new Set(
    Object.keys(import.meta.glob(["../slices/*/*.tsx", "!../slices/*/*.test.tsx"])).map((file) => file.split("/").at(-2)!)
)

/**
 * What every form part takes besides its ids: `onDone` once its command succeeds, with what was sent and a 201's
 * generated fields (`{ ...body, ...data }`). The page decides where to go from there (`next`).
 */
export interface FormPart<Done = Record<string, unknown>> {
    onDone?: (done: Done) => void
}

/**
 * What every view part takes besides its ids. A list view takes them all: `row`, another slice's action in each row
 * (a last column, no header); `linkTo`, a row's page; `onlyOne`, called when the person's own list holds exactly one
 * row; `createPath`, the new page its empty state links. A view of one document ignores them.
 */
export interface ViewPart<Row = Record<string, unknown>> {
    row?: (row: Row) => ReactNode
    linkTo?: (row: Row) => string
    onlyOne?: (row: Row) => void
    createPath?: string
}

/** Every part `navigation` puts on a page, with its page's route */
export function partsOf(navigation: Navigation): { route: string; part: PagePart }[] {
    const all = (route: string, parts: PagePart[]): { route: string; part: PagePart }[] =>
        parts.flatMap((part) => [{ route, part }, ...all(route, part.row ?? [])])
    return Object.entries(navigation.pages).flatMap(([route, page]) => all(route, page.parts ?? []))
}

/**
 * The parts `navigation` names that a built slice doesn't export: "<route>: src/slices/<slice>/index.ts exports no
 * <component>". A slice not built yet (no folder in `src/slices/`) is waited for, not missing.
 */
export function missingParts(navigation: Navigation, from: SliceParts = slices, builtSlices: ReadonlySet<string> = built): string[] {
    return partsOf(navigation)
        .filter(({ part }) => builtSlices.has(part.slice) && typeof from[part.slice]?.[part.component] !== "function")
        .map(({ route, part }) =>
            from[part.slice]
                ? `${route}: src/slices/${part.slice}/index.ts exports no ${part.component}`
                : `${route}: src/slices/${part.slice}/index.ts is missing (it should export ${part.component})`
        )
}
