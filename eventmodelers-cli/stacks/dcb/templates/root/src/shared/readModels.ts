/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Pool } from "pg"
import { Query, Tags, type EventStore, type QueryItem, type SequencedEvent, type SequencePosition } from "@dcb-es/event-store"
import {
    PostgresEventStore,
    createConsumer,
    ensureHandlersInstalled,
    pongoProjection,
    projectionToProcessor,
    waitUntilProcessed,
    type PongoProjectionContext,
    type Projection,
    type RunningConsumer
} from "@dcb-es/event-store-postgres"
import { on, OK, preferWait, withETag, type WaitFunction, type WebApiSetup } from "@dcb-es/event-store-express"
import { ensureProjectionsCurrent } from "./ensureProjectionsCurrent.js"
import {
    buildQuerySql,
    encodeCursor,
    liveNarrowingParam,
    sortTuple,
    matchesQuery,
    pageOf,
    parseQueryRequest,
    queryIndexStatements,
    validateQueries,
    type QueryDefinition,
    type QueryPage,
    type QueryPageRequest,
    type QueryParams,
    type QueryValue
} from "./readModelQueries.js"

/**
 * Read models with a stable data shape, whichever type serves them (ADR-022).
 *
 * A read model is written once, as a keyed fold: `evolve(doc, event, lookups)` builds the document
 * for one key from that key's events, in position order. Data from another entity (a student's
 * name on a course) comes from declared `lookups`. The same definition then runs as any type:
 *
 * - `database-projected`: stored, updated by an async consumer (eventually consistent)
 * - `inline-projected`:   stored, updated inside the append transaction (immediately consistent)
 * - `live-report`:        not stored; each read folds the key's events straight from the event store,
 *                         with one union read for the lookups
 *
 * Both runners fold the same functions over the same events in the same order, so the document —
 * and so the response body — is identical across types. Switching type is a one-line change.
 *
 * Besides the keyed GET, a read model can declare named `queries` — where predicates over its documents,
 * served as `{ data, cursor? }` pages by every type at their own `path`, next to the keyed GET
 * (ADR-023, `readModelQueries.ts`).
 */

export const READ_MODEL_TYPES = ["database-projected", "inline-projected", "live-report"] as const
export type ReadModelType = (typeof READ_MODEL_TYPES)[number]

export type ReadModelDoc = Record<string, unknown>

export interface LookupDefinition<L extends ReadModelDoc = ReadModelDoc> {
    /** Tag key of the related entity, e.g. "studentId". Primary events reference it through this tag. */
    key: string
    /** The related entity's event types this lookup folds */
    canHandle: string[]
    /** Pure fold of one related entity's lookup entry */
    evolve: (entry: L | null, event: SequencedEvent) => L | null
}

/** Lookup entries visible to `evolve`: only the ids in the current event's tags. */
export type LookupViews<TLookups extends Record<string, ReadModelDoc>> = {
    readonly [K in keyof TLookups]: ReadonlyMap<string, TLookups[K]>
}

export interface ReadModelDefinition<
    TDoc extends ReadModelDoc,
    TLookups extends Record<string, ReadModelDoc> = Record<string, never>
> {
    /** Read model name, e.g. "CourseDetails". The stored projection is `${name}Projection`. */
    name: string
    type: ReadModelType
    /** The idAttribute field. Every primary event carries it as a tag: `${key}=${id}`. */
    key: string
    /** Collection the stored types keep documents in, e.g. "course_details" */
    collection: string
    /** Bump when `evolve` derives something new from an event it already handled (forces a rebuild) */
    version?: number
    /** Primary event types. Extension slices append to this list. */
    canHandle: string[]
    lookups?: { [K in keyof TLookups]: LookupDefinition<TLookups[K]> }
    /** Pure fold of one key's document. Return null to delete it. */
    evolve: (doc: TDoc | null, event: SequencedEvent, lookups: LookupViews<TLookups>) => TDoc | null
    /** Named where predicates over the documents (ADR-023). Adding one never rebuilds. */
    queries?: Record<string, QueryDefinition>
}

