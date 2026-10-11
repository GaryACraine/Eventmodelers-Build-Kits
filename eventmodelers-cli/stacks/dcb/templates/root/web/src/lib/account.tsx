import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react"
import { useSearchParams } from "react-router"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { messageOf, signInService, type ServiceError } from "./auth-client"
import { useSession } from "./session"
import { NewPassword } from "./sign-in"
import { AppSetup, useStepUp } from "./step-up"

/**
 * `/account` (ADR-056 D5, D6, D8, D9, D13): the signed-in person's own sign-in, all of it the sign-in service's, so the
 * kit provides it and the loop never builds it. Its headings, labels and buttons match emcli's `account` starter.
 *
 *   - **Email:** a change is confirmed at the current address, then verified at the new one (D6). Both links land on
 *     the project's page at `/email-changed` when it has one (`EMAIL_CHANGED_PAGE`): a screen of its own, which
 *     records the change in its own copy of the address (a `self` command that takes the new address from the
 *     token). Without one, they land here (`?email=changing`).
 *   - **Password:** the current one is needed; every other session is signed out (D5).
 *   - **The authenticator app and its backup codes, and passkeys** (D8). Changing them needs the strongest factor the
 *     person already has: a refusal (`STRONGER_FACTOR_REQUIRED`) asks for it, then the change can be tried again.
 *   - **Sessions** (D9): where the person is signed in, and "sign out everywhere else".
 */
export const ACCOUNT_PAGE = "/account"

/** The project's page an email change lands on, if it has one (routes.tsx passes it when a page has this path) */
export const EMAIL_CHANGED_PAGE = "/email-changed"

/** The sign-in service's answer, and a refusal read out */
type Answer = { error?: ServiceError | null }

function Problem({ children }: { children?: ReactNode }) {
    if (!children) return null
    return (
        <p role="alert" className="text-sm text-destructive">
            {children}
        </p>
    )
}

function Done({ children }: { children?: ReactNode }) {
    if (!children) return null
    return <p role="status">{children}</p>
}

/**
 * A change to a factor: when the sign-in service wants the strongest factor first, the person is asked for it
 * (the step-up prompt) and the change goes again once.
 */
function useFactorChange() {
    const { ask } = useStepUp()
    return useCallback(
        async <T extends Answer>(change: () => Promise<T>): Promise<T> => {
            const first = await change()
            if (first.error?.code !== "STRONGER_FACTOR_REQUIRED") return first
            return (await ask("not-by-email")) ? change() : first
        },
        [ask]
    )
}

export function AccountPage({ emailChangedPage }: { emailChangedPage?: string }) {
    const { email } = useSession()
    return (
        <>
            <h1>Your account</h1>
            <EmailSection email={email ?? ""} landing={emailChangedPage ?? `${ACCOUNT_PAGE}?email=changing`} />
            <PasswordSection />
            <AppSection />
            <PasskeySection />
            <SessionsSection />
        </>
    )
}

