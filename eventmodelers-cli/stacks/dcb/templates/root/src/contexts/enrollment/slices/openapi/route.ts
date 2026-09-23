import type { WebApiSetup } from "@dcb-es/event-store-express"
import { openApiDocument } from "./document.js"

// Built on the first request, once every slice has registered its paths.
export function configureOpenApiRoute(): WebApiSetup {
    let doc: object | undefined

    return router => {
        router.get("/openapi.json", (_req, res) => {
            doc ??= openApiDocument()
            res.json(doc)
        })
    }
}