// Defaults are `any` so `ReadModel[]` (the scaffold's readModels array) holds read models with and
// without lookups: a definition's `evolve` parameters make the generics invariant.
export interface ReadModel<
    TDoc extends ReadModelDoc = any,
    TLookups extends Record<string, ReadModelDoc> = any
> extends ReadModelDefinition<TDoc, TLookups> {
    /** The stored runner: a pongo projection over this definition (used by the two stored types) */
    projection: Projection
}

export function defineReadModel<
    TDoc extends ReadModelDoc,
    TLookups extends Record<string, ReadModelDoc> = Record<string, never>
>(definition: ReadModelDefinition<TDoc, TLookups>): ReadModel<TDoc, TLookups> {
    if (definition.queries) validateQueries(definition.name, definition.queries)
    return { ...definition, projection: storedProjection(definition) }
}

/**
 * The same read model served as another type (tests; a retype is the `type:` line in the definition).
 * As live-report it keeps only the queries live can serve: the others are stored-only (ADR-023), and
 * the keyed contract tests still have to run live.
 */
export function withType<TDoc extends ReadModelDoc, TLookups extends Record<string, ReadModelDoc>>(
    readModel: ReadModel<TDoc, TLookups>,
    type: ReadModelType
): ReadModel<TDoc, TLookups> {
    if (type !== "live-report" || !readModel.queries) return { ...readModel, type }
    const servable = Object.entries(readModel.queries).filter(([, query]) => liveNarrowingParam(query))
    return { ...readModel, type, queries: Object.fromEntries(servable) }
}

/** The types that can serve a query: all three when a tag narrows it, the stored two otherwise (ADR-023). */
export function queryTypes(readModel: ReadModel<any, any>, queryName: string): ReadModelType[] {
    const query = readModel.queries?.[queryName]
    if (!query) throw new Error(`${readModel.name} has no query "${queryName}"`)
    return READ_MODEL_TYPES.filter(type => type !== "live-report" || liveNarrowingParam(query) !== undefined)
}

// ─── Folding (shared by both runners) ────────────────────────────────────────

/** Every value of tag `key` on an event (`courseId=c1` → "c1"). */
export function tagValues(event: SequencedEvent, key: string): string[] {
    const prefix = `${key}=`
    return event.tags.values.filter(t => t.startsWith(prefix)).map(t => t.slice(prefix.length))
}

function lookupEntries(definition: ReadModelDefinition<any, any>): [string, LookupDefinition][] {
    return Object.entries(definition.lookups ?? {}) as [string, LookupDefinition][]
}

function allHandledTypes(definition: ReadModelDefinition<any, any>): string[] {
    const types = new Set(definition.canHandle)
    for (const [, lookup] of lookupEntries(definition)) lookup.canHandle.forEach(t => types.add(t))
    return [...types]
}

/** Where the runners keep state while folding: stored collections, or in-memory maps. */
interface FoldState {
    getDoc(id: string): Promise<ReadModelDoc | null>
    setDoc(id: string, doc: ReadModelDoc | null): Promise<void>
    getLookup(name: string, id: string): Promise<ReadModelDoc | null>
    setLookup(name: string, id: string, entry: ReadModelDoc | null): Promise<void>
}

/**
 * Apply one event — the single place both runners share. Lookups first, then the primary document,
 * whose `evolve` sees only the lookup entries for ids in this event's tags.
 * `onlyKey` restricts the primary fold to one document (the live runner reads one key).
 */
