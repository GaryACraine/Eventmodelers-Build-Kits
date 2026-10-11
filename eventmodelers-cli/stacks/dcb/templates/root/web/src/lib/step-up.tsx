import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react"
import { renderSVG } from "uqr"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { onStepUp, type StepUpLevel } from "./api"
import { forgetBearerToken, messageOf, signInMode, signInService, type ServiceError } from "./auth-client"
import { useSessionState } from "./session"

/**
 * Signing in more strongly (ADR-056 D1, D3, D15): an action whose role needs the app or a passkey, from a session that
 * proved only the inbox (or proved more over 12 hours ago), is refused by the API with a step-up. The API client
 * (`api.ts`) shows this prompt and sends the request again once the person has proved one. Someone with neither is
 * helped to set one up first (D3: an owner without one is asked at their first owner action). The account page asks
 * through the same prompt when changing a factor needs it (`useStepUp`).
 *
 * The prompt's headings and buttons match emcli's `step-up` and `set-up-app` starters.
 */

interface StepUp {
    /** Ask for a stronger sign-in; true once the person has given it */
    ask: (level: StepUpLevel) => Promise<boolean>
}

const StepUpContext = createContext<StepUp | undefined>(undefined)

/** The prompt, for the API client and the account page. With the stub session there's nothing to step up to. */
export function StepUpProvider({ children }: { children: ReactNode }) {
    const [asking, setAsking] = useState<{ level: StepUpLevel; resolve: (done: boolean) => void }>()
    const queue = useRef<Promise<boolean>>(Promise.resolve(true))

    const ask = useCallback((level: StepUpLevel) => {
        // One prompt at a time: requests refused together wait on the same answer
        const answer = queue.current.then(() => new Promise<boolean>((resolve) => setAsking({ level, resolve })))
        queue.current = answer.catch(() => false)
        return answer
    }, [])
    useEffect(() => (signInMode === "better-auth" ? onStepUp(ask) : undefined), [ask])

    const finish = (done: boolean) => {
        if (done) forgetBearerToken()
        asking?.resolve(done)
        setAsking(undefined)
    }
    const value = useMemo(() => ({ ask }), [ask])
    return (
        <StepUpContext.Provider value={value}>
            {children}
            {asking && <StepUpPrompt level={asking.level} onDone={finish} />}
        </StepUpContext.Provider>
    )
}

export function useStepUp(): StepUp {
    const value = useContext(StepUpContext)
    if (!value) throw new Error("useStepUp needs a StepUpProvider (App provides it)")
    return value
}

type Factors = { app: boolean; passkeys: number }

/** The prompt itself, over the page */
export function StepUpPrompt({ level, onDone }: { level: StepUpLevel; onDone: (done: boolean) => void }) {
    const { signOut } = useSessionState()
    const [factors, setFactors] = useState<Factors>()
    const [error, setError] = useState<string>()
    const [code, setCode] = useState("")
    const [busy, setBusy] = useState(false)
    const [settingUp, setSettingUp] = useState(false)

    const load = useCallback(async () => {
        const { data, error } = await signInService.factors()
        if (error) setError(messageOf(error as ServiceError, "Couldn't check how you can confirm it's you."))
        else setFactors(data ?? { app: false, passkeys: 0 })
    }, [])
    useEffect(() => {
        if (level === "not-by-email") void load()
    }, [level, load])

    const withApp = async (event: FormEvent) => {
        event.preventDefault()
        setBusy(true)
        setError(undefined)
        const { error } = await signInService.verifyAppCode(code.trim())
        setBusy(false)
        if (error) setError(messageOf(error as ServiceError, "That code isn't right. Try again."))
        else onDone(true)
    }
    const withPasskey = async () => {
        setError(undefined)
        const { error } = await signInService.signInWithPasskey()
        if (error) setError(messageOf(error as ServiceError, "That passkey didn't confirm it's you. Try again."))
        else onDone(true)
    }
    const addPasskey = async () => {
        setError(undefined)
        const { error } = await signInService.addPasskey()
        if (error) setError(messageOf(error as ServiceError, "Couldn't add the passkey. Try again."))
        else await load()
    }

    let body: ReactNode
    if (level === "second-factor") {
        // Every session has a second factor (D2), so this is an old session: signing in again gives it one
        body = (
            <>
                <p>Sign in again to carry on.</p>
                <Button
                    type="button"
                    onClick={() => {
                        onDone(false)
                        signOut()
                    }}
                >
                    Sign in again
                </Button>
            </>
        )
    } else if (!factors) {
        body = <p role="status">Checking how you can confirm it's you…</p>
    } else if (settingUp) {
        body = (
            <AppSetup
                onDone={async () => {
                    setSettingUp(false)
                    await load()
                }}
            />
        )
    } else if (!factors.app && factors.passkeys === 0) {
        body = (
            <>
                <p>
                    This needs your authenticator app or a passkey, which someone who got into your email couldn't use. Add one to carry
                    on.
                </p>
                <Button type="button" onClick={() => setSettingUp(true)}>
                    Set up the authenticator app
                </Button>
                <Button type="button" className="mock-secondary" variant="secondary" onClick={addPasskey}>
                    Add a passkey
                </Button>
            </>
        )
    } else {
        body = (
            <>
                <p>This needs a code from your authenticator app, or your passkey.</p>
                {factors.app && (
                    <form onSubmit={withApp} aria-label="Confirm with your app">
                        <Label htmlFor="step-up-code">Code from your app</Label>
                        <Input
                            id="step-up-code"
                            autoComplete="one-time-code"
                            inputMode="numeric"
                            required
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                        />
                        <Button type="submit" disabled={busy}>
                            Confirm
                        </Button>
                    </form>
                )}
                {factors.passkeys > 0 && (
                    <Button type="button" className={factors.app ? "mock-secondary" : undefined} variant={factors.app ? "secondary" : "default"} onClick={withPasskey}>
                        Use your passkey
                    </Button>
                )}
            </>
        )
    }
    return (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24" role="presentation">
            <section className="mock-card w-full" role="dialog" aria-modal="true" aria-labelledby="step-up-heading">
                <h2 id="step-up-heading">Confirm it's you</h2>
                {body}
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
                <p className="text-sm text-muted-foreground">
                    <button type="button" className="mock-link" onClick={() => onDone(false)}>
                        Not now
                    </button>
                </p>
            </section>
        </div>
    )
}

