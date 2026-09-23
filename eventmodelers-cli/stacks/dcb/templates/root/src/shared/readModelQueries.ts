import { createHash } from "node:crypto"

/**
 * Read model queries: named where predicates over a read model's documents (ADR-023).
 *
 * A query is declared on the read model definition, e.g.
 *
 *     queries: {
 *         availableCourses: { params: { minRemainingSeats: { field: "remainingSeats", op: "gte", type: "number" } } },
 *         coursesForStudent: {
 *             params: { studentId: { field: "subscribedStudents.studentId", op: "contains", type: "string", tag: "studentId" } },
 *             sort: { field: "title" }
 *         }
 *     }
 *
 * and served as `GET {path}?{params}` → `{ data: [...documents], cursor? }` by every read model type.
 * This file holds the parts both runners share, so they can't disagree:
 *
 * - `matchesQuery` / `sortTuple` / `compareTuples` — the semantics, evaluated in memory (live runner)
 * - `buildQuerySql` — the same semantics as parameterised JSONB SQL (stored runners)
 *
 * The SQL is written here, not delegated to pongo's `find`: pongo compares ranges as text (so 10 < 9),
 * doesn't reach into arrays along a dot path, and sorts strings by the database collation. Here:
 * - comparisons are typed: a parameter of type number only matches JSON numbers, compared numerically;
 * - strings compare and sort by UTF-8 bytes (`COLLATE "C"` / `Buffer.compare`), never by locale;
 * - `contains` walks arrays along the path (Postgres jsonpath lax mode, mirrored in memory);
 * - a missing field matches only `ne`.
 */

export const QUERY_OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains"] as const
export type QueryOperator = (typeof QUERY_OPERATORS)[number]

export const QUERY_PARAM_TYPES = ["string", "number", "boolean"] as const
export type QueryParamType = (typeof QUERY_PARAM_TYPES)[number]

/** Query-string names used for paging — never a parameter. */
export const RESERVED_QUERY_PARAMS = ["limit", "cursor"] as const

export const DEFAULT_QUERY_LIMIT = 50
export const MAX_QUERY_LIMIT = 200

/** Operators that match a value the document holds (in an array field, for contains): the only ones a tag can narrow. */
const EQUALITY_OPERATORS: readonly QueryOperator[] = ["eq", "in", "contains"]

export interface QueryParamDefinition {
    /** Document field it compares, as a dot path: "remainingSeats", "subscribedStudents.studentId" */
    field: string
    /** Default "eq" */
    op?: QueryOperator
    type: QueryParamType
    /** Optional parameters drop their predicate when absent. Path parameters are always required. */
    optional?: boolean
    /** Tag key on the primary events that finds candidates for a live read (required eq/in/contains only) */
    tag?: string
}

export interface QueryDefinition {
    params: Record<string, QueryParamDefinition>
    /** Order of the page; the key breaks ties (in the same direction). Default: the key, ascending. */
    sort?: { field: string; direction?: "asc" | "desc" }
}

export type QueryValue = string | number | boolean
export type QueryParams = Record<string, QueryValue | QueryValue[]>

/** A position in a query's order: [type rank, number, string, key]. The cursor is this, encoded. */
export type SortTuple = [number, number, string, string]

export interface QueryPageRequest {
    limit: number
    after?: SortTuple
}

export interface QueryPage<TDoc = Record<string, unknown>> {
    data: TDoc[]
    cursor?: string
}

// ─── Validation (at definition time) ─────────────────────────────────────────

const PATH_SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function isFieldPath(path: string): boolean {
    return path.split(".").every(segment => PATH_SEGMENT.test(segment))
}

/** Throws on a query definition the runtime can't serve. Called by `defineReadModel`. */
export function validateQueries(readModel: string, queries: Record<string, QueryDefinition>): void {
    const problems: string[] = []
    for (const [name, query] of Object.entries(queries)) {
        for (const [param, def] of Object.entries(query.params)) {
            const at = `${readModel}.${name}.${param}`
            const op = def.op ?? "eq"
            if ((RESERVED_QUERY_PARAMS as readonly string[]).includes(param)) problems.push(`${at}: "${param}" is reserved for paging`)
            if (!isFieldPath(def.field)) problems.push(`${at}: field "${def.field}" must be a dot path of identifiers`)
            if (!(QUERY_OPERATORS as readonly string[]).includes(op)) problems.push(`${at}: unknown operator "${op}"`)
            if (!(QUERY_PARAM_TYPES as readonly string[]).includes(def.type)) problems.push(`${at}: type must be string, number or boolean`)
            if (def.tag !== undefined && (!EQUALITY_OPERATORS.includes(op) || def.optional)) {
                problems.push(`${at}: a tag needs a required eq, in or contains parameter`)
            }
        }
        if (query.sort && !isFieldPath(query.sort.field)) problems.push(`${readModel}.${name}: sort field "${query.sort.field}" must be a dot path`)
    }
    if (problems.length > 0) throw new Error(`Invalid read model queries:\n  ${problems.join("\n  ")}`)
}

