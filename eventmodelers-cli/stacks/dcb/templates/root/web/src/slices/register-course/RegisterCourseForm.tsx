import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ApiError, api, command } from "@/lib/api"
import type { components } from "@/lib/api-types"
import { useWrites } from "@/lib/writes"

type RegisterCourse = components["schemas"]["RegisterCourseBody"]

/** registerCourse's fields (slice.json), checked against the body the backend documents. */
const RegisterCourseSchema = z.object({
    id: z.string().trim().min(1, "Required"),
    title: z.string().trim().min(1, "Required"),
    capacity: z.number({ error: "Required" }).int().min(1, "At least 1")
}) satisfies z.ZodType<RegisterCourse>

/**
 * Register Course: the form of the "Course Form" screen (mockup: `form.mock-card`, `data-command="registerCourse"`).
 * Sends `POST /register-course` (slice.json `apiEndpoint`); a rejection shows the backend's message.
 */
export function RegisterCourseForm({ onRegistered }: { onRegistered?: (course: RegisterCourse) => void }) {
    const { recordWrite } = useWrites()
    const {
        register,
        handleSubmit,
        reset,
        setError,
        formState: { errors, isSubmitting }
    } = useForm({ resolver: zodResolver(RegisterCourseSchema) })

    const submit = handleSubmit(async (body) => {
        try {
            const { position } = await command(api.POST("/register-course", { body }))
            await recordWrite(position)
            reset()
            onRegistered?.(body)
        } catch (error) {
            setError("root", { message: error instanceof ApiError ? error.message : "Something went wrong. Try again." })
        }
    })

    return (
        <form className="mock-card" onSubmit={submit} noValidate>
            <Label htmlFor="registerCourse-id">Course ID</Label>
            <Input id="registerCourse-id" aria-invalid={!!errors.id} {...register("id")} />
            {errors.id && <p className="text-sm text-destructive">{errors.id.message}</p>}
            <Label htmlFor="registerCourse-title">Title</Label>
            <Input id="registerCourse-title" aria-invalid={!!errors.title} {...register("title")} />
            {errors.title && <p className="text-sm text-destructive">{errors.title.message}</p>}
            <Label htmlFor="registerCourse-capacity">Capacity</Label>
            <Input
                id="registerCourse-capacity"
                type="number"
                aria-invalid={!!errors.capacity}
                {...register("capacity", { valueAsNumber: true })}
            />
            {errors.capacity && <p className="text-sm text-destructive">{errors.capacity.message}</p>}
            {errors.root && (
                <p role="alert" className="text-sm text-destructive">
                    {errors.root.message}
                </p>
            )}
            <Button type="submit" disabled={isSubmitting}>
                Register course
            </Button>
        </form>
    )
}
