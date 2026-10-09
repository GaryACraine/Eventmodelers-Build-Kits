---
name: provider-better-auth
description: Better Auth, the sign-in service (ADR-054, ADR-055), for the screens that talk to it, starting with Sign Up (the form that leads to Auth's userSignedUp). How the form calls the sign-in service through web/src/lib/auth-client.ts, what it shows after (check your email), its tests, its mock-mode handler, and how an end-to-end journey reads the verification email from Mailpit. Read it when a screen's slice holds an event in the Auth lane, or its description names sign-in. A draft on first use.
---

# Better Auth: the screens that talk to the sign-in service

> **Draft, on first use** (ADR-042's rule: distil on solid ground). The scaffold's sign-in (the `auth/` service,
> `web/src/lib/auth-client.ts`, `session.tsx`, the API's `src/shared/signIn.ts`) is proven by its own tests and in
> licensing (2026-10-09); a screen built from this skill isn't yet. Follow it; where a slice doesn't fit, block the job
> with `request-feedback` saying what didn't fit. This skill is rewritten from the lessons once the first slice and
> the journey pass.

The sign-in service is its own system, **Auth** in the model (ADR-037, ADR-055). Its events (`userSignedUp`) sit in
the Auth lane, marked `--external Auth --intake none` (ADR-053): **nothing of ours records them**, and no command of
ours goes to our API for them. What they leave behind is the session ("Signed In User", an external read model,
ADR-052), which pages read with `useSession()`.

Everything here follows Better Auth's own docs (better-auth.com/docs): the client (`concepts/client`), email and
password (`authentication/email-password`), email verification (`concepts/email`). Checked against `better-auth`
1.7.7 (pinned: security releases are ours, ADR-054).

## What the scaffold already has (don't rebuild it)

| What | Where |
|---|---|
| The sign-in service: email and password, the email verified at sign-up, JWTs | `auth/` (its own container) |
| The client, and every call to it | `web/src/lib/auth-client.ts`: **`signInService`** |
| The session, the sign-in form, sign-out | `web/src/lib/session.tsx` (`RequireSession` shows the sign-in form) |
| The bearer token on every API request | `web/src/lib/api.ts` |
| Checking the token in the API | `src/shared/signIn.ts` (`signedInOf(res)`) |

**Signing in is the scaffold's; signing up is a modelled screen** (ADR-052 point 5): it's the one you build.

## The Sign Up screen

The slice holds the Sign Up screen and, in the Auth lane, `userSignedUp` (what the form leads to). There's no
`commands[]` entry for our API: the form's submit goes to the sign-in service.

```tsx
import { signInService } from "@/lib/auth-client"

const { error } = await signInService.signUpWithEmail({ name, email, password, callbackURL: "/get-started" })
if (error) { setError(error.message ?? "Couldn't sign up. Try again."); return }
setSent(email)          // the form is replaced by "check your email"
```

- **Never import `better-auth` in a slice,** and never call `authClient` directly: always `signInService`, so tests
  can replace it.
- **The fields come from the mockup:** Name, Email, Password. Better Auth requires `name`. Use `type="email"`,
  `type="password"`, `autoComplete="name" | "email" | "new-password"`, and `minLength={8}` (Better Auth's default
  minimum; ADR-056 may raise it).
- **`callbackURL`** is the page the person lands on after verifying their email: the page whose `RequireSession`
  needs the session (e.g. Get Started's route). Verifying signs them in (`autoSignInAfterVerification`).
- **After a successful sign-up, no one is signed in yet:** the email must be verified first
  (`requireEmailVerification`). Replace the form with a `role="status"` message: "Check your email: we've sent a
  link to {email} to verify your address." The mockup's text wins if it has one.
- **An error** (`error.message`) is shown in the form, as a rejection is (`role="alert"`). Better Auth answers the same
  whether or not the email is already registered, so don't add an "already registered" message of your own.
- **Link to signing in** if the mockup has "Already have an account? Sign in": a link to the page the person came from
  (any page behind `RequireSession` shows the sign-in form).

## Tests

A test per behaviour, with `signInService` replaced:

```tsx
const signUp = vi.spyOn(signInService, "signUpWithEmail").mockResolvedValue({ data: { token: null, user: { id: "u1" } }, error: null } as never)
// fill Name, Email, Password; click "Sign up"
expect(signUp).toHaveBeenCalledWith({ name: "Owner", email: "owner@contractor.example", password: "…", callbackURL: "/get-started" })
expect(await screen.findByRole("status")).toHaveTextContent("Check your email")
```

and one with `{ data: null, error: { status: 400, message: "Password too short" } }` showing the alert. Restore the
spies (`vi.restoreAllMocks()`) after each.

## Mock mode

`npm run dev:mock` has no sign-in service: add an MSW handler for the sign-up call to the slice's `handlers.ts`, so
the form reaches its "check your email" state.

```ts
http.post(`${globalThis.location.origin}/api/auth/sign-up/email`, () =>
    HttpResponse.json({ token: null, user: { id: "mock-user", email: "owner@contractor.example", name: "Owner", emailVerified: false } })
)
```

## Running it for real, and the journey

- `npm run infra:start` runs `auth` (port 3001), its migrations (`auth-migrate`) and **Mailpit**, where every email
  lands (http://localhost:8025). Vite proxies `/api/auth` to the service, so the web app's origin serves sign-in.
- Real sign-in is on with `VITE_SIGN_IN=better-auth` (web/.env). The API checks tokens with `AUTH_ISSUER` and
  `AUTH_JWKS_URL` (.env).
- **An end-to-end journey reads the verification email from Mailpit's API**, waiting on state with a deadline:
  ```ts
  const found = await (await fetch(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()
  const message = await (await fetch(`http://localhost:8025/api/v1/message/${found.messages[0].ID}`)).json()
  const link = message.Text.match(/https?:\/\/\S+/)[0]   // opening it verifies the email and signs the person in
  ```

## Deployments

The same screen works in our cloud and on-premises: only the sign-in service's settings differ (`DEPLOYMENT`,
ADR-055: SES or SMTP, secure cookies, the client IP header). The screen never knows which.
