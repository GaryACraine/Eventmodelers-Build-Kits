import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import { Link, Navigate, useLocation, useSearchParams } from "react-router"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { EMAIL_CHANGED_PAGE, messageOf, signInService, type SecondFactorMethod, type ServiceError } from "./auth-client"
import { useSessionState } from "./session"
import { afterSignUp, type Navigation } from "./navigation"

/**
 * The small links beside a form ("Forgotten your password?", "Back to sign in"): each is a 24px target at least
 * (WCAG 2.2, 2.5.8), which a standalone link of small text isn't, next to the form's button.
 */
const SIDE_LINKS = "text-sm text-muted-foreground [&_a]:inline-block [&_a]:min-h-6 [&_a]:leading-6"

/**
 * The sign-in screens (ADR-055, ADR-056, ADR-057): the sign-in system's, provided by the kit, never built by the loop.
 * Their headings, labels, buttons and links match emcli's starters (`element mockup --starter sign-in | sign-up |
 * check-email | enter-code | forgot-password | reset-password | link-expired`), so the board shows what people get.
 * Each call is Better Auth's, through `signInService`.
 *
 * `next` is the page to return to: the protected page that asked for sign-in, carried through Sign Up, where it
 * becomes the verification link's `callbackURL` (verifying signs the person in and lands them there). A new person
 * goes by the registration page first (`afterSignUp`, ADR-068), which then goes on to `next`.
 *
 * Signing in takes the password and then a second factor (ADR-056 D2): the code we email, or the authenticator app's
 * code, a backup code or a passkey for someone who has those (they're never offered the emailed code, D4a). A passkey
 * signs in on its own.
 */

/** Where to go after signing in or verifying: a path on this site (never another origin), "/" by default */
export function nextPath(next: string | null | undefined): string {
    return next && next.startsWith("/") && !next.startsWith("//") ? next : "/"
}

/** A refusal, read out to the person */
export function Problem({ children }: { children?: ReactNode }) {
    if (!children) return null
    return (
        <p role="alert" className="text-sm text-destructive">
            {children}
        </p>
    )
}

/** Signing in: the password, then a second factor. Better Auth refuses an unverified email with 403, and sends the link again. */
export function SignInForm({ next }: { next: string }) {
    const [email, setEmail] = useState("")
    const [password, setPassword] = useState("")
    const [error, setError] = useState<string>()
    const [busy, setBusy] = useState(false)
    const [methods, setMethods] = useState<SecondFactorMethod[]>()

    const submit = async (event: FormEvent) => {
        event.preventDefault()
        setBusy(true)
        setError(undefined)
        const { data, error } = await signInService.signInWithEmail(email, password)
        setBusy(false)
        if (error) {
            setError(
                error.status === 403
                    ? "Verify your email address first: we've sent you the link again."
                    : messageOf(error as ServiceError, "Couldn't sign in. Try again.")
            )
            return
        }
        const offer = data as { twoFactorRedirect?: boolean; twoFactorMethods?: SecondFactorMethod[] } | null
        if (offer?.twoFactorRedirect) setMethods(offer.twoFactorMethods ?? [])
    }

    if (methods) return <SecondFactorForm methods={methods} onStartAgain={() => setMethods(undefined)} />
    return (
        <form className="mock-card" onSubmit={submit} aria-label="Sign in">
            <h2>Sign in</h2>
            <div>
                <Label htmlFor="sign-in-email">Email</Label>
                <Input id="sign-in-email" type="email" autoComplete="username webauthn" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
                <Label htmlFor="sign-in-password">Password</Label>
                <Input
                    id="sign-in-password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                />
            </div>
            <Problem>{error}</Problem>
            <Button type="submit" disabled={busy}>
                Sign in
            </Button>
            <PasskeySignIn onError={setError} />
            <p className={SIDE_LINKS}>
                <Link to="/forgot-password">Forgotten your password?</Link>
            </p>
            <p className={SIDE_LINKS}>
                No account yet? <Link to={`/sign-up?next=${encodeURIComponent(next)}`}>Sign up</Link>
            </p>
        </form>
    )
}

/** "Sign in with a passkey": the device's own check (Touch ID, Windows Hello, a PIN) is both factors (D8) */
function PasskeySignIn({ onError }: { onError: (message: string | undefined) => void }) {
    const [busy, setBusy] = useState(false)
    const signIn = async () => {
        setBusy(true)
        onError(undefined)
        const { error } = await signInService.signInWithPasskey()
        setBusy(false)
        if (error) onError(messageOf(error as ServiceError, "That passkey didn't sign you in. Try again, or use your password."))
    }
    return (
        <Button type="button" className="mock-secondary" variant="secondary" disabled={busy} onClick={signIn}>
            Sign in with a passkey
        </Button>
    )
}

