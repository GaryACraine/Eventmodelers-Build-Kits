import { createContext, useContext, useId, type ReactNode } from "react"
import { Link } from "react-router"
import { LoadMore } from "@/components/LoadMore"
import { EmptyState, type Empty } from "./ViewCard"

/** One column: its header (the mockup's `th`) and what each row shows in it */
export interface Column<Row> {
    header: ReactNode
    cell: (row: Row) => ReactNode
}

/** The row an action sits in: the id of the cell that names it, so the action's name includes the row (RowAction) */
const RowName = createContext<string | undefined>(undefined)

/** The id of the cell naming the row an action sits in, or undefined outside a DataTable */
export const useRowName = () => useContext(RowName)

/**
 * Rows of things alike (ADR-072; GOV.UK's table): the mockup's `table[data-list]`.
 * - The first column names the row: a row header (`th scope="row"`), a link to the row's page when the page gives
 *   `linkTo`.
 * - `actions` (the page's `row`: other slices' actions in each row) go in a last column whose header is named
 *   "Actions" for screen readers; each action's name includes the row's (`RowAction`).
 * - `empty` is shown instead of an empty table; `more` (a paged list, ADR-026) puts Load more under it.
 *
 *   <DataTable rows={data.invitations} rowKey={(i) => i.invitationId} columns={[{ header: "Email", cell: (i) => i.email }, …]}
 *              actions={row} empty={{ message: "Nobody is invited yet." }} />
 */
export function DataTable<Row>({
    rows,
    rowKey,
    columns,
    linkTo,
    actions,
    empty,
    more
}: {
    rows: Row[]
    rowKey: (row: Row) => string
    columns: Column<Row>[]
    linkTo?: (row: Row) => string
    actions?: (row: Row) => ReactNode
    empty?: Empty
    more?: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown }
}) {
    const id = useId()
    if (rows.length === 0 && empty) return <EmptyState empty={empty} />
    const [first, ...rest] = columns
    return (
        <>
            <table>
                <thead>
                    <tr>
                        {columns.map((column, i) => (
                            <th key={i} scope="col">
                                {column.header}
                            </th>
                        ))}
                        {actions && (
                            <th scope="col">
                                <span className="sr-only">Actions</span>
                            </th>
                        )}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => {
                        const key = rowKey(row)
                        const name = `${id}-${key}`
                        return (
                            <tr key={key}>
                                <th scope="row" id={name} className="font-normal">
                                    {linkTo ? <Link to={linkTo(row)}>{first.cell(row)}</Link> : first.cell(row)}
                                </th>
                                {rest.map((column, i) => (
                                    <td key={i}>{column.cell(row)}</td>
                                ))}
                                {actions && (
                                    <td>
                                        <RowName.Provider value={name}>{actions(row)}</RowName.Provider>
                                    </td>
                                )}
                            </tr>
                        )
                    })}
                </tbody>
            </table>
            {more && <LoadMore list={more} />}
        </>
    )
}