async function foldEvent(
    definition: ReadModelDefinition<any, any>,
    event: SequencedEvent,
    state: FoldState,
    onlyKey?: string
): Promise<void> {
    const lookups = lookupEntries(definition)
    for (const [name, lookup] of lookups) {
        if (!lookup.canHandle.includes(event.event.type)) continue
        for (const id of tagValues(event, lookup.key)) {
            await state.setLookup(name, id, lookup.evolve(await state.getLookup(name, id), event))
        }
    }

    if (!definition.canHandle.includes(event.event.type)) return
    const views: Record<string, Map<string, ReadModelDoc>> = {}
    for (const [name, lookup] of lookups) {
        const view = new Map<string, ReadModelDoc>()
        for (const id of tagValues(event, lookup.key)) {
            const entry = await state.getLookup(name, id)
            if (entry) view.set(id, entry)
        }
        views[name] = view
    }
    for (const id of tagValues(event, definition.key)) {
        if (onlyKey !== undefined && id !== onlyKey) continue
        await state.setDoc(id, definition.evolve(await state.getDoc(id), event, views as any))
    }
}

// ─── Stored runner (database-projected, inline-projected) ────────────────────

const PONGO_META_KEYS = new Set(["_id", "_version", "_partition", "_archived", "_created", "_updated", "_etag"])

function stripMeta(doc: Record<string, unknown>): ReadModelDoc {
    return Object.fromEntries(Object.entries(doc).filter(([k]) => !PONGO_META_KEYS.has(k)))
}

function lookupCollectionName(definition: ReadModelDefinition<any, any>, lookup: string): string {
    return `_${definition.collection}_${lookup}`
}

function storedProjection(definition: ReadModelDefinition<any, any>): Projection {
    const collections = [
        definition.collection,
        ...lookupEntries(definition).map(([name]) => lookupCollectionName(definition, name))
    ]
    return pongoProjection({
        name: `${definition.name}Projection`,
        version: definition.version,
        canHandle: allHandledTypes(definition),
        init: async pongo => {
            for (const name of collections) await pongo.db().collection(name).createCollection()
        },
        handle: async (events: SequencedEvent[], context: PongoProjectionContext) => {
            const db = context.pongo.db()
            const upsert = async (collection: string, id: string, doc: ReadModelDoc | null) => {
                const c = db.collection<any>(collection)
                const existing = await c.findOne({ _id: id })
                if (doc === null) {
                    if (existing) await c.deleteOne({ _id: id })
                } else if (existing) {
                    await c.replaceOne({ _id: id }, doc)
                } else {
                    await c.insertOne({ _id: id, ...doc })
                }
            }
            const find = async (collection: string, id: string) => {
                const doc = await db.collection<any>(collection).findOne({ _id: id })
                return doc ? stripMeta(doc) : null
            }
            const state: FoldState = {
                getDoc: id => find(definition.collection, id),
                setDoc: (id, doc) => upsert(definition.collection, id, doc),
                getLookup: (name, id) => find(lookupCollectionName(definition, name), id),
                setLookup: (name, id, entry) => upsert(lookupCollectionName(definition, name), id, entry)
            }
            for (const event of events) await foldEvent(definition, event, state)
        },
        truncate: async pongo => {
            for (const name of collections) await pongo.db().collection(name).deleteMany()
        }
    })
}

// ─── Live runner (live-report) ───────────────────────────────────────────────

/** How many union reads a live read may take before giving up on a stable related-id set. */
const MAX_LIVE_READS = 5

/**
 * Fold one key's document straight from the event store.
 *
 * Read 1: the primary events for the key. Their tags name the related entities (studentId=…).
 * Read 2: one union read — the primary events OR each lookup's events for those ids — folded in
 * position order, exactly as the stored runner folds them. If read 2 shows related ids read 1 didn't
 * (a subscription committed in between), read again until the set is stable.
 */