/**
 * The second factor, after the password. With the emailed code on offer it's sent at once; someone with the app is
 * asked for its code, with a backup code as the way round a lost phone. Someone offered neither has only a passkey
 * (D4a), and is asked for it. "Trust this device" skips this step here for 30 days.
 */
export function SecondFactorForm({ methods, onStartAgain }: { methods: SecondFactorMethod[]; onStartAgain: () => void }) {
    const emailed = methods.includes("otp")
    const [method, setMethod] = useState<"otp" | "totp" | "backup" | "passkey">(emailed ? "otp" : methods.includes("totp") ? "totp" : "passkey")
    const [code, setCode] = useState("")
    const [trustDevice, setTrustDevice] = useState(false)
    const [error, setError] = useState<string>()
    const [notice, setNotice] = useState<string>()
    const [busy, setBusy] = useState(false)
    const sent = useRef(false)

    const send = async () => {
        setError(undefined)
        const { error } = await signInService.sendCode()
        if (error) setError(messageOf(error as ServiceError, "Couldn't send the code. Try again."))
        else setNotice("We've emailed you a 6-digit code. It expires in 3 minutes.")
    }
    useEffect(() => {
        // Once, even when React runs effects twice in development
        if (emailed && !sent.current) {
            sent.current = true
            void send()
        }
    }, [emailed])

    const submit = async (event: FormEvent) => {
        event.preventDefault()
        setBusy(true)
        setError(undefined)
        const verify =
            method === "otp" ? signInService.verifyCode : method === "totp" ? signInService.verifyAppCode : signInService.verifyBackupCode
        const { error } = await verify(code.trim(), trustDevice)
        setBusy(false)
        if (error) {
            setError(
                error.status === 401 && /cookie/i.test(error.message ?? "")
                    ? "This sign-in has expired: start again."
                    : messageOf(error as ServiceError, "That code isn't right. Try again.")
            )
        }
        // Signed in: the session updates, and the page that asked for it shows
    }
    const choose = (next: typeof method) => () => {
        setMethod(next)
        setCode("")
        setError(undefined)
    }

    const prompt = {
        otp: "Enter the code we've emailed you.",
        totp: "Enter the 6-digit code from your authenticator app.",
        backup: "Enter one of your backup codes. Each works once.",
        passkey: "Use your passkey to finish signing in."
    }[method]
    return (
        <form className="mock-card" onSubmit={submit} aria-label="Enter your code">
            <h2>{method === "passkey" ? "Use your passkey" : "Enter your code"}</h2>
            <p>{prompt}</p>
            {notice && method === "otp" && <p role="status">{notice}</p>}
            {method === "passkey" ? (
                <PasskeySignIn onError={setError} />
            ) : (
                <>
                    <div>
                        <Label htmlFor="second-factor-code">{method === "backup" ? "Backup code" : "Code"}</Label>
                        <Input
                            id="second-factor-code"
                            autoComplete="one-time-code"
                            inputMode={method === "backup" ? "text" : "numeric"}
                            required
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                        />
                    </div>
                    <label className="mock-check">
                        <input type="checkbox" checked={trustDevice} onChange={(e) => setTrustDevice(e.target.checked)} /> Trust this
                        device for 30 days
                    </label>
                </>
            )}
            <Problem>{error}</Problem>
            {method !== "passkey" && (
                <Button type="submit" disabled={busy}>
                    Continue
                </Button>
            )}
            <p className={SIDE_LINKS}>
                {method === "otp" && (
                    <button type="button" className="mock-link" onClick={send}>
                        Send a new code
                    </button>
                )}
                {method !== "totp" && methods.includes("totp") && (
                    <button type="button" className="mock-link" onClick={choose("totp")}>
                        Use your authenticator app
                    </button>
                )}
            </p>
            {/* A backup code is the way round a lost phone. A passkey isn't offered here: whether this person has one isn't
                known before they've signed in, and "Sign in with a passkey" is on the first screen ("Start again") */}
            {method !== "backup" && methods.includes("totp") && (
                <p className={SIDE_LINKS}>
                    <button type="button" className="mock-link" onClick={choose("backup")}>
                        Use a backup code
                    </button>
                </p>
            )}
            <p className={SIDE_LINKS}>
                <button type="button" className="mock-link" onClick={onStartAgain}>
                    Start again
                </button>
            </p>
        </form>
    )
}

