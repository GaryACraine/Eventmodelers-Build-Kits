import { createContext, useCallback, useContext, useMemo, useState, type FormEvent, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { forgetBearerToken, signInMode, signInService, type SignInMode } from "./auth-client"
import { SignInForm, useHere } from "./sign-in"

/**
 * The signed-in user, as the IDs the model maps to `session:` (slice.json `page.params` with `from: "session"`),
 * e.g. `{ sub: "…", email: "…" }`. A page reads them with `useSession()`: never from its URL, never from a form input.
 *
 * Two modes (auth-client.ts):
 *   - **better-auth** (`VITE_SIGN_IN=better-auth`, live data): the sign-in service's session gives `sub` (its user
 *     id) and `email` (ADR-055). `RequireSession` shows the sign-in form until someone is signed in, then the page.
 *     The API takes every `session:` value from the token itself, and any other key (`userId`) through its session
 *     lookup (ADR-055 part 2), so nothing is asked for and nothing is sent;
 *   - **stub** (the default, mock mode, tests): the person types their IDs once, and this browser remembers them.
 *
 * Pages don't change between the two.
 */
export type Session = Record<string, string>

interface SessionState {
    session: Session
    mode: SignInMode
    /** better-auth: someone is signed in. The stub: always true (it only asks for IDs) */
    signedIn: boolean
    /** better-auth: still finding out who is signed in */
    pending: boolean
    /** Remember IDs typed in (the stub's form) */
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

/** IDs typed into the stub's form, remembered in this browser unless `remember` is false */
function useTypedIds(initial: Session | undefined, remember: boolean) {
    const [typed, setTyped] = useState<Session>(() => initial ?? (remember ? load() : {}))
    const signIn = useCallback(
        (values: Session) =>
            setTyped((previous) => {
                const next = { ...previous, ...values }
                if (remember) save(next)
                return next
            }),
        [remember]
    )
    const forget = useCallback(() => {
        setTyped({})
        if (remember) save({})
    }, [remember])
    return { typed, signIn, forget }
}

function StubSession({ initial, remember, children }: { initial?: Session; remember: boolean; children: ReactNode }) {
    const { typed, signIn, forget } = useTypedIds(initial, remember)
    const state = useMemo<SessionState>(
        () => ({ session: typed, mode: "stub", signedIn: true, pending: false, signIn, signOut: forget }),
        [typed, signIn, forget]
    )
    return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>
}

function BetterAuthSession({ remember, children }: { remember: boolean; children: ReactNode }) {
    const { data, isPending } = signInService.useSession()
    const { typed, signIn, forget } = useTypedIds(undefined, remember)
    const user = data?.user
    const signOut = useCallback(() => {
        forget()
        forgetBearerToken()
        void signInService.signOut()
    }, [forget])
    const state = useMemo<SessionState>(
        () => ({
            session: user ? { ...typed, sub: user.id, email: user.email } : {},
            mode: "better-auth",
            signedIn: Boolean(user),
            pending: isPending,
            signIn,
            signOut
        }),
        [user, typed, isPending, signIn, signOut]
    )
    return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>
}

/**
 * `initial` starts signed in (tests; always the stub); `remember: false` keeps typed IDs out of localStorage;
 * `mode` defaults to `VITE_SIGN_IN` (auth-client.ts).
 */
export function SessionProvider({
    initial,
    remember = true,
    mode = initial ? "stub" : signInMode,
    children
}: {
    initial?: Session
    remember?: boolean
    mode?: SignInMode
    children: ReactNode
}) {
    return mode === "better-auth" ? (
        <BetterAuthSession remember={remember}>{children}</BetterAuthSession>
    ) : (
        <StubSession initial={initial} remember={remember}>
            {children}
        </StubSession>
    )
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

/**
 * Shows its children once someone is signed in. With better-auth, the sign-in form until then; with the stub, a form
 * asking for the keys in `keys` still missing.
 */
export function RequireSession({ keys, children }: { keys: string[]; children: ReactNode }) {
    const { session, signIn, mode, signedIn, pending } = useSessionState()
    const missing = keys.filter((key) => !session[key])
    const [values, setValues] = useState<Session>({})
    if (pending) return <p role="status">Checking who is signed in…</p>
    if (!signedIn) return <SignInHere />
    // Real sign-in: the API has the rest from the token and its session lookup (ADR-055 part 2)
    if (missing.length === 0 || mode === "better-auth") return <>{children}</>

    const submit = (event: FormEvent) => {
        event.preventDefault()
        const entered = Object.fromEntries(missing.map((key) => [key, (values[key] ?? "").trim()]))
        if (Object.values(entered).every(Boolean)) signIn(entered)
    }
    return (
        <form className="mock-card" onSubmit={submit} aria-label="Sign in">
            <h2>Who are you?</h2>
            <p className="text-sm text-muted-foreground">Sign-in isn't switched on: enter your ID to continue.</p>
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

/** The sign-in form in place of a protected page, returning to it once signed in (in the router: real sign-in only) */
function SignInHere() {
    return <SignInForm next={useHere()} />
}
