import type { ComponentProps, ReactNode } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const describedBy = (...ids: (string | false | undefined)[]) => ids.filter(Boolean).join(" ") || undefined

/** A field's error, under its input and named by it (GOV.UK's error message; WCAG 3.3.1) */
function FieldError({ id, error }: { id: string; error?: string }) {
    return error ? (
        <p id={id} className="text-sm text-destructive">
            {error}
        </p>
    ) : null
}

type Control =
    | ({ control?: "input" } & ComponentProps<"input">)
    | ({ control: "select"; children: ReactNode } & ComponentProps<"select">)
    | ({ control: "textarea" } & ComponentProps<"textarea">)

/**
 * One typed value (ADR-072): its label, an optional hint, the input, and its error under it. The input names its hint
 * and error (`aria-describedby`) and says when it's wrong (`aria-invalid`), so a screen reader reads them with it.
 * RHF's `register(…)` is spread onto it. A mockup `<select>` or `<textarea>` is `control="select"` / `"textarea"`.
 *
 *   <Field id="registerCourse-title" label="Title" error={errors.title?.message} {...register("title")} />
 */
export function Field({ id, label, hint, error, ...control }: { id: string; label: ReactNode; hint?: ReactNode; error?: string } & Control) {
    const hintId = hint ? `${id}-hint` : undefined
    const errorId = error ? `${id}-error` : undefined
    const aria = { id, "aria-describedby": describedBy(hintId, errorId), "aria-invalid": error ? true : undefined }
    return (
        <div className="grid gap-1">
            <Label htmlFor={id}>{label}</Label>
            {hint && (
                <p id={hintId} className="text-sm text-muted-foreground">
                    {hint}
                </p>
            )}
            {control.control === "select" ? (
                <select {...withoutControl(control)} {...aria} />
            ) : control.control === "textarea" ? (
                <textarea {...withoutControl(control)} {...aria} />
            ) : (
                <Input {...withoutControl(control)} {...aria} />
            )}
            <FieldError id={`${id}-error`} error={error} />
        </div>
    )
}

function withoutControl<T extends { control?: string }>(props: T): Omit<T, "control"> {
    const { control: _control, ...rest } = props
    return rest
}

/**
 * A choice among labelled options (ADR-072): a `fieldset` whose `legend` is the question, a checkbox (several) or
 * radio (one) per option, and the error under them, named by the group (GOV.UK's checkboxes and radios). RHF's
 * `register(…)` is spread onto it, and given to every option.
 *
 *   <ChoiceGroup id="inviteMember-roleIds" legend="Roles" type="checkbox" error={errors.roleIds?.message}
 *                options={[{ value: "admin", label: "Admin" }, { value: "engineer", label: "Engineer" }]}
 *                {...register("roleIds")} />
 */
export function ChoiceGroup({
    id,
    legend,
    hint,
    error,
    type,
    options,
    ...input
}: {
    id: string
    legend: ReactNode
    hint?: ReactNode
    error?: string
    type: "checkbox" | "radio"
    options: { value: string; label: ReactNode }[]
} & Omit<ComponentProps<"input">, "id" | "type">) {
    const hintId = hint ? `${id}-hint` : undefined
    const errorId = error ? `${id}-error` : undefined
    return (
        <fieldset id={id} aria-describedby={describedBy(hintId, errorId)} aria-invalid={error ? true : undefined}>
            <legend>{legend}</legend>
            {hint && (
                <p id={hintId} className="text-sm text-muted-foreground">
                    {hint}
                </p>
            )}
            {options.map((option) => (
                <label key={option.value} className="mock-check">
                    <input type={type} value={option.value} {...input} /> {option.label}
                </label>
            ))}
            <FieldError id={`${id}-error`} error={error} />
        </fieldset>
    )
}
