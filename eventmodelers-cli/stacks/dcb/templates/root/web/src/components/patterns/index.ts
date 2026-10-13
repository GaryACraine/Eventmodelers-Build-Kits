/**
 * The kit's patterns (ADR-072): what every part is put together from. A part (a slice's form or view) writes the
 * mockup's words and order with these, and never its own loading line, alert, status, table, key-facts list, fieldset
 * or style: the commit check `23-web-patterns` refuses that. These are the kit's, like `components/ui/`: a loop job
 * never edits them, and one that needs a pattern that isn't here blocks with `request-feedback`.
 */
export { ViewCard, ReadStates, EmptyState, type ReadState, type Empty } from "./ViewCard"
export { FormCard } from "./FormCard"
export { Field, ChoiceGroup } from "./Field"
export { SummaryList } from "./SummaryList"
export { DataTable, type Column } from "./DataTable"
export { RowAction } from "./RowAction"
export { Confirm } from "./Confirm"
export { Value, formatValue, type ValueType } from "./Value"
