import { useState, type FormEvent } from "react"
import { Link, Navigate, useLocation, useSearchParams } from "react-router"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { signInService } from "./auth-client"
import { useSessionState } from "./session"

/**
 * The sign-in screens (ADR-055, ADR-057): the sign-in system's, provided by the kit, never built by the loop. Their
 * headings, labels, buttons and links match emcli's starters (`element mockup --starter sign-in | sign-up |
 * check-email`), so the board shows what people get. Each call is Better Auth's, through `signInService`
 * (better-auth.com/docs/authentication/email-password).
 *
 * `next` is the page to return to: the protected page that asked for sign-in, carried through Sign Up, where it
 * becomes the verification link's `callbackURL` (verifying signs the person in and lands them there).
 */

/** Where to go after signing in or verifying: a path on this site (never another origin), "/" by default */
export function nextPath(next: string | null | undefined): string {
    return next && next.startsWith("/") && !next.startsWith("//") ? next : "/"
}

/** Signing in with an email and password. Better Auth refuses an unverified email with 403, and sends the link again. */
export function SignInForm({ next }: { next: string }) {
    const [email, setEmail] = useState("")
    const [password, setPassword] = useState("")
    const [error, setError] = useState<string>()
    const [busy, setBusy] = useState(false)

    const submit = async (event: FormEvent) => {
        event.preventDefault()
        setBusy(true)
        setError(undefined)
        const { error } = await signInService.signInWithEmail(email, password)
        setBusy(false)
        if (error) {
            setError(
                error.status === 403
                    ? "Verify your email address first: we've sent you the link again."
                    : (error.message ?? "Couldn't sign in. Try again.")
            )
        }
    }
    return (
        <form className="mock-card" onSubmit={submit} aria-label="Sign in">
            <h2>Sign in</h2>
            <div>
                <Label htmlFor="sign-in-email">Email</Label>
                <Input id="sign-in-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
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
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            )}
            <Button type="submit" disabled={busy}>
                Sign in
            </Button>
            <p className="text-sm text-muted-foreground">
                No account yet? <Link to={`/sign-up?next=${encodeURIComponent(next)}`}>Sign up</Link>
            </p>
        </form>
    )
}

/** Signing up: name, email and password, then "check your email" (the email must be verified before signing in). */
export function SignUpForm({ next }: { next: string }) {
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
        const { error } = await signInService.signUpWithEmail({ name, email, password, callbackURL: next })
        setBusy(false)
        if (error) setError(error.message ?? "Couldn't sign up. Try again.")
        else setSent(email)
    }

    if (sent) {
        return (
            <section className="mock-card" role="status">
                <h2>Check your email</h2>
                <p>We've sent a link to {sent} to verify your address. Open it to finish signing up.</p>
                <p className="text-sm text-muted-foreground">
                    Wrong address?{" "}
                    <button type="button" className="underline" onClick={() => setSent(undefined)}>
                        Sign up again
                    </button>
                </p>
            </section>
        )
    }
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
                <Input
                    id="sign-up-password"
                    type="password"
                    autoComplete="new-password"
                    minLength={8}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                />
            </div>
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            )}
            <Button type="submit" disabled={busy}>
                Sign up
            </Button>
            <p className="text-sm text-muted-foreground">
                Already have an account? <Link to={`/sign-in?next=${encodeURIComponent(next)}`}>Sign in</Link>
            </p>
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

/** `/sign-up` */
export function SignUpPage() {
    const [params] = useSearchParams()
    return <SignUpForm next={nextPath(params.get("next"))} />
}

/** The current page, as `next` for a sign-in form shown in its place (`RequireSession`) */
export function useHere(): string {
    const { pathname, search } = useLocation()
    return `${pathname}${search}`
}
