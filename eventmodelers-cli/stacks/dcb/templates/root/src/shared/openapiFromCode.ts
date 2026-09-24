/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { ReadModel } from "./readModels.js"

/**
 * Registers every route's OpenAPI paths the way startup does, with no database and no server (Phase 14.7), so
 * `npm run openapi` can write the document the frontend's client is generated from.
 *
 * It loads every slice's route module (each one imports its `schema`, which registers its commands and
 * hand-written reads) and configures every `configure…Route` it exports against stand-ins, so a
 * `readModelRoute` documents its keyed GET and queries. The stand-ins do nothing, except `waitFn`, which answers
 * as the real runtime does (async read models only), so the wait headers are documented as the app serves them.
 */

/** Any property, any call, any construction: another inert value. Never a promise (`then` is undefined). */
const inert: any = new Proxy(function () {}, {
    get: (_target, property) => (property === "then" || property === Symbol.toPrimitive ? undefined : inert),
    apply: () => inert,
    construct: () => inert
})

/** Named values, and inert for everything else. */
const standIn = (values: Record<string, unknown>): any =>
    new Proxy(values, { get: (target, property) => (property in target ? target[property as string] : inert) })

const readModels = standIn({
    waitFn: (readModel: ReadModel<any, any>) => (readModel.type === "database-projected" ? inert : undefined)
})
const deps = standIn({ store: inert, eventStore: inert, pool: inert, readModels })

/** `<contexts>/<context>/slices/<slice>/<file>`, every one that exists. */
export function sliceFiles(contextsDir: string, file: string): string[] {
    if (!existsSync(contextsDir)) return []
    return readdirSync(contextsDir).flatMap(context => {
        const slices = join(contextsDir, context, "slices")
        if (!existsSync(slices)) return []
        return readdirSync(slices)
            .map(slice => join(slices, slice, file))
            .filter(path => existsSync(path))
    })
}

/**
 * Configures every slice's routes under `contextsDir` (`route.js` in dist/, `route.ts` under vitest), so each
 * registers its paths. Returns the routes that couldn't be configured without a database: the document would
 * miss them.
 */
export async function registerRoutesFromCode(contextsDir: string, routeFile = "route.js"): Promise<string[]> {
    const failures: string[] = []
    for (const file of sliceFiles(contextsDir, routeFile)) {
        const module = await import(pathToFileURL(file).href)
        for (const [name, configure] of Object.entries(module)) {
            if (!/^configure\w*Route$/.test(name) || typeof configure !== "function") continue
            try {
                const setup = (configure as (deps: unknown) => unknown)(deps)
                if (typeof setup === "function") setup(inert)
            } catch (err) {
                failures.push(`${name} (${join(dirname(file), routeFile).slice(contextsDir.length + 1)}): ${(err as Error).message}`)
            }
        }
    }
    return failures
}
