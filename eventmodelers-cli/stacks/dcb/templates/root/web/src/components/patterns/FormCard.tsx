import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Confirm } from "./Confirm"

/**
 * A form's card (ADR-072): the mockup's `form.mock-card`, its heading, its fields, one submit button, and what
 * happened.
 * - **The error** goes at the top, under the heading, and takes focus, so it's read first (GOV.UK's error summary;
 *   WCAG 3.3.1). Pass `errorText(e)`'s words, never an exception's.
 * - **Sending:** the button is disabled while `pending` (`useSubmitOnce`, ADR-067) and says "Sending…" beside it, a
 *   status message (WCAG 4.1.3).
 * - **Done:** the success line, a status message, for a page that stays; a page with `next` goes on instead.
 * - **After:** what the mockup draws under the button (another system's frame) goes in `after`.
 * - **Confirm:** a command the model marks `confirm` asks first, in the card (`Confirm`); `onSubmit` runs once it's
 *   confirmed.
 *
 *   <FormCard title="Invite a member" submit="Send invitation" onSubmit={handleSubmit(send)} pending={pending}
 *             error={errors.root?.message} done={done && "Invitation sent."}>
 *       <Field id="inviteMember-email" label="Email" type="email" error={errors.email?.message} {...register("email")} />
 *   </FormCard>
 */
export function FormCard({
    title,
    label,
    submit,
    onSubmit,
    pending,
    error,
    done,
    confirm,
    card = true,
    after,
    children
}: {
    /** The mockup's heading (its `h2`) */
    title?: ReactNode
    /** The form's name when it has no heading (`aria-label`); with one, the heading names it */
    label?: string
    /** The button's words, from the mockup */
    submit: string
    /** The form's submit: RHF's `handleSubmit(…)`, or a handler for a form with nothing typed */
    onSubmit: (event: FormEvent<HTMLFormElement>) => unknown
    pending: boolean
    error?: string
    done?: ReactNode
    /** The model's `confirm` for this command: the question, and the consequence a person accepts */
    confirm?: { question: string; consequence: string; confirm: string }
    /** A form inside another card (a part of a view's card): no card of its own */
    card?: boolean
    /** What the mockup draws under the button: another system's part of the page (Paddle's checkout frame, ADR-044) */
    after?: ReactNode
    children?: ReactNode
}) {
    const heading = useId()
    const alert = useRef<HTMLParagraphElement>(null)
    const [asking, setAsking] = useState(false)
    const form = useRef<HTMLFormElement>(null)
    const confirmed = useRef(false)
    useEffect(() => {
        if (error) alert.current?.focus()
    }, [error])

    const submitted = (event: FormEvent<HTMLFormElement>) => {
        if (confirm && !confirmed.current) {
            event.preventDefault()
            setAsking(true)
            return
        }
        confirmed.current = false
        setAsking(false)
        return onSubmit(event)
    }

    return (
        <form ref={form} className={card ? "mock-card" : undefined} aria-labelledby={title ? heading : undefined} aria-label={title ? undefined : label} onSubmit={submitted} noValidate>
            {title && <h2 id={heading}>{title}</h2>}
            {error && (
                <p role="alert" ref={alert} tabIndex={-1} className="text-destructive">
                    {error}
                </p>
            )}
            {children}
            {asking && confirm ? (
                <Confirm
                    {...confirm}
                    pending={pending}
                    onConfirm={() => {
                        confirmed.current = true
                        form.current?.requestSubmit()
                    }}
                    onCancel={() => setAsking(false)}
                />
            ) : (
                <Button type="submit" disabled={pending}>
                    {submit}
                </Button>
            )}
            {after}
            {pending && (
                <p role="status" className="text-sm text-muted-foreground">
                    Sending…
                </p>
            )}
            {!pending && done && <p role="status">{done}</p>}
        </form>
    )
}