function EmailSection({ email, landing }: { email: string; landing: string }) {
    const [newEmail, setNewEmail] = useState("")
    const [done, setDone] = useState<string>()
    const [error, setError] = useState<string>()
    const [params] = useSearchParams()
    const changing = params.get("email") === "changing"

    const submit = async (event: FormEvent) => {
        event.preventDefault()
        setError(undefined)
        const { error } = await signInService.changeEmail(newEmail, landing)
        if (error) setError(messageOf(error as ServiceError, "Couldn't change your email. Try again."))
        else setDone(`We've emailed ${email} to confirm. Then open the link we send to ${newEmail}.`)
    }
    return (
        <form className="mock-card" onSubmit={submit} aria-label="Email">
            <h2>Email</h2>
            <p>{email}</p>
            {changing && <p role="status">If you've opened the links at both addresses, this is your new address.</p>}
            <Label htmlFor="account-new-email">New email</Label>
            <Input id="account-new-email" type="email" autoComplete="email" required value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
            <Problem>{error}</Problem>
            <Done>{done}</Done>
            <Button type="submit">Change my email</Button>
        </form>
    )
}

function PasswordSection() {
    const [current, setCurrent] = useState("")
    const [next, setNext] = useState("")
    const [done, setDone] = useState<string>()
    const [error, setError] = useState<string>()

    const submit = async (event: FormEvent) => {
        event.preventDefault()
        setError(undefined)
        setDone(undefined)
        const { error } = await signInService.changePassword(current, next)
        if (error) setError(messageOf(error as ServiceError, "Couldn't change your password. Check the current one."))
        else {
            setDone("Your password is changed, and every other session was signed out.")
            setCurrent("")
            setNext("")
        }
    }
    return (
        <form className="mock-card" onSubmit={submit} aria-label="Password">
            <h2>Password</h2>
            <Label htmlFor="account-current-password">Current password</Label>
            <Input
                id="account-current-password"
                type="password"
                autoComplete="current-password"
                required
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
            />
            <Label htmlFor="account-new-password">New password</Label>
            <NewPassword id="account-new-password" value={next} onChange={setNext} />
            <Problem>{error}</Problem>
            <Done>{done}</Done>
            <Button type="submit">Change my password</Button>
        </form>
    )
}

/** What the person can prove beyond the inbox, reloaded after each change */
function useFactors() {
    const [factors, setFactors] = useState<{ app: boolean; passkeys: number }>()
    const load = useCallback(async () => {
        const { data } = await signInService.factors()
        setFactors(data ?? { app: false, passkeys: 0 })
    }, [])
    useEffect(() => {
        void load()
    }, [load])
    return { factors, load }
}

function AppSection() {
    const { factors, load } = useFactors()
    const change = useFactorChange()
    const [settingUp, setSettingUp] = useState(false)
    const [password, setPassword] = useState("")
    const [codes, setCodes] = useState<string[]>()
    const [done, setDone] = useState<string>()
    const [error, setError] = useState<string>()

    const newCodes = async () => {
        setError(undefined)
        const { data, error } = await change(() => signInService.newBackupCodes(password))
        if (error) setError(messageOf(error as ServiceError, "Couldn't make new codes. Check your password."))
        else setCodes((data as { backupCodes: string[] }).backupCodes)
    }
    const remove = async () => {
        setError(undefined)
        const { error } = await change(() => signInService.removeApp(password))
        if (error) setError(messageOf(error as ServiceError, "Couldn't remove the app. Check your password."))
        else {
            setDone("The app is removed. Signing in asks for a code we email you again.")
            await load()
        }
    }

    return (
        <section className="mock-card" aria-label="Authenticator app">
            <h2>Authenticator app</h2>
            {!factors ? (
                <p role="status">Checking…</p>
            ) : settingUp ? (
                <AppSetup
                    onDone={async () => {
                        setSettingUp(false)
                        setDone("The app is set up. Signing in now asks for its code.")
                        await load()
                    }}
                />
            ) : factors.app ? (
                <>
                    <p>Set up. Signing in asks for its code, or a backup code.</p>
                    <Label htmlFor="account-app-password">Your password</Label>
                    <Input
                        id="account-app-password"
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                    {codes && <pre className="mock-codes">{codes.join("\n")}</pre>}
                    <Button type="button" onClick={newCodes} disabled={!password}>
                        Make new backup codes
                    </Button>
                    <Button type="button" variant="secondary" className="mock-secondary" onClick={remove} disabled={!password}>
                        Remove the app
                    </Button>
                </>
            ) : (
                <>
                    <p>Not set up. Signing in asks for a code we email you. The app is stronger: someone who got into your email couldn't use it.</p>
                    <Button type="button" onClick={() => setSettingUp(true)}>
                        Set up the authenticator app
                    </Button>
                </>
            )}
            <Problem>{error}</Problem>
            <Done>{done}</Done>
        </section>
    )
}

interface Passkey {
    id: string
    name?: string | null
    createdAt: string | Date
}

function PasskeySection() {
    const change = useFactorChange()
    const [passkeys, setPasskeys] = useState<Passkey[]>()
    const [error, setError] = useState<string>()

    const load = useCallback(async () => {
        const { data } = await signInService.listPasskeys()
        setPasskeys((data as Passkey[] | null) ?? [])
    }, [])
    useEffect(() => {
        void load()
    }, [load])

    const add = async () => {
        setError(undefined)
        const result = await change(async () => (await signInService.addPasskey()) as Answer)
        if (result?.error) setError(messageOf(result.error, "Couldn't add the passkey. Try again."))
        else await load()
    }
    const remove = async (id: string) => {
        setError(undefined)
        const { error } = await change(() => signInService.removePasskey(id))
        if (error) setError(messageOf(error as ServiceError, "Couldn't remove the passkey. Try again."))
        else await load()
    }
    return (
        <section className="mock-card" aria-label="Passkeys">
            <h2>Passkeys</h2>
            <p>Sign in with your fingerprint, face or device PIN instead of a password and code.</p>
            {passkeys && passkeys.length > 0 && (
                <table>
                    <tbody>
                        {passkeys.map((p) => (
                            <tr key={p.id}>
                                <td>{p.name || "Passkey"}</td>
                                <td>added {new Date(p.createdAt).toLocaleDateString()}</td>
                                <td>
                                    <button type="button" className="mock-link" onClick={() => remove(p.id)}>
                                        Remove
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            <Problem>{error}</Problem>
            <Button type="button" onClick={add}>
                Add a passkey
            </Button>
        </section>
    )
}

interface SignedInSession {
    id: string
    token: string
    userAgent?: string | null
    createdAt: string | Date
    updatedAt?: string | Date
}

function SessionsSection() {
    const { data: current } = signInService.useSession()
    const [sessions, setSessions] = useState<SignedInSession[]>()
    const [done, setDone] = useState<string>()

    const load = useCallback(async () => {
        const { data } = await signInService.listSessions()
        setSessions((data as SignedInSession[] | null) ?? [])
    }, [])
    useEffect(() => {
        void load()
    }, [load])

    const elsewhere = async () => {
        const { error } = await signInService.signOutEverywhereElse()
        if (!error) {
            setDone("Signed out everywhere else.")
            await load()
        }
    }
    const thisOne = (current as { session?: { token?: string } } | null)?.session?.token
    return (
        <section className="mock-card" aria-label="Where you're signed in">
            <h2>Where you're signed in</h2>
            {sessions && (
                <table>
                    <tbody>
                        {sessions.map((s) => (
                            <tr key={s.id}>
                                <td>{s.userAgent || "A browser"}</td>
                                <td>since {new Date(s.createdAt).toLocaleDateString()}</td>
                                <td>{s.token === thisOne ? "this one" : ""}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            <Done>{done}</Done>
            <Button type="button" onClick={elsewhere}>
                Sign out everywhere else
            </Button>
        </section>
    )
}
