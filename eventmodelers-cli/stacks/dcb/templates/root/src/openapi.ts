/**
 * Writes the API's OpenAPI document to a file, with no database and no server: `npm run openapi` (after
 * `npm run build`). `npm run gen:api` runs both, then generates the frontend's client from the file.
 *
 * The document is the one the running app serves at `/openapi.json` (the openapi slice's `openApiDocument`),
 * built from the code on disk, so it can't be stale the way a backend started earlier would be.
 *
 *   node dist/openapi.js [output]      default: web/openapi.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { buildOpenApiDocument } from "./shared/openapi.js"
import { registerRoutesFromCode, sliceFiles } from "./shared/openapiFromCode.js"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")
const contexts = join(here, "contexts")
const output = resolve(process.argv[2] ?? join(root, "web", "openapi.json"))

/** The openapi slice's document (title, version, description), or the same built here if the slice is gone. */
async function documentBuilder(): Promise<() => object> {
    const [document] = sliceFiles(contexts, "document.js")
    if (document && existsSync(document)) return (await import(pathToFileURL(document).href)).openApiDocument
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    return () => buildOpenApiDocument({ title: String(pkg.name ?? "API"), version: String(pkg.version ?? "0.0.0") })
}

const failures = await registerRoutesFromCode(contexts)
if (failures.length > 0) {
    console.error("Couldn't document every route without a database, so the document would be incomplete:")
    for (const failure of failures) console.error(`  ${failure}`)
    console.error("Generate from a running backend instead: API_URL=http://localhost:3000 npm --prefix web run gen:api")
    process.exit(1)
}

const document = (await documentBuilder())()
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, JSON.stringify(document, null, 2) + "\n")
console.log(`Wrote ${output} (${Object.keys((document as { paths?: object }).paths ?? {}).length} paths)`)
