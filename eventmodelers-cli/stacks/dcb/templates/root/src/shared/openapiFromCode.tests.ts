import { describe, test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildOpenApiDocument, toOpenApiPath } from "./openapi.js"
import { registerRoutesFromCode, sliceFiles } from "./openapiFromCode.js"

const contexts = join(import.meta.dirname, "..", "contexts")

/** The paths every slice's route.ts mounts by name (`router.get("/…")`, `readModelRoute(…, "/…")`), but /openapi.json. */
function mountedPaths(): string[] {
    const mounts = /(?:router\.(?:get|post|put|patch|delete)\(\s*|readModelRoute\([^)"]*?)"([^"]+)"/g
    return sliceFiles(contexts, "route.ts")
        .flatMap(file => [...readFileSync(file, "utf8").matchAll(mounts)].map(m => m[1]))
        .filter(path => path !== "/openapi.json")
        .map(toOpenApiPath)
}

describe("the OpenAPI document from the code, without a database (npm run openapi)", () => {
    test("configures every slice's routes against stand-ins, and documents every path they mount", async () => {
        expect(await registerRoutesFromCode(contexts, "route.ts")).toEqual([])
        const paths = Object.keys((buildOpenApiDocument({ title: "t", version: "1" }) as { paths: object }).paths)
        expect(paths).toEqual(expect.arrayContaining([...new Set(mountedPaths())]))
    })
})
