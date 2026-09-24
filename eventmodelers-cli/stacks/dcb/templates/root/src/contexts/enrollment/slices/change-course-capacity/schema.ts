import { z } from "zod"
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi"
import { registerCommand } from "../../../../shared/openapi.js"

extendZodWithOpenApi(z)

export const UpdateCourseCapacitySchema = z
    .object({
        courseId: z.string().min(1).openapi({ example: "course-101", description: "ID of the course" }),
        newCapacity: z.number().int().min(1).openapi({ example: 50, description: "New maximum student capacity" })
    })
    .openapi("UpdateCourseCapacityBody")

registerCommand({
    method: "post",
    path: "/change-course-capacity",
    summary: "Change a course's capacity",
    body: UpdateCourseCapacitySchema,
    success: "noContent",
    errors: { 404: "Course not found", 422: "New capacity is the same as the current one" }
})