/** Signing up: name, email and password, then "check your email" (the email must be verified before signing in). */
export function SignUpForm({ next, navigation }: { next: string; navigation?: Navigation }) {
    // Where the verification link lands: the registration page carrying `next`, or `next` (ADR-068)
    const landing = afterSignUp(next, navigation)
    const [name, setName] = useState("")
    const [email, setEmail] = useState("")
    const [password, setPassword] = useState("")
    const [error, setError] = useState<string>()
    const [busy, setBusy] = useState(false)
    const [sent, setSent] = useState<string>()

    const submit = async (event: FormEvent) => {
        event.preventDefault()
        setBusy(true)
        setError(undefined)
        const { error } = await signInService.signUpWithEmail({ name, email, password, callbackURL: landing })
        setBusy(false)
        if (error) setError(messageOf(error as ServiceError, "Couldn't sign up. Try again."))
        else setSent(email)
    }

    if (sent) return <CheckEmail email={sent} landing={landing} onWrongAddress={() => setSent(undefined)} />
    return (
        <form className="mock-card" onSubmit={submit} aria-label="Sign up">
            <h2>Create your account</h2>
            <div>
                <Label htmlFor="sign-up-name">Name</Label>
                <Input id="sign-up-name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
                <Label htmlFor="sign-up-email">Email</Label>
                <Input id="sign-up-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
                <Label htmlFor="sign-up-password">Password</Label>
                <NewPassword id="sign-up-password" value={password} onChange={setPassword} />
            </div>
            <Problem>{error}</Problem>
            <Button type="submit" disabled={busy}>
                Sign up
            </Button>
            <p className={SIDE_LINKS}>
                Already have an account? <Link to={`/sign-in?next=${encodeURIComponent(next)}`}>Sign in</Link>
            </p>
        </form>
    )
}

