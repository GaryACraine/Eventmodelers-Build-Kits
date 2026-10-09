---
name: provider-better-auth
description: Better Auth, the sign-in service (ADR-054, ADR-055, ADR-057). What the scaffold already provides (the service, the sign-in screens, the session, the bearer token, the API's check), which screens are never yours to build (Sign Up, Sign In, check your email: marked --external Auth), how a page reads who is signed in, how to test against it, and how an end-to-end journey signs up for real through Mailpit. Read it when a slice touches the Auth lane or sign-in. A draft on first use.
---

# Better Auth: sign-in, which the kit provides

> **Draft, on first use** (ADR-042's rule: distil on solid ground). The scaffold's sign-in (the `auth/` service, the
> sign-in screens, `web/src/lib/auth-client.ts`, `session.tsx`, the API's `src/shared/signIn.ts`) is proven by its
> own tests and in licensing (2026-10-09). Follow it; where a slice doesn't fit, block the job with
> `request-feedback` saying what didn't fit.

The sign-in service is its own system, **Auth** in the model (ADR-037, ADR-055). Its events (`userSignedUp`) sit in
the Auth lane, marked `--external Auth --intake none` (ADR-053): **nothing of ours records them**. What they leave
behind is the session ("Signed In User", an external read model, ADR-052), which pages read with `useSession()`.

Everything here follows Better Auth's own docs (better-auth.com/docs): the client (`concepts/client`), email and
password (`authentication/email-password`), email verification (`concepts/email`). Checked against `better-auth`
1.7.7 (pinned: security releases are ours, ADR-054).

## What the scaffold already has: never rebuild it

| What | Where |
|---|---|
| The sign-in service: email and password, the email verified at sign-up, JWTs | `auth/` (its own container) |
| **The sign-in screens:** Sign In, Sign Up, "check your email" (`/sign-in`, `/sign-up`) | `web/src/lib/sign-in.tsx`, routed in `routes.tsx` |
| The header: who is signed in, and Sign out | `web/src/Layout.tsx` |
| The client, and every call to it | `web/src/lib/auth-client.ts`: **`signInService`** |
| The session; the sign-in form in place of a protected page | `web/src/lib/session.tsx` (`RequireSession`) |
| The bearer token on every API request | `web/src/lib/api.ts` |
| Checking the token in the API | `src/shared/signIn.ts` (`signedInOf(res)`) |

**A screen card marked `--external Auth` is the sign-in system's** (ADR-057). emcli gives it no job, so it never
reaches you. If one does, block with `request-feedback`: the model needs `--external Auth` on it.

## A page that needs someone signed in

- **The API takes every `session:` value from the token** (ADR-055 part 2): `sub` (Better Auth's user id) and
  `email` directly, any other key (`userId`) through the session lookup (the read model marked `--session-lookup`).
  A form never sends them, and a self read (`/my-account`) takes no key.
- **In the browser,** `useSession()` gives `sub` and `email` for display. A key sign-in doesn't hold (`userId`) is
  asked for by `RequireSession` only in the stub.
- **Never import `better-auth` in a slice,** and never call `authClient` directly: use `signInService`, so tests can
  replace it.
- **Tests:** render with `renderWithProviders(ui, { session: { sub: "u1", email: "owner@contractor.example" } })`;
  that's the stub, with no sign-in service. To test something that calls the sign-in service, replace the call:
  `vi.spyOn(signInService, "signUpWithEmail").mockResolvedValue(...)`, and `vi.restoreAllMocks()` after each.

## Running it for real, and the journey

- `npm run infra:start` runs `auth` (port 3001), its migrations (`auth-migrate`) and **Mailpit**, where every email
  lands (http://localhost:8025). Vite proxies `/api/auth` to the service, so the web app's origin serves sign-in.
- Real sign-in is on with `VITE_SIGN_IN=better-auth` (web/.env). The API checks tokens with `AUTH_ISSUER` and
  `AUTH_JWKS_URL` (.env).
- **An end-to-end journey signs up at `/sign-up?next=<page>`,** then reads the verification email from Mailpit's
  API, waiting on state with a deadline:
  ```ts
  const found = await (await fetch(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()
  const message = await (await fetch(`http://localhost:8025/api/v1/message/${found.messages[0].ID}`)).json()
  const link = message.Text.match(/https?:\/\/\S+/)[0]   // opening it verifies the email, signs in, and lands on <page>
  ```

## Deployments

The same screens work in our cloud and on-premises: only the sign-in service's settings differ (`DEPLOYMENT`,
ADR-055: SES or SMTP, secure cookies, the client IP header).