export async function readLive(
    eventStore: EventStore,
    definition: ReadModelDefinition<any, any>,
    id: string
): Promise<ReadModelDoc | null> {
    const lookups = lookupEntries(definition)
    const related = new Map<string, Set<string>>(lookups.map(([name]) => [name, new Set<string>()]))
    const primary: QueryItem = { types: definition.canHandle, tags: Tags.fromObj({ [definition.key]: id }) }

    for (let attempt = 0; attempt < MAX_LIVE_READS; attempt++) {
        const items: QueryItem[] = [primary]
        for (const [name, lookup] of lookups) {
            const ids = [...related.get(name)!]
            if (ids.length > 0) items.push({ types: lookup.canHandle, tags: Tags.from(ids.map(v => `${lookup.key}=${v}`)) })
        }

        const events: SequencedEvent[] = []
        for await (const event of eventStore.read(Query.fromItems(items))) events.push(event)

        // Related ids referenced by this key's primary events
        let grew = false
        for (const event of events) {
            if (!definition.canHandle.includes(event.event.type)) continue
            if (!tagValues(event, definition.key).includes(id)) continue
            for (const [name, lookup] of lookups) {
                for (const relatedId of tagValues(event, lookup.key)) {
                    if (!related.get(name)!.has(relatedId)) {
                        related.get(name)!.add(relatedId)
                        grew = true
                    }
                }
            }
        }
        if (grew) continue

        let doc: ReadModelDoc | null = null
        const entries = new Map<string, ReadModelDoc | null>()
        const state: FoldState = {
            getDoc: async () => doc,
            setDoc: async (_, next) => {
                doc = next
            },
            getLookup: async (name, relatedId) => entries.get(`${name}\0${relatedId}`) ?? null,
            setLookup: async (name, relatedId, entry) => {
                entries.set(`${name}\0${relatedId}`, entry)
            }
        }
        for (const event of events) await foldEvent(definition, event, state, id)
        return doc
    }
    throw new Error(`${definition.name}: related entities kept changing during ${MAX_LIVE_READS} live reads of ${id}`)
}

/**
 * Run a query live (ADR-023). The query's tagged parameter finds the candidates — the keys of the
 * primary events carrying `{tag}={value}` — each candidate is folded with `readLive`, and then every
 * predicate is applied in memory, exactly as the stored runner's SQL applies it.
 */