/** The parameter a live read narrows candidates with, or undefined when the query is stored-only. */
export function liveNarrowingParam(query: QueryDefinition): string | undefined {
    return Object.entries(query.params).find(([, def]) => def.tag && !def.optional && EQUALITY_OPERATORS.includes(def.op ?? "eq"))?.[0]
}

// ─── Request parsing ─────────────────────────────────────────────────────────

function parseValue(raw: string, type: QueryParamType): QueryValue | undefined {
    if (type === "string") return raw
    if (type === "boolean") return raw === "true" ? true : raw === "false" ? false : undefined
    const n = Number(raw)
    return raw.trim() !== "" && Number.isFinite(n) ? n : undefined
}

export function encodeCursor(tuple: SortTuple): string {
    return Buffer.from(JSON.stringify(tuple)).toString("base64url")
}

function decodeCursor(cursor: string): SortTuple | undefined {
    try {
        const t = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
        const ok = Array.isArray(t) && t.length === 4 && typeof t[0] === "number" && typeof t[1] === "number" &&
            typeof t[2] === "string" && typeof t[3] === "string"
        return ok ? (t as SortTuple) : undefined
    } catch {
        return undefined
    }
}

/**
 * Parameters and paging from a request: path parameters (`req.params`) first, then the query string.
 * Returns a 400 detail instead when a required parameter is missing or a value doesn't parse.
 */
export function parseQueryRequest(
    query: QueryDefinition,
    pathParams: Record<string, string | undefined>,
    queryString: Record<string, unknown>
): { params: QueryParams; page: QueryPageRequest } | { error: string } {
    const params: QueryParams = {}
    for (const [name, def] of Object.entries(query.params)) {
        const raw = pathParams[name] ?? queryString[name]
        if (raw === undefined || raw === "") {
            if (def.optional && pathParams[name] === undefined) continue
            return { error: `Missing required parameter "${name}"` }
        }
        if (typeof raw !== "string") return { error: `Parameter "${name}" was given more than once` }
        if ((def.op ?? "eq") === "in") {
            const values = raw.split(",").map(v => parseValue(v, def.type))
            if (values.some(v => v === undefined)) return { error: `Parameter "${name}" must be a comma-separated list of ${def.type} values` }
            params[name] = values as QueryValue[]
        } else {
            const value = parseValue(raw, def.type)
            if (value === undefined) return { error: `Parameter "${name}" must be a ${def.type}` }
            params[name] = value
        }
    }

    let limit = DEFAULT_QUERY_LIMIT
    const rawLimit = queryString["limit"]
    if (rawLimit !== undefined) {
        const n = typeof rawLimit === "string" && /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN
        if (!(n >= 1)) return { error: "limit must be a positive integer" }
        limit = Math.min(n, MAX_QUERY_LIMIT)
    }
    let after: SortTuple | undefined
    const rawCursor = queryString["cursor"]
    if (rawCursor !== undefined) {
        after = typeof rawCursor === "string" ? decodeCursor(rawCursor) : undefined
        if (!after) return { error: "cursor is not valid" }
    }
    return { params, page: { limit, after } }
}

// ─── Semantics in memory (live runner) ───────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** The value at a dot path through objects only; undefined when missing or when the path crosses an array. */
function scalarAt(doc: unknown, path: string): unknown {
    let value: unknown = doc
    for (const segment of path.split(".")) {
        if (!isObject(value) || !Object.prototype.hasOwnProperty.call(value, segment)) return undefined
        value = value[segment]
    }
    return value
}

/** Every value a dot path reaches, unwrapping one level of array at each step and at the end (jsonpath lax mode). */
function laxValuesAt(value: unknown, segments: string[]): unknown[] {
    if (Array.isArray(value)) return value.flatMap(el => (Array.isArray(el) ? [] : laxStep(el, segments)))
    return laxStep(value, segments)
}
function laxStep(value: unknown, segments: string[]): unknown[] {
    if (segments.length === 0) return Array.isArray(value) ? value : [value]
    if (!isObject(value) || !Object.prototype.hasOwnProperty.call(value, segments[0])) return []
    return laxValuesAt(value[segments[0]], segments.slice(1))
}

