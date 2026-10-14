import type { ReactNode } from "react"

/** How a value is shown: by its field's type in the model (slice.json), and its labels when it has them */
export type ValueType = "String" | "Int" | "Long" | "Double" | "Decimal" | "Boolean" | "Date" | "DateTime" | "Money"

/**
 * One value as a person reads it (ADR-072; NN/g's consistency and recognition): the same type is shown the same way
 * everywhere.
 * - `Date`, `DateTime`: in the person's locale (`Intl`), never an ISO string; a value that isn't a date is shown as given.
 * - `Money`: an amount with its `currency`, in the person's locale.
 * - `Boolean`: Yes or No. Numbers: grouped by the locale.
 * - `labels`: a coded value's words ("engineer" → "Engineer"); a code with no label is shown as given.
 * - A list (an array) is a list of its values; nothing (null, undefined, "") is shown as nothing.
 */
export function formatValue(
    of: unknown,
    { type = "String", currency, labels, locale }: { type?: ValueType; currency?: string; labels?: Record<string, string>; locale?: string } = {}
): string {
    if (of === undefined || of === null || of === "") return ""
    if (labels && String(of) in labels) return labels[String(of)]
    switch (type) {
        case "Date":
        case "DateTime": {
            const date = new Date(String(of))
            if (Number.isNaN(date.getTime())) return String(of)
            return new Intl.DateTimeFormat(locale, type === "Date" ? { dateStyle: "medium" } : { dateStyle: "medium", timeStyle: "short" }).format(date)
        }
        case "Money": {
            const amount = Number(of)
            if (!currency || Number.isNaN(amount)) return String(of)
            return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount)
        }
        case "Boolean":
            return of === true || of === "true" ? "Yes" : "No"
        case "Int":
        case "Long":
        case "Double":
        case "Decimal": {
            const n = Number(of)
            return Number.isNaN(n) ? String(of) : new Intl.NumberFormat(locale).format(n)
        }
        default:
            return String(of)
    }
}

/**
 *   <Value of={data.trialEndsAt} type="DateTime" />  <Value of={member.roles} labels={ROLES} />
 */
export function Value({
    of,
    ...how
}: {
    of: unknown
    type?: ValueType
    currency?: string
    labels?: Record<string, string>
    locale?: string
}): ReactNode {
    if (Array.isArray(of)) {
        if (of.length === 0) return null
        return (
            <ul>
                {of.map((item, i) => (
                    <li key={i}>{formatValue(item, how)}</li>
                ))}
            </ul>
        )
    }
    return formatValue(of, how)
}
