import { useState } from "react"
import { FormCard } from "@/components/patterns"
import { api, command, errorText } from "@/lib/api"
import type { FormPart } from "@/lib/parts"
import { useSession } from "@/lib/session"
import { idempotent, useSubmitOnce } from "@/lib/submit"
import { useWrites } from "@/lib/writes"

/**
 * Subscribe Student: the Subscribe button of the "Course Page" screen (mockup: a form with a hidden
 * `data-field="courseId"` and `data-command="subscribeStudentToCourse"`). Nothing is typed: `courseId` is the page's
 * (its route) and `studentId` the signed-in student's (mapped `session:studentId`). Sends
 * `POST /subscribe-student-to-course` (slice.json `apiEndpoint`) once per press (`useSubmitOnce`); a rejection shows
 * the backend's message. `onDone` (the page's) follows a subscription.
 */
export function SubscribeStudentForm({ courseId, onDone }: { courseId: string } & FormPart<{ courseId: string; studentId?: string }>) {
    const { studentId } = useSession()
    const { recordWrite } = useWrites()
    const [state, setState] = useState<{ done?: boolean; error?: string }>({})
    const { run, pending } = useSubmitOnce()

    const submit = (event: React.FormEvent) => {
        event.preventDefault()
        run(async (key) => {
            setState({})
            const body = { courseId, studentId }
            const { position } = await command(api.POST("/subscribe-student-to-course", { body, headers: idempotent(key) }))
            await recordWrite(position)
            setState({ done: true })
            onDone?.(body)
        }).catch((error) => setState({ error: errorText(error) }))
    }

    return (
        <FormCard label="Subscribe" submit="Subscribe" onSubmit={submit} pending={pending} error={state.error} done={state.done && "You're subscribed."} />
    )
}
