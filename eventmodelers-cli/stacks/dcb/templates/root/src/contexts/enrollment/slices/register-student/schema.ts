import { z } from "zod"
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi"
import { registerCommand } from "../../../../shared/openapi.js"

extendZodWithOpenApi(z)

export const RegisterStudentSchema = z
    .object({
        id: z.string().min(1).openapi({ example: "student-1", description: "Unique student identifier" }),
        name: z.string().min(1).openapi({ example: "Alice", description: "Student full name" })
    })
    .openapi("RegisterStudentBody")

registerCommand({
    method: "post",
    path: "/students",
    summary: "Register a student",
    body: RegisterStudentSchema,
    success: "createdId",
    errors: { 422: "Student already exists" }
})