/** The key inside an `otpauth://` URI, for typing into the app by hand */
function secretOf(totpURI: string): string {
    try {
        return new URL(totpURI).searchParams.get("secret") ?? ""
    } catch {
        return ""
    }
}

/**
 * Setting up the authenticator app (D8): the password, then the QR code (or its key, typed in), then the app's first
 * code, which finishes it; then the backup codes, shown once. Setting it up doesn't confirm it's you yet: its next
 * code does (the sign-in service's rule), which is what the step-up prompt asks for after this.
 */
export function AppSetup({ onDone }: { onDone: () => void }) {
    const [password, setPassword] = useState("")
    const [started, setStarted] = useState<{ totpURI: string; backupCodes: string[] }>()
    const [code, setCode] = useState("")
    const [finished, setFinished] = useState(false)
    const [error, setError] = useState<string>()
    const [busy, setBusy] = useState(false)

    const start = async (event: FormEvent) => {
        event.preventDefault()
        setBusy(true)
        setError(undefined)
        const { data, error } = await signInService.setUpApp(password)
        setBusy(false)
        if (error) setError(messageOf(error as ServiceError, "Couldn't start setting up the app. Check your password."))
        else setStarted(data as { totpURI: string; backupCodes: string[] })
    }
    const confirm = async (event: FormEvent) => {
        event.preventDefault()
        setBusy(true)
        setError(undefined)
        const { error } = await signInService.verifyAppCode(code.trim())
        setBusy(false)
        if (error) setError(messageOf(error as ServiceError, "That code isn't right. Try the next one the app shows."))
        else setFinished(true)
    }

    const problem = error && (
        <p role="alert" className="text-sm text-destructive">
            {error}
        </p>
    )
    if (finished && started) {
        return (
            <section aria-label="Your backup codes">
                <h3 className="font-semibold">Your backup codes</h3>
                <p>If you lose your phone, each of these signs you in once. Keep them somewhere safe: they won't be shown again.</p>
                <pre className="mock-codes">{started.backupCodes.join("\n")}</pre>
                <Button type="button" onClick={onDone}>
                    I've saved them
                </Button>
            </section>
        )
    }
    if (started) {
        const qr = `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(started.totpURI))}`
        return (
            <form onSubmit={confirm} aria-label="Set up the authenticator app">
                <h3 className="font-semibold">Scan this with your authenticator app</h3>
                <img src={qr} alt="QR code for your authenticator app" width={180} height={180} />
                <p className="text-sm text-muted-foreground">
                    Can't scan it? Enter this key: <code>{secretOf(started.totpURI)}</code>
                </p>
                <Label htmlFor="app-setup-code">The code the app shows</Label>
                <Input id="app-setup-code" autoComplete="one-time-code" inputMode="numeric" required value={code} onChange={(e) => setCode(e.target.value)} />
                {problem}
                <Button type="submit" disabled={busy}>
                    Finish setting up
                </Button>
            </form>
        )
    }
    return (
        <form onSubmit={start} aria-label="Set up the authenticator app">
            <h3 className="font-semibold">Set up the authenticator app</h3>
            <p>An app such as Google Authenticator, Microsoft Authenticator or 1Password shows a new code every 30 seconds.</p>
            <Label htmlFor="app-setup-password">Your password</Label>
            <Input
                id="app-setup-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
            />
            {problem}
            <Button type="submit" disabled={busy}>
                Continue
            </Button>
        </form>
    )
}
