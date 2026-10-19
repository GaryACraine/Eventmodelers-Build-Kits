import { useEffect, useId, useRef, type ReactNode } from "react"
import { Button } from "@/components/ui/button"

/**
 * Asking before a command that can't be undone (ADR-072, NN/g's confirmation dialogs). The model marks the command
 * (`confirm`: the consequence a person accepts); nothing else is asked. Shown in place, where the person pressed:
 * the question names what is about to happen and to what, focus moves to it, and the buttons say the outcome (the
 * command's name, and "Cancel"). Neither is pressed by Enter alone: the question, not a button, has focus.
 * A command that costs money shows what it will cost before it's confirmed (`preview`, ADR-077: Paddle's figures for
 * the seats typed), and its button isn't drawn as destructive (`variant="default"`).
 */
export function Confirm({
    question,
    consequence,
    confirm,
    preview,
    variant = "destructive",
    pending,
    onConfirm,
    onCancel
}: {
    /** What is about to happen, to what: "Remove alex@example.com?" */
    question: string
    /** The model's `confirm`: what follows, which the person accepts */
    consequence: string
    /** The confirming button: the command's name ("Remove member") */
    confirm: string
    /** What it will cost, read with the values typed: the slice's own view (the form part's `preview`) */
    preview?: ReactNode
    /** "default" for a command that isn't a loss (buying seats) */
    variant?: "destructive" | "default"
    pending?: boolean
    onConfirm: () => void
    onCancel: () => void
}) {
    const id = useId()
    const asked = useRef<HTMLParagraphElement>(null)
    useEffect(() => asked.current?.focus(), [])
    return (
        <div role="group" aria-labelledby={id} className="grid gap-2">
            <p id={id} ref={asked} tabIndex={-1}>
                <strong>{question}</strong> {consequence}
            </p>
            {preview}
            <div className="flex gap-2">
                <Button type="button" variant={variant} className="mt-0 w-auto" disabled={pending} onClick={onConfirm}>
                    {confirm}
                </Button>
                <Button type="button" variant="outline" className="mt-0 w-auto" disabled={pending} onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </div>
    )
}
