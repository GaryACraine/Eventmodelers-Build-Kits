import { useEffect, useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Confirm } from "./Confirm"
import { useRowName } from "./DataTable"

/**
 * A command's button in a row of a `DataTable` (ADR-072): a row-action form's whole UI.
 * - **Its name includes the row** ("Remove alex@example.com"), so a screen reader doesn't hear "Remove" on every row
 *   (GOV.UK's visually hidden link text): the button is labelled by itself and the row's naming cell.
 * - **Confirm:** a command the model marks `confirm` asks first, in the row, naming the row (`Confirm`).
 * - **Its error** shows under it, as an alert.
 *
 *   <RowAction action="Remove" onAct={remove} pending={pending} error={error}
 *              confirm={{ consequence: CONFIRM, confirm: "Remove member" }} />
 */
export function RowAction({
    action,
    onAct,
    pending,
    error,
    confirm,
    variant = "secondary"
}: {
    /** The button's words, from the mockup */
    action: string
    onAct: () => unknown
    pending: boolean
    error?: string
    /** The model's `confirm`: the consequence, and the confirming button's words (the command's name) */
    confirm?: { consequence: string; confirm: string }
    variant?: "default" | "secondary" | "outline" | "destructive"
}) {
    const own = useId()
    const row = useRowName()
    const [asking, setAsking] = useState(false)
    const button = useRef<HTMLButtonElement>(null)
    const wasAsking = useRef(false)
    useEffect(() => {
        if (wasAsking.current && !asking) button.current?.focus()
        wasAsking.current = asking
    }, [asking])

    const rowName = () => (row ? document.getElementById(row)?.textContent?.trim() : undefined)

    return (
        <div className="grid gap-1">
            {asking && confirm ? (
                <Confirm
                    question={`${action}${rowName() ? ` ${rowName()}` : ""}?`}
                    consequence={confirm.consequence}
                    confirm={confirm.confirm}
                    pending={pending}
                    onConfirm={async () => {
                        await onAct()
                        setAsking(false)
                    }}
                    onCancel={() => setAsking(false)}
                />
            ) : (
                <Button
                    ref={button}
                    id={own}
                    type="button"
                    variant={variant}
                    size="sm"
                    className="mt-0 w-auto"
                    disabled={pending}
                    aria-labelledby={row ? `${own} ${row}` : undefined}
                    onClick={() => (confirm ? setAsking(true) : onAct())}
                >
                    {action}
                </Button>
            )}
            {error && <p role="alert">{error}</p>}
        </div>
    )
}
