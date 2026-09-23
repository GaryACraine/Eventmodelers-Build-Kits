import { z } from "zod"
import { registerRead } from "../../../../shared/openapi.js"

registerRead({
    path: "/events",
    summary: "Stream events as Server-Sent Events",
    query: z.object({
        after: z.string().optional().openapi({ description: "Start after this sequence position" }),
        types: z.string().optional().openapi({ description: "Comma-separated event types" }),
        tags: z.string().optional().openapi({ description: "Comma-separated key=value tags" })
    }),
    response: z.string().openapi({ description: "One SSE event per stored event" }),
    contentType: "text/event-stream"
})
