/**
 * The API contract check (PLAN 14.10, ADR-029): does the API the code serves match `api/openapi.json`, the contract
 * emcli writes from the model? The UI is generated from the contract, so the two must agree on what its typed client
 * sees, operation by operation:
 * - the method and path, and each path or query parameter's name and whether it's required;
 * - the success status (204, 201 or 200);
 * - the request body and the success response: field names, required fields, type (string, number, boolean, array,
 *   object; an integer is a number, as it is in TypeScript), nested, and the component names they reference
 *   (the UI imports `components["schemas"]["RateCourseBody"]`).
 *
 * Summaries, descriptions, headers, formats, examples, nullability and which 4xx a rejection uses are ignored: the
 * model doesn't decide them, and the UI shows a rejection's `detail` whatever its status.
 *
 * A served operation missing from the contract is an error, except the infrastructure routes. A contract operation
 * not served yet is pending: that's a UI built before its backend, which is the point.
 */

type Json = Record<string, any>

/** Routes the app serves that aren't the model's: the event feed and the document itself. */
export const INFRASTRUCTURE = ["/events", "/openapi.json"]

/** A schema reduced to what the typed client sees. */
export type Shape =
    | { kind: "string" | "number" | "boolean" | "unknown" }
    | { kind: "array"; items: Shape }
    | { kind: "object"; fields: Record<string, { shape: Shape; required: boolean }> }
    | { kind: "ref"; name: string; target: Shape }

export interface OperationView {
    params: { name: string; in: string; required: boolean }[]
    success: string
    body?: Shape
    response?: Shape
}

export interface ContractReport {
    match: string[]
    pending: string[]
    differ: { op: string; what: string[] }[]
    extra: string[]
}

const METHODS = ["get", "post", "put", "patch", "delete"]

function shape(schema: Json | undefined, doc: Json, seen: Set<string> = new Set()): Shape {
    if (!schema) return { kind: "unknown" }
    if (typeof schema.$ref === "string") {
        const name = schema.$ref.split("/").pop()!
        if (seen.has(name)) return { kind: "ref", name, target: { kind: "unknown" } }
        return { kind: "ref", name, target: shape(doc.components?.schemas?.[name], doc, new Set([...seen, name])) }
    }
    // A nullable value (`type: ["string", "null"]`, `anyOf: [{…}, {type: "null"}]`) is its non-null type.
    const variants = (schema.anyOf ?? schema.oneOf) as Json[] | undefined
    if (variants) {
        const nonNull = variants.filter(v => v.type !== "null")
        if (nonNull.length === 1) return shape(nonNull[0], doc, seen)
        return { kind: "unknown" }
    }
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter((t: unknown) => t && t !== "null")
    const type = types[0] as string | undefined
    if (type === "array") return { kind: "array", items: shape(schema.items, doc, seen) }
    if (type === "object" || schema.properties) {
        const required = new Set<string>(schema.required ?? [])
        const fields: Record<string, { shape: Shape; required: boolean }> = {}
        for (const [name, property] of Object.entries(schema.properties ?? {})) {
            fields[name] = { shape: shape(property as Json, doc, seen), required: required.has(name) }
        }
        return { kind: "object", fields }
    }
    if (type === "integer" || type === "number") return { kind: "number" }
    if (type === "string" || type === "boolean") return { kind: type }
    return { kind: "unknown" }
}

const json = (content: Json | undefined): Json | undefined =>
    content?.["application/json"]?.schema

/** Every operation of a document, keyed `METHOD /path`. */
export function operations(doc: Json): Map<string, OperationView> {
    const ops = new Map<string, OperationView>()
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
        for (const method of METHODS) {
            const op = (item as Json)[method] as Json | undefined
            if (!op) continue
            const params = ((op.parameters ?? []) as Json[])
                .filter(p => p.in === "path" || p.in === "query")
                .map(p => ({ name: String(p.name), in: String(p.in), required: Boolean(p.required) }))
                .sort((a, b) => `${a.in} ${a.name}`.localeCompare(`${b.in} ${b.name}`))
            const successCodes = Object.keys(op.responses ?? {}).filter(code => /^2\d\d$/.test(code)).sort()
            const success = successCodes[0]
            const body = json(op.requestBody?.content)
            const response = success ? json(op.responses[success]?.content) : undefined
            ops.set(`${method.toUpperCase()} ${path}`, {
                params,
                success: successCodes.join(","),
                ...(body && { body: shape(body, doc) }),
                ...(response && { response: shape(response, doc) })
            })
        }
    }
    return ops
}

const label = (s: Shape): string =>
    s.kind === "ref" ? `${s.name}` : s.kind === "array" ? `${label(s.items)}[]` : s.kind