/** A new password (D7): 12 to 128 characters, no other rules; the sign-in service refuses one known from a breach */
export function NewPassword({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
    return (
        <>
            <Input
                id={id}
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
                aria-describedby={`${id}-rule`}
                value={value}
                onChange={(e) => onChange(e.target.value)}
            />
            <p id={`${id}-rule`} className="text-sm text-muted-foreground">
                At least 12 characters. A few words together make a good one.
            </p>
        </>
    )
}

/** "Check your email", with the link sent again on request (D12) */
function CheckEmail({ email, landing, onWrongAddress }: { email: string; landing: string; onWrongAddress: () => void }) {
    const [again, setAgain] = useState<string>()
    const sendAgain = async () => {
        const { error } = await signInService.sendVerificationEmail(email, landing)
        setAgain(error ? messageOf(error as ServiceError, "Couldn't send it. Try again.") : "We've sent it again.")
    }
    return (
        <section className="mock-card" role="status">
            <h2>Check your email</h2>
            <p>We've sent a link to {email} to verify your address. Open it to finish signing up.</p>
            {again && <p>{again}</p>}
            <p className={SIDE_LINKS}>
                Nothing arrived?{" "}
                <button type="button" className="mock-link" onClick={sendAgain}>
                    Send it again
                </button>
            </p>
            <p className={SIDE_LINKS}>
                Wrong address?{" "}
                <button type="button" className="mock-link" onClick={onWrongAddress}>
                    Sign up again
                </button>
            </p>
        </section>
    )
}

/** `/forgot-password`: an emailed link (D4). The same answer whether or not there's an account, so no one can probe. */
export function ForgotPasswordPage() {
    const [email, setEmail] = useState("")
    const [sent, setSent] = useState(false)
    const [error, setError] = useState<string>()
    const [busy, setBusy] = useState(false)

    const submit = async (event: FormEvent) => {
        event.preventDefault()
        setBusy(true)
        setError(undefined)
        const { error } = await signInService.requestPasswordReset(email)
        setBusy(false)
        if (error) setError(messageOf(error as ServiceError, "Couldn't send the link. Try again."))
        else setSent(true)
    }
    if (sent) {
        return (
            <section className="mock-card" role="status">
                <h2>Check your email</h2>
                <p>If {email} has an account, we've sent it a link to choose a new password. It works once, for an hour.</p>
                <p className={SIDE_LINKS}>
                    <Link to="/sign-in">Back to sign in</Link>
                </p>
            </section>
        )
    }
    return (
        <form className="mock-card" onSubmit={submit} aria-label="Forgotten your password">
            <h2>Forgotten your password?</h2>
            <p>We'll email you a link to choose a new one.</p>
            <div>
                <Label htmlFor="forgot-email">Email</Label>
                <Input id="forgot-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <Problem>{error}</Problem>
            <Button type="submit" disabled={busy}>
                Send the link
            </Button>
            <p className={SIDE_LINKS}>
                <Link to="/sign-in">Back to sign in</Link>
            </p>
        </form>
    )
}

/**
 * `/reset-password?token=…`: where the emailed link lands (the sign-in service checks it first, and sends `error`
 * instead when it has expired or been used). A new password signs out every session; then the person signs in, with
 * their app or passkey too if they have one.
 */
export function ResetPasswordPage() {
    const [params] = useSearchParams()
    const token = params.get("token")
    const [password, setPassword] = useState("")
    const [done, setDone] = useState(false)
    const [error, setError] = useState<string>()
    const [busy, setBusy] = useState(false)

    if (!token || params.get("error")) {
        return (
            <section className="mock-card" role="alert">
                <h2>This link has expired</h2>
                <p>A link to reset your password works once, for an hour.</p>
                <p className={SIDE_LINKS}>
                    <Link to="/forgot-password">Send me a new link</Link>
                </p>
            </section>
        )
    }
    const submit = async (event: FormEvent) => {
        event.preventDefault()
        setBusy(true)
        setError(undefined)
        const { error } = await signInService.resetPassword(token, password)
        setBusy(false)
        if (error) setError(messageOf(error as ServiceError, "Couldn't change your password. Try again."))
        else setDone(true)
    }
    if (done) {
        return (
            <section className="mock-card" role="status">
                <h2>Your password is changed</h2>
                <p>Every session was signed out. Sign in with your new password.</p>
                <p className={SIDE_LINKS}>
                    <Link to="/sign-in">Sign in</Link>
                </p>
            </section>
        )
    }
    return (
        <form className="mock-card" onSubmit={submit} aria-label="Choose a new password">
            <h2>Choose a new password</h2>
            <div>
                <Label htmlFor="reset-password">New password</Label>
                <NewPassword id="reset-password" value={password} onChange={setPassword} />
            </div>
            <Problem>{error}</Problem>
            <Button type="submit" disabled={busy}>
                Change my password
            </Button>
        </form>
    )
}

/** Better Auth's answers on a link that didn't work (the `error` it lands with) */
const LINK_PROBLEMS = new Set(["TOKEN_EXPIRED", "INVALID_TOKEN"])

/**
 * A verification link that expired or was used (D12): it lands on its page with `?error=`. Above any page: the
 * notice, and the link sent again to the address typed in. (The reset link has its own page.)
 */
export function LinkExpired() {
    const [params] = useSearchParams()
    const { pathname } = useLocation()
    const [email, setEmail] = useState("")
    const [sent, setSent] = useState<string>()
    const problem = params.get("error")
    if (!problem || !LINK_PROBLEMS.has(problem) || pathname === "/reset-password") return null
    // A change of email's link: starting the change again sends new ones (a verification link wouldn't do)
    if (pathname === EMAIL_CHANGED_PAGE || params.get("email") === "changing") {
        return (
            <section className="mock-card" role="alert" aria-label="This link has expired">
                <h2>This link has expired</h2>
                <p>A link to change your email works once, for an hour. Your email hasn't changed.</p>
                <p className={SIDE_LINKS}>
                    <Link to="/account">Change it again from your account</Link>
                </p>
            </section>
        )
    }

    const submit = async (event: FormEvent) => {
        event.preventDefault()
        // The same landing page, `?next=` and all, without the link's error
        const keep = new URLSearchParams(params)
        keep.delete("error")
        const again = keep.size > 0 ? `${pathname}?${keep}` : pathname
        const { error } = await signInService.sendVerificationEmail(email, again)
        setSent(error ? messageOf(error as ServiceError, "Couldn't send it. Try again.") : `We've sent a new link to ${email}.`)
    }
    return (
        <form className="mock-card" onSubmit={submit} aria-label="This link has expired">
            <h2>This link has expired</h2>
            <p>A link to verify your email works once, for an hour. We can send you a new one.</p>
            <div>
                <Label htmlFor="link-expired-email">Email</Label>
                <Input id="link-expired-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {sent && <p role="status">{sent}</p>}
            <Button type="submit">Send me a new link</Button>
        </form>
    )
}

/** `/sign-in`: the form, or straight on to `next` once someone is signed in */
export function SignInPage() {
    const [params] = useSearchParams()
    const next = nextPath(params.get("next"))
    const { signedIn, pending } = useSessionState()
    if (pending) return <p role="status">Checking who is signed in…</p>
    if (signedIn) return <Navigate to={next} replace />
    return <SignInForm next={next} />
}

/** `/sign-up`; `navigation` is the model's (`navigation.json`), given only by tests */
export function SignUpPage({ navigation }: { navigation?: Navigation }) {
    const [params] = useSearchParams()
    return <SignUpForm next={nextPath(params.get("next"))} navigation={navigation} />
}

/** The current page, as `next` for a sign-in form shown in its place (`RequireSession`) */
export function useHere(): string {
    const { pathname, search } = useLocation()
    return `${pathname}${search}`
}
