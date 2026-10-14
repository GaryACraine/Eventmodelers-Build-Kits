import type { ReactNode } from "react"
import { Link } from "react-router"
import { ApiError, errorText } from "@/lib/api"

/**
 * What a read is doing: TanStack Query's result (`useQuery`), or a paged list's (`usePagedList`), whose `data` the
 * children don't need (they use its `rows`).
 */
export interface ReadState<T> {
    isPending: boolean
    isError: boolean
    error: Error | null
    data?: T
}

/**
 * An empty state (NN/g): what the person sees when there's nothing yet. It says so, and gives the way to fill it when
 * there is one (`to`: the page's `createPath`).
 */
export interface Empty {
    message: ReactNode
    action?: { label: string; to: string }
}

/** The empty state's one line, with its way forward */
export function EmptyState({ empty }: { empty: Empty }) {
    return (
        <p className="text-sm text-muted-foreground">
            {empty.message}
            {empty.action && (
                <>
                    {" "}
                    <Link to={empty.action.to}>{empty.action.label}</Link>
                </>
            )}
        </p>
    )
}

/**
 * A read's states, in the one order every view shows them (ADR-072):
 * - loading: a status message (WCAG 4.1.3), never an alert;
 * - still updating (a read model catching up with the person's last change, ADR-013): a status message, not an error;
 * - `empty`, when given: shown for a 404 (a read model whose document its first event creates) and when `isEmpty`;
 * - any other failure: the alert, in words a person can act on (`errorText`);
 * - then the data.
 */
export function ReadStates<T>({
    read,
    empty,
    isEmpty,
    children
}: {
    read: ReadState<T>
    empty?: Empty
    isEmpty?: (data: T) => boolean
    children: (data: T) => ReactNode
}) {
    if (read.isPending) {
        return (
            <p role="status" className="text-sm text-muted-foreground">
                Loading…
            </p>
        )
    }
    if (read.isError) {
        const error = read.error
        if (error instanceof ApiError && error.stillUpdating) {
            return (
                <p role="status" className="text-sm text-muted-foreground">
                    {error.message}
                </p>
            )
        }
        if (empty && error instanceof ApiError && error.status === 404) return <EmptyState empty={empty} />
        return <p role="alert">{errorText(error)}</p>
    }
    const data = read.data as T
    if (empty && isEmpty?.(data)) return <EmptyState empty={empty} />
    return <>{children(data)}</>
}

/**
 * A view's card (ADR-072): the mockup's `section.mock-card` and its heading, around a read's states (`ReadStates`).
 *
 *   <ViewCard title="Pending invitations" read={invitations} empty={{ message: "Nobody is invited yet." }}>
 *       {(data) => <DataTable … />}
 *   </ViewCard>
 */
export function ViewCard<T>({
    title,
    read,
    empty,
    isEmpty,
    children
}: {
    /** The mockup's heading (its `h2`); none when the mockup has none */
    title?: ReactNode
    read: ReadState<T>
    empty?: Empty
    isEmpty?: (data: T) => boolean
    children: (data: T) => ReactNode
}) {
    return (
        <section className="mock-card">
            {title && <h2>{title}</h2>}
            <ReadStates read={read} empty={empty} isEmpty={isEmpty}>
                {children}
            </ReadStates>
        </section>
    )
}
