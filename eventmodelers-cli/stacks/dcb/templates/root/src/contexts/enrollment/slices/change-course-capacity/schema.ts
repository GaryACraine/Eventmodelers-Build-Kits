import { z } from "zod"
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi"
import { registerCommand } from "../../../../shared/openapi.js"

extendZodWithOpenApi(z)

export const UpdateCourseCapacitySchema = z
    .object({
        newCapacity: z.number().int().min(1).openapi({ example: 50, description: "New maximum student capacity" })
    })
    .openapi("UpdateCourseCapacityBody")

registerCommand({
    method: "put",
    path: "/courses/:courseId/capacity",
    summary: "Change a course's capacity",
    body: UpdateCourseCapacitySchema,
    success: "noContent",
    errors: { 404: "Course not found", 422: "New capacity is the same as the current one" }
})
