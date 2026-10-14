import { Fragment, type ReactNode } from "react"

/**
 * Key facts (ADR-072; GOV.UK's summary list): a `<dl>`, one key and its value per row, in the mockup's order. A value
 * is shown by `Value`. Rows of things alike (members, invitations) are a `DataTable`, not this.
 *
 *   <SummaryList rows={[["Name", data.name], ["Trial ends", <Value of={data.trialEndsAt} type="DateTime" />]]} />
 */
export function SummaryList({ rows }: { rows: [key: ReactNode, value: ReactNode][] }) {
    return (
        <dl>
            {rows.map(([key, value], i) => (
                <Fragment key={i}>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                </Fragment>
            ))}
        </dl>
    )
}