export async function queryLive(
    eventStore: EventStore,
    definition: ReadModelDefinition<any, any>,
    queryName: string,
    params: QueryParams,
    page: QueryPageRequest
): Promise<QueryPage> {
    const query = definition.queries![queryName]
    const narrowing = liveNarrowingParam(query)
    if (!narrowing) throw new Error(`${definition.name}.${queryName}: live-report needs a required tagged eq/in/contains parameter`)
    const tag = query.params[narrowing].tag!
    const values = ([] as QueryValue[]).concat(params[narrowing] as QueryValue | QueryValue[])

    const candidates = new Set<string>()
    const narrowed = Query.fromItems([{ types: definition.canHandle, tags: Tags.from(values.map(v => `${tag}=${v}`)) }])
    for await (const event of eventStore.read(narrowed)) {
        for (const key of tagValues(event, definition.key)) candidates.add(key)
    }

    const rows: { key: string; doc: ReadModelDoc }[] = []
    for (const key of candidates) {
        const doc = await readLive(eventStore, definition, key)
        if (doc && matchesQuery(doc, query, params)) rows.push({ key, doc })
    }
    return pageOf(rows, query, page)
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

/** An imperative projection that can't be a keyed fold (ADR-022): stored only. */
export interface StoredProjectionRegistration {
    projection: Projection
    type: "database-projected" | "inline-projected"
}

export interface ReadModelRuntime {
    eventStore: PostgresEventStore
    /** Runs the async projections; absent when there are none */
    consumer?: RunningConsumer
    /** Fetch one document by key, whichever type serves the read model. */
    reader(readModel: ReadModel<any, any>): (id: string) => Promise<ReadModelDoc | null>
    /** Run a named query, whichever type serves the read model (ADR-023). */
    querier(readModel: ReadModel<any, any>, queryName: string): (params: QueryParams, page: QueryPageRequest) => Promise<QueryPage>
    /** Async read models only: waits for the consumer (the optional `Prefer: wait` extra). */
    waitFn(readModel: ReadModel<any, any>): WaitFunction | undefined
    stop(): Promise<void>
}

/**
 * Start every read model by its type: async ones on the consumer, inline ones inside the event
 * store's append transaction, live ones as event store reads. Brings stored projections up to date
 * first (`ensureProjectionsCurrent`), before the app takes requests.
 */
export async function startReadModels(
    pool: Pool,
    readModels: ReadModel<any, any>[],
    imperative: StoredProjectionRegistration[] = []
): Promise<ReadModelRuntime> {
    const asyncProjections = [
        ...readModels.filter(r => r.type === "database-projected").map(r => r.projection),
        ...imperative.filter(r => r.type === "database-projected").map(r => r.projection)
    ]
    const inlineProjections = [
        ...readModels.filter(r => r.type === "inline-projected").map(r => r.projection),
        ...imperative.filter(r => r.type === "inline-projected").map(r => r.projection)
    ]
    const liveProjections = readModels.filter(r => r.type === "live-report").map(r => r.projection)

    // A live read model can only serve queries a tag narrows (ADR-023) — refuse to start otherwise.
    const unservable = readModels
        .filter(r => r.type === "live-report")
        .flatMap(r => Object.entries(r.queries ?? {}).filter(([, q]) => !liveNarrowingParam(q)).map(([name]) => `${r.name}.${name}`))
    if (unservable.length > 0) {
        throw new Error(
            `live-report can't serve ${unservable.join(", ")}: no required eq/in/contains parameter declares a tag. ` +
                "Add one, or make the read model database-projected or inline-projected."
        )
    }

    const eventStore = new PostgresEventStore({ pool, inlineProjections })
    await eventStore.ensureInstalled()

    const client = await pool.connect()
    try {
        for (const projection of asyncProjections) await projection.init!(client)
    } finally {
        client.release()
    }
    for (const readModel of readModels.filter(r => r.type !== "live-report" && r.queries)) {
        for (const statement of queryIndexStatements(readModel.collection, readModel.queries!)) await pool.query(statement)
    }
    await ensureHandlersInstalled(pool, asyncProjections.map(p => p.name), "_handler_bookmarks")
    await ensureProjectionsCurrent(pool, eventStore, asyncProjections, {
        inline: inlineProjections,
        live: liveProjections
    })

    const consumer =
        asyncProjections.length > 0
            ? createConsumer({
                  pool,
                  eventStore,
                  processors: asyncProjections.map(p => projectionToProcessor(p, { batchSize: 100, startFrom: "BEGINNING" }))
              })
            : undefined

    // Routes import a slice's definition; serve it as the type it was *registered* with here.
    const registered = new Map(readModels.map(r => [r.name, r]))
    const resolve = (readModel: ReadModel<any, any>) => registered.get(readModel.name) ?? readModel

    return {
        eventStore,
        consumer,
        reader: requested => {
            const readModel = resolve(requested)
            return readModel.type === "live-report"
                ? id => readLive(eventStore, readModel, id)
                : async id => {
                      const r = await pool.query<{ data: Record<string, unknown> }>(
                          `SELECT data FROM ${readModel.collection} WHERE _id = $1`,
                          [id]
                      )
                      return r.rows[0] ? stripMeta(r.rows[0].data) : null
                  }
        },
        querier: (requested, queryName) => {
            const readModel = resolve(requested)
            const query = readModel.queries?.[queryName]
            if (!query) {
                // Registered without it: withType(…, "live-report") drops stored-only queries. The route
                // still mounts (the keyed tests run live); only calling the query fails.
                return async () => {
                    throw new Error(`${readModel.name}.${queryName} isn't served as ${readModel.type}`)
                }
            }
            if (readModel.type === "live-report") return (params, page) => queryLive(eventStore, readModel, queryName, params, page)
            return async (params, page) => {
                const sql = buildQuerySql(readModel.collection, query, params, page)
                const r = await pool.query<{ _id: string; data: Record<string, unknown> }>(sql.text, sql.values)
                // One extra row was fetched to tell whether there is a next page. Keep the SQL's order as is.
                const rows = r.rows.slice(0, page.limit)
                const last = rows[rows.length - 1]
                return {
                    data: rows.map(row => stripMeta(row.data)),
                    ...(r.rows.length > page.limit ? { cursor: encodeCursor(sortTuple(stripMeta(last.data), last._id, query)) } : {})
                }
            }
        },
        waitFn: requested => {
            const readModel = resolve(requested)
            return readModel.type === "database-projected"
                ? (position: SequencePosition, timeoutMs: number) =>
                      waitUntilProcessed(pool, readModel.projection.name, position, { timeoutMs })
                : undefined
        },
        stop: async () => {
            await consumer?.stop()
        }
    }
}

/**
 * The one GET route for a read model: `path` (e.g. "/courses/:courseId") → its document, or 404.
 * The body is the document itself, so it is the same whichever type serves it (ADR-022).
 * Async read models also honour `Prefer: wait` + `If-None-Match` and send a bookmark ETag — an
 * optional extra, outside the contract.
 */
export function readModelRoute(
    readModel: ReadModel<any, any>,
    runtime: Pick<ReadModelRuntime, "reader" | "querier" | "waitFn">,
    path: string,
    options: { pool?: Pool; notFound?: string } = {}
): WebApiSetup {
    const read = runtime.reader(readModel)
    const waitFn = runtime.waitFn(readModel)
    const param = path.match(/:(\w+)/)?.[1] ?? readModel.key
    // Every query that declares a path is served next to the keyed GET, so adding a query to a
    // read model never touches its route or the app's wiring (ADR-023).
    const queryRoutes = Object.entries(readModel.queries ?? {})
        .filter(([, query]) => query.path)
        .map(([name]) => readQueryRoute(readModel, runtime, name))

    return router => {
        if (waitFn) router.get(path, preferWait({ waitFn }))
        router.get(
            path,
            on(async req => {
                const doc = await read(req.params[param] as string)
                if (doc === null) {
                    const detail = options.notFound ?? `${readModel.name} not found`
                    return res => res.status(404).json({ status: 404, title: "Not Found", detail })
                }
                if (waitFn && options.pool) {
                    const r = await options.pool.query<{ last_sequence_position: string }>(
                        "SELECT last_sequence_position FROM _handler_bookmarks WHERE handler_id = $1",
                        [readModel.projection.name]
                    )
                    const bookmark = r.rows[0]?.last_sequence_position?.toString() ?? "0"
                    return res => {
                        withETag(bookmark)(res)
                        OK({ body: doc })(res)
                    }
                }
                return OK({ body: doc })
            })
        )
        for (const queryRoute of queryRoutes) queryRoute(router)
    }
}

/**
 * The GET route for a named query: `path` (default: the query's own, e.g. "/available-courses" or
 * "/students/:studentId/courses") → `{ data: [...documents], cursor? }`, the same page whichever type
 * serves the read model (ADR-023). 400 for a missing or unparseable parameter; never 404. Async read
 * models also honour `Prefer: wait`. `readModelRoute` mounts these for every query with a path.
 */
export function readQueryRoute(
    readModel: ReadModel<any, any>,
    runtime: Pick<ReadModelRuntime, "querier" | "waitFn">,
    queryName: string,
    path = readModel.queries?.[queryName]?.path
): WebApiSetup {
    const query = readModel.queries?.[queryName]
    if (!query) throw new Error(`${readModel.name} has no query "${queryName}"`)
    if (!path) throw new Error(`${readModel.name}.${queryName} has no path`)
    const run = runtime.querier(readModel, queryName)
    const waitFn = runtime.waitFn(readModel)

    return router => {
        if (waitFn) router.get(path, preferWait({ waitFn }))
        router.get(
            path,
            on(async req => {
                const parsed = parseQueryRequest(query, req.params as Record<string, string>, req.query as Record<string, unknown>)
                if ("error" in parsed) {
                    const detail = parsed.error
                    return res => res.status(400).json({ status: 400, title: "Bad Request", detail })
                }
                return OK({ body: await run(parsed.params, parsed.page) })
            })
        )
    }
}
