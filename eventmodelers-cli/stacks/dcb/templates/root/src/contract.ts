/**
 * Checks the API the code serves against the contract the model wrote (`api/openapi.json`, PLAN 14.10, ADR-029):
 * `npm run contract:check`. No database, no server: the document is built from the code on disk, as `npm run
 * openapi` does.
 *
 * Prints each operation that matches, is pending (in the contract, not built yet) or differs, and exits 1 when one
 * differs or is served without being in the contract.
 *
 *   node dist/contract.js [--only "POST /rate-course,GET /course-ratings/{courseId}"]
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { buildOpenApiDocument } from "./shared/openapi.js"
import { registerRoutesFromCode, sliceFiles } from "./shared/openapiFromCode.js"
import { compareContract, extensionFields, renderReport, type ExtensionSlice } from "./shared/contract.js"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")
const contexts = join(here, "contexts")
const contractFile = join(root, "api", "openapi.json")

if (!existsSync(contractFile)) {
    console.error("No API contract (api/openapi.json): export the model (emcli workspace export --build-kit .build-kit) to write it.")
    process.exit(1)
}

const failures = await registerRoutesFromCode(contexts)
if (failures.length > 0) {
    console.error("Couldn't build the served document without a database:")
    for (const failure of failures) console.error(`  ${failure}`)
    process.exit(1)
}

const [documentFile] = sliceFiles(contexts, "document.js")
const served = documentFile && existsSync(documentFile)
    ? (await import(pathToFileURL(documentFile).href)).openApiDocument()
    : buildOpenApiDocument({ title: "API", version: "0.0.0" })

const onlyAt = process.argv.indexOf("--only")
const only = onlyAt > 0 ? process.argv[onlyAt + 1].split(",").map(s => s.trim()).filter(Boolean) : undefined
const contract = JSON.parse(readFileSync(contractFile, "utf8"))
const { lines, problems } = renderReport(compareContract(served, contract, { only, pendingFields: extensionFields(extensionSlices(), contract) }))
for (const line of lines) console.log(line)
process.exit(problems > 0 ? 1 : 0)

/** The extension slices in the loop's queue (`.build-kit/.slices`), and whether each one's backend is built. */
function extensionSlices(): ExtensionSlice[] {
    const read = (file: string) => {
        try {
            return JSON.parse(readFileSync(file, "utf8"))
        } catch {
            return undefined
        }
    }
    const slicesDir = join(root, ".build-kit", ".slices")
    const context = read(join(slicesDir, "current_context.json"))?.name
    if (!context) return []
    const entries: { folder: string; status?: string; concerns?: { backend?: { status?: string } } }[] =
        read(join(slicesDir, context, "index.json"))?.slices ?? []
    return entries.flatMap(entry => {
        const slice = read(join(slicesDir, context, entry.folder, "slice.json"))
        if (!slice?.extends) return []
        const status = entry.concerns?.backend?.status ?? entry.status
        return [{ ...slice, built: status === "Done" }]
    })
}
