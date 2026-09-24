import { createContext, useCallback, useContext, useMemo, useState, type FormEvent, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * The signed-in user, as the IDs the model maps to `session:` (slice.json `page.params` with `from: "session"`),
 * e.g. `{ studentId: "s1" }`. A page reads them with `useSession()`: never from its URL, never from a form input.
 *
 * A stub until real sign-in exists: the person types their IDs once (`RequireSession` asks), and this browser
 * remembers them. Real sign-in will replace the stub here without the pages changing.
 */
export type Session = Record<string, string>

interface SessionState {
    session: Session
    signIn: (values: Session) => void
    signOut: () => void
}

const SessionContext = createContext<SessionState | undefined>(undefined)
const STORAGE_KEY = "session"

function load(): Session {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")
        return value && typeof value === "object" ? (value as Session) : {}
    } catch {
        return {}
    }
}

function save(session: Session): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
    } catch {
        // storage unavailable (a private window): the session lasts until the page reloads
    }
}

/** `initial` starts signed in (tests); `remember: false` keeps it out of localStorage. */
export function SessionProvider({ initial, remember = true, children }: { initial?: Session; remember?: boolean; children: ReactNode }) {
    const [session, setSession] = useState<Session>(() => initial ?? (remember ? load() : {}))
    const signIn = useCallback(
        (values: Session) =>
            setSession((previous) => {
                const next = { ...previous, ...values }
                if (remember) save(next)
                return next
            }),
        [remember]
    )
    const signOut = useCallback(() => {
        setSession({})
        if (remember) save({})
    }, [remember])
    const state = useMemo(() => ({ session, signIn, signOut }), [session, signIn, signOut])
    return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>
}

/** The session and how to change it (the header's sign-out). */
export function useSessionState(): SessionState {
    const state = useContext(SessionContext)
    if (!state) throw new Error("useSessionState needs a SessionProvider (App provides it)")
    return state
}

/** The signed-in user's IDs. Use it under `RequireSession` (a page with `session` in its `page`), which guarantees them. */
export function useSession(): Session {
    return useSessionState().session
}

/** "studentId" → "Student ID" */
function labelOf(key: string): string {
    const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_-]+/)
    return words.map((w, i) => (/^id$/i.test(w) ? "ID" : i === 0 ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase())).join(" ")
}

/** Shows its children once the session has every key in `keys`; until then, asks for the missing ones. */
export function RequireSession({ keys, children }: { keys: string[]; children: ReactNode }) {
    const { session, signIn } = useSessionState()
    const missing = keys.filter((key) => !session[key])
    const [values, setValues] = useState<Session>({})
    if (missing.length === 0) return <>{children}</>

    const submit = (event: FormEvent) => {
        event.preventDefault()
        const entered = Object.fromEntries(missing.map((key) => [key, (values[key] ?? "").trim()]))
        if (Object.values(entered).every(Boolean)) signIn(entered)
    }
    return (
        <form className="mock-card" onSubmit={submit} aria-label="Sign in">
            <h2>Who are you?</h2>
            <p className="text-sm text-muted-foreground">Sign-in isn't built yet: enter your ID to continue.</p>
            {missing.map((key) => (
                <div key={key}>
                    <Label htmlFor={`session-${key}`}>{labelOf(key)}</Label>
                    <Input
                        id={`session-${key}`}
                        required
                        value={values[key] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                    />
                </div>
            ))}
            <Button type="submit">Continue</Button>
        </form>
    )
}
