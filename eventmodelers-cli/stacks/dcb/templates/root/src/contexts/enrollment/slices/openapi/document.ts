import { readFileSync } from "node:fs"
import { buildOpenApiDocument } from "../../../../shared/openapi.js"

// The document's title and version come from package.json (the same relative path from src/ and dist/).
function packageInfo(): { title: string; version: string } {
    try {
        const pkg = JSON.parse(readFileSync(new URL("../../../../../package.json", import.meta.url), "utf8"))
        return { title: String(pkg.name ?? "API"), version: String(pkg.version ?? "0.0.0") }
    } catch {
        return { title: "API", version: "0.0.0" }
    }
}

/** Everything the slices registered (`src/shared/openapi.ts`): each command, read model, query and route. */
export function openApiDocument(): object {
    return buildOpenApiDocument({ ...packageInfo(), description: "DCB event store — vertical slice architecture" })
}