/** The differences between the contract's shape and the served one, each as a sentence naming where. */
function diffShape(where: string, contract: Shape | undefined, served: Shape | undefined, out: string[]): void {
    if (!contract && !served) return
    if (!contract || !served) {
        out.push(`${where}: ${contract ? `the contract has ${label(contract)}, the code has none` : `the code has ${label(served!)}, the contract has none`}`)
        return
    }
    if (contract.kind === "ref" || served.kind === "ref") {
        const a = contract.kind === "ref" ? contract.name : undefined
        const b = served.kind === "ref" ? served.name : undefined
        if (a !== b) out.push(`${where}: the contract names it ${a ?? "(inline)"}, the code ${b ?? "(inline)"}`)
        diffShape(where, contract.kind === "ref" ? contract.target : contract, served.kind === "ref" ? served.target : served, out)
        return
    }
    if (contract.kind !== served.kind) {
        out.push(`${where}: ${contract.kind} in the contract, ${served.kind} in the code`)
        return
    }
    if (contract.kind === "array" && served.kind === "array") {
        diffShape(`${where}[]`, contract.items, served.items, out)
        return
    }
    if (contract.kind === "object" && served.kind === "object") {
        for (const name of new Set([...Object.keys(contract.fields), ...Object.keys(served.fields)])) {
            const a = contract.fields[name]
            const b = served.fields[name]
            const at = `${where}.${name}`
            if (!a) out.push(`${at}: in the code, not in the contract`)
            else if (!b) out.push(`${at}: in the contract, missing from the code`)
            else {
                if (a.required !== b.required) {
                    out.push(`${at}: ${a.required ? "required" : "optional"} in the contract, ${b.required ? "required" : "optional"} in the code`)
                }
                diffShape(at, a.shape, b.shape, out)
            }
        }
    }
}

/** The differences between two views of one operation. */
export function diffOperation(contract: OperationView, served: OperationView): string[] {
    const out: string[] = []
    if (contract.success !== served.success) out.push(`answers ${served.success} in the code, ${contract.success} in the contract`)
    const key = (p: OperationView["params"][number]) => `${p.in} parameter ${p.name}`
    const a = new Map(contract.params.map(p => [key(p), p]))
    const b = new Map(served.params.map(p => [key(p), p]))
    for (const name of new Set([...a.keys(), ...b.keys()])) {
        if (!a.has(name)) out.push(`${name}: in the code, not in the contract`)
        else if (!b.has(name)) out.push(`${name}: in the contract, missing from the code`)
        else if (a.get(name)!.required !== b.get(name)!.required) {
            out.push(`${name}: ${a.get(name)!.required ? "required" : "optional"} in the contract, ${b.get(name)!.required ? "required" : "optional"} in the code`)
        }
    }
    diffShape("body", contract.body, served.body, out)
    diffShape("response", contract.response, served.response, out)
    return out
}

/**
 * Compares the served document with the contract. `only` limits it to those operations (`POST /rate-course`), e.g.
 * the ones a commit's slices serve; without it every operation is compared.
 */
export function compareContract(served: Json, contract: Json, { only }: { only?: string[] } = {}): ContractReport {
    const a = operations(contract)
    const b = operations(served)
    const wanted = only ? new Set(only) : undefined
    const report: ContractReport = { match: [], pending: [], differ: [], extra: [] }
    const keys = [...new Set([...a.keys(), ...b.keys()])].sort()
    for (const op of keys) {
        if (wanted && !wanted.has(op)) continue
        const path = op.slice(op.indexOf(" ") + 1)
        const inContract = a.get(op)
        const inCode = b.get(op)
        if (!inContract) {
            if (!INFRASTRUCTURE.includes(path)) report.extra.push(op)
        } else if (!inCode) {
            report.pending.push(op)
        } else {
            const what = diffOperation(inContract, inCode)
            if (what.length === 0) report.match.push(op)
            else report.differ.push({ op, what })
        }
    }
    return report
}

/** The report as lines to print; `problems` is how many operations differ or aren't in the contract. */
export function renderReport(report: ContractReport): { lines: string[]; problems: number } {
    const lines = [
        `API contract (api/openapi.json): ${report.match.length} match, ${report.pending.length} pending (not built yet), ` +
            `${report.differ.length} differ, ${report.extra.length} not in the contract`
    ]
    for (const { op, what } of report.differ) {
        lines.push(`  DIFFER  ${op}`)
        for (const line of what) lines.push(`          ${line}`)
    }
    for (const op of report.extra) lines.push(`  EXTRA   ${op} (served, but the model has no such route)`)
    for (const op of report.pending) lines.push(`  pending ${op}`)
    return { lines, problems: report.differ.length + report.extra.length }
}
