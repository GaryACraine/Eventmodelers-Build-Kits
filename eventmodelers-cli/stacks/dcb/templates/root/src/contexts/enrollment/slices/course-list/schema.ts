import { z } from "zod"
import { registerRead } from "../../../../shared/openapi.js"
import { CourseSchema } from "../course-details/schema.js"

registerRead({
    path: "/courses",
    summary: "List courses (keyset-paginated)",
    query: z.object({
        limit: z.string().optional().openapi({ example: "20", description: "Page size (max 200)" }),
        cursor: z.string().optional().openapi({ description: "The last id of the previous page" })
    }),
    response: z.object({ data: z.array(CourseSchema), cursor: z.string().optional() }),
    wait: true
})
