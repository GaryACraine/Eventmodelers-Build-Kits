import { useState } from "react"
import { Button } from "@/components/ui/button"
import { ApiError, api, command } from "@/lib/api"
import { useSession } from "@/lib/session"
import { idempotent, useSubmitOnce } from "@/lib/submit"
import { useWrites } from "@/lib/writes"

/**
 * Subscribe Student: the Subscribe button of the "Course Page" screen (mockup: a form with a hidden
 * `data-field="courseId"` and `data-command="subscribeStudentToCourse"`). Nothing is typed: `courseId` is the page's
 * (its route) and `studentId` the signed-in student's (mapped `session:studentId`). Sends
 * `POST /subscribe-student-to-course` (slice.json `apiEndpoint`) once per press (`useSubmitOnce`); a rejection shows
 * the backend's message.
 */
export function SubscribeStudentForm({ courseId }: { courseId: string }) {
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
        }).catch((error) =>
            setState({ error: error instanceof ApiError ? error.message : "Something went wrong. Try again." })
        )
    }

    return (
        <form className="mock-card" onSubmit={submit}>
            {state.error && (
                <p role="alert" className="text-sm text-destructive">
                    {state.error}
                </p>
            )}
            {state.done && <p role="status">You're subscribed.</p>}
            <Button type="submit" disabled={pending}>
                Subscribe
            </Button>
        </form>
    )
}