export function compareStrings(a: string, b: string): number {
    return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
}

/** Compare two values of the declared type; undefined when the document's value isn't that type. */
function compareTyped(docValue: unknown, param: QueryValue, type: QueryParamType): number | undefined {
    if (typeof docValue !== type) return undefined
    if (type === "string") return compareStrings(docValue as string, param as string)
    if (type === "number") return (docValue as number) - (param as number)
    return Number(docValue) - Number(param)
}

function matchesParam(doc: unknown, def: QueryParamDefinition, value: QueryValue | QueryValue[]): boolean {
    const op = def.op ?? "eq"
    if (op === "contains") return laxValuesAt(doc, def.field.split(".")).some(v => compareTyped(v, value as QueryValue, def.type) === 0)
    const docValue = scalarAt(doc, def.field)
    if (op === "in") return (value as QueryValue[]).some(v => compareTyped(docValue, v, def.type) === 0)
    const c = compareTyped(docValue, value as QueryValue, def.type)
    switch (op) {
        case "eq": return c === 0
        case "ne": return c !== 0
        case "gt": return c !== undefined && c > 0
        case "gte": return c !== undefined && c >= 0
        case "lt": return c !== undefined && c < 0
        case "lte": return c !== undefined && c <= 0
    }
    return false
}

export function matchesQuery(doc: Record<string, unknown>, query: QueryDefinition, params: QueryParams): boolean {
    return Object.entries(query.params).every(([name, def]) => params[name] === undefined || matchesParam(doc, def, params[name]))
}

/** A document's position in the query's order. Types rank: missing/null < number < string < boolean < object/array. */
export function sortTuple(doc: Record<string, unknown>, key: string, query: QueryDefinition): SortTuple {
    if (!query.sort) return [0, 0, "", key]
    const v = scalarAt(doc, query.sort.field)
    if (typeof v === "number") return [1, v, "", key]
    if (typeof v === "string") return [2, 0, v, key]
    if (typeof v === "boolean") return [3, v ? 1 : 0, "", key]
    if (typeof v === "object" && v !== null) return [4, 0, "", key]
    return [0, 0, "", key]
}

export function compareTuples(a: SortTuple, b: SortTuple): number {
    return a[0] - b[0] || a[1] - b[1] || compareStrings(a[2], b[2]) || compareStrings(a[3], b[3])
}

/** Order, cursor and limit over already-matched documents (live runner). */
export function pageOf<TDoc extends Record<string, unknown>>(
    rows: { key: string; doc: TDoc }[],
    query: QueryDefinition,
    page: QueryPageRequest
): QueryPage<TDoc> {
    const sign = query.sort?.direction === "desc" ? -1 : 1
    const ordered = rows
        .map(row => ({ ...row, tuple: sortTuple(row.doc, row.key, query) }))
        .filter(row => !page.after || sign * compareTuples(row.tuple, page.after) > 0)
        .sort((a, b) => sign * compareTuples(a.tuple, b.tuple))
    const slice = ordered.slice(0, page.limit)
    return {
        data: slice.map(r => r.doc),
        ...(ordered.length > page.limit ? { cursor: encodeCursor(slice[slice.length - 1].tuple) } : {})
    }
}

// ─── The same semantics in SQL (stored runners) ──────────────────────────────

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`

/** `data #> '{a,b}'` — the jsonb at a dot path through objects (NULL when missing or crossing an array). */
function jsonAt(path: string): string {
    return `(data #> '{${path.split(".").join(",")}}')`
}

/** The typed value at a path, or NULL when it isn't that JSON type. Strings compare by bytes (COLLATE "C"). */
function typedAt(path: string, type: QueryParamType): string {
    const x = jsonAt(path)
    if (type === "number") return `(CASE WHEN jsonb_typeof(${x}) = 'number' THEN (${x} #>> '{}')::numeric END)`
    if (type === "boolean") return `(CASE WHEN jsonb_typeof(${x}) = 'boolean' THEN (${x} #>> '{}')::boolean END)`
    return `((CASE WHEN jsonb_typeof(${x}) = 'string' THEN (${x} #>> '{}') END) COLLATE "C")`
}

const SQL_TYPE: Record<QueryParamType, string> = { string: "text", number: "numeric", boolean: "boolean" }

