import { useCallback, useRef, useState } from "react"
import { ApiError } from "./api"

/**
 * Sends a command once per press, however fast the button is pressed again (ADR-067). Every command card submits
 * through it and disables its button while `pending`:
 *
 *   const { run, pending } = useSubmitOnce()
 *   const submit = handleSubmit(body => run(key => command(api.POST("/register-course", { body, headers: idempotent(key) }))))
 *   <Button type="submit" disabled={pending}>
 *
 * - **Once at a time:** a second `run` while one is sending returns `undefined` at once. `pending` is state, so the
 *   button disables only at the next render; the guard is a ref, so a second press before then is ignored too.
 * - **One intent, one key:** each press of the same form sends the same `Idempotency-Key` until the server answers.
 *   If the network failed, a second press is the same intent again, and the server answers it as a replay. Once the
 *   server has answered (done, or refused), the next press is a new intent with a new key.
 */
export function useSubmitOnce() {
    const sending = useRef(false)
    const key = useRef(crypto.randomUUID())
    const [pending, setPending] = useState(false)

    const run = useCallback(async <T>(send: (idempotencyKey: string) => Promise<T>): Promise<T | undefined> => {
        if (sending.current) return undefined
        sending.current = true
        setPending(true)
        try {
            const result = await send(key.current)
            key.current = crypto.randomUUID()
            return result
        } catch (error) {
            if (error instanceof ApiError) key.current = crypto.randomUUID()
            throw error
        } finally {
            sending.current = false
            setPending(false)
        }
    }, [])

    return { run, pending }
}

/** The headers that send a command under `useSubmitOnce`'s key */
export const idempotent = (key: string): { "Idempotency-Key": string } => ({ "Idempotency-Key": key })
