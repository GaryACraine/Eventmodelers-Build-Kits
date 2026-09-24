import { useState } from "react"
import { Button } from "@/components/ui/button"
import { ApiError, api, command } from "@/lib/api"
import { useSession } from "@/lib/session"
import { useWrites } from "@/lib/writes"

/**
 * Subscribe Student: the Subscribe button of the "Course Page" screen (mockup: a form with a hidden
 * `data-field="courseId"` and `data-command="subscribeStudentToCourse"`). Nothing is typed: `courseId` is the page's
 * (its route) and `studentId` the signed-in student's (mapped `session:studentId`). Sends
 * `POST /subscribe-student-to-course` (slice.json `apiEndpoint`); a rejection shows the backend's message.
 */
export function SubscribeStudentForm({ courseId }: { courseId: string }) {
    const { studentId } = useSession()
    const { recordWrite } = useWrites()
    const [state, setState] = useState<{ sending?: boolean; done?: boolean; error?: string }>({})

    const submit = async (event: React.FormEvent) => {
        event.preventDefault()
        setState({ sending: true })
        try {
            const { position } = await command(api.POST("/subscribe-student-to-course", { body: { courseId, studentId } }))
            await recordWrite(position)
            setState({ done: true })
        } catch (error) {
            setState({ error: error instanceof ApiError ? error.message : "Something went wrong. Try again." })
        }
    }

    return (
        <form className="mock-card" onSubmit={submit}>
            {state.error && (
                <p role="alert" className="text-sm text-destructive">
                    {state.error}
                </p>
            )}
            {state.done && <p role="status">You're subscribed.</p>}
            <Button type="submit" disabled={state.sending}>
                Subscribe
            </Button>
        </form>
    )
}