/** The order expressions — mirror `sortTuple`: [rank, number, string, key], never NULL. */
function tupleSql(query: QueryDefinition): [string, string, string, string] {
    const key = `(_id COLLATE "C")`
    // Cast, so ORDER BY doesn't read a bare 0 as a column position
    if (!query.sort) return ["(0::int)", "(0::numeric)", `(''::text COLLATE "C")`, key]
    const x = jsonAt(query.sort.field)
    return [
        `(CASE jsonb_typeof(${x}) WHEN 'number' THEN 1 WHEN 'string' THEN 2 WHEN 'boolean' THEN 3 WHEN 'object' THEN 4 WHEN 'array' THEN 4 ELSE 0 END)`,
        `(CASE jsonb_typeof(${x}) WHEN 'number' THEN (${x} #>> '{}')::numeric WHEN 'boolean' THEN (CASE WHEN ${x} = 'true'::jsonb THEN 1 ELSE 0 END) ELSE 0 END)`,
        `((CASE WHEN jsonb_typeof(${x}) = 'string' THEN (${x} #>> '{}') ELSE '' END) COLLATE "C")`,
        key
    ]
}

/** A jsonpath literal for `contains`: `lax $."a"."b" ? (@ == "s1")` */
function containsPath(field: string, value: QueryValue): string {
    const accessors = field.split(".").map(s => `.${JSON.stringify(s)}`).join("")
    return `lax $${accessors} ? (@ == ${JSON.stringify(value)})`
}

/** Parameterised SELECT for one page of a stored read model's query (fetches limit + 1 to know if there's more). */
export function buildQuerySql(
    collection: string,
    query: QueryDefinition,
    params: QueryParams,
    page: QueryPageRequest
): { text: string; values: unknown[] } {
    const values: unknown[] = []
    const bind = (value: unknown, cast: string) => {
        values.push(value)
        return `$${values.length}::${cast}`
    }
    const where: string[] = []
    for (const [name, def] of Object.entries(query.params)) {
        const value = params[name]
        if (value === undefined) continue
        const op = def.op ?? "eq"
        if (op === "contains") {
            where.push(`(data @? ${bind(containsPath(def.field, value as QueryValue), "jsonpath")})`)
            continue
        }
        const e = typedAt(def.field, def.type)
        const cast = SQL_TYPE[def.type]
        switch (op) {
            case "eq": where.push(`${e} = ${bind(value, cast)}`); break
            case "ne": where.push(`${e} IS DISTINCT FROM ${bind(value, cast)}`); break
            case "gt": where.push(`${e} > ${bind(value, cast)}`); break
            case "gte": where.push(`${e} >= ${bind(value, cast)}`); break
            case "lt": where.push(`${e} < ${bind(value, cast)}`); break
            case "lte": where.push(`${e} <= ${bind(value, cast)}`); break
            case "in": where.push(`${e} = ANY(${bind(value, `${cast}[]`)})`); break
        }
    }

    const desc = query.sort?.direction === "desc"
    const tuple = tupleSql(query)
    if (page.after) {
        const [r, n, s, k] = page.after
        const after = `(${bind(r, "int")}, ${bind(n, "numeric")}, ${bind(s, "text")}, ${bind(k, "text")})`
        where.push(`(${tuple.join(", ")}) ${desc ? "<" : ">"} ${after}`)
    }
    const order = tuple.map(e => `${e} ${desc ? "DESC" : "ASC"}`).join(", ")
    const text =
        `SELECT _id, data FROM ${quoteIdent(collection)}` +
        (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
        ` ORDER BY ${order} LIMIT ${bind(page.limit + 1, "int")}`
    return { text, values }
}

/** Indexes for a stored read model's queries: one per compared field, GIN for contains, one per sort order. */
export function queryIndexStatements(collection: string, queries: Record<string, QueryDefinition>): string[] {
    const expressions = new Map<string, string>() // index name → CREATE INDEX statement
    const add = (using: string, expression: string) => {
        const name = `${collection}_q_${createHash("sha1").update(using + expression).digest("hex").slice(0, 10)}`
        expressions.set(name, `CREATE INDEX IF NOT EXISTS ${quoteIdent(name)} ON ${quoteIdent(collection)} USING ${using} (${expression})`)
    }
    for (const query of Object.values(queries)) {
        for (const def of Object.values(query.params)) {
            if ((def.op ?? "eq") === "contains") add("gin", "data jsonb_path_ops")
            else add("btree", typedAt(def.field, def.type))
        }
        if (query.sort) add("btree", tupleSql(query).join(", "))
    }
    return [...expressions.values()]
}
