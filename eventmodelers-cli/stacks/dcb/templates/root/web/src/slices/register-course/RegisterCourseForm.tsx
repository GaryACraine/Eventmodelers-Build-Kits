import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Field, FormCard } from "@/components/patterns"
import { api, command, errorText } from "@/lib/api"
import type { components } from "@/lib/api-types"
import type { FormPart } from "@/lib/parts"
import { idempotent, useSubmitOnce } from "@/lib/submit"
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
 * Sends `POST /register-course` (slice.json `apiEndpoint`) once per press (`useSubmitOnce`); a rejection shows the
 * backend's message.
 */
export function RegisterCourseForm({ onDone }: FormPart<RegisterCourse>) {
    const { recordWrite } = useWrites()
    const {
        register,
        handleSubmit,
        reset,
        setError,
        formState: { errors }
    } = useForm({ resolver: zodResolver(RegisterCourseSchema) })
    const { run, pending } = useSubmitOnce()

    const submit = handleSubmit((body) =>
        run(async (key) => {
            const { position } = await command(api.POST("/register-course", { body, headers: idempotent(key) }))
            await recordWrite(position)
            reset()
            onDone?.(body)
        }).catch((error) => setError("root", { message: errorText(error) }))
    )

    return (
        <FormCard label="Register course" submit="Register course" onSubmit={submit} pending={pending} error={errors.root?.message}>
            <Field id="registerCourse-id" label="Course ID" error={errors.id?.message} {...register("id")} />
            <Field id="registerCourse-title" label="Title" error={errors.title?.message} {...register("title")} />
            <Field
                id="registerCourse-capacity"
                label="Capacity"
                type="number"
                error={errors.capacity?.message}
                {...register("capacity", { valueAsNumber: true })}
            />
        </FormCard>
    )
}
