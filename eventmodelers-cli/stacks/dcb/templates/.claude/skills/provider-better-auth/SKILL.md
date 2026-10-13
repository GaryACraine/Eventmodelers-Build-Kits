---
name: provider-better-auth
description: Better Auth, the sign-in service (ADR-054, ADR-055, ADR-056, ADR-057). What the scaffold already provides (the service, the sign-in and account screens, the step-up prompt, the session, the bearer token, the API's check), which screens are never yours to build (Sign Up, Sign In, the code, password reset, the account page: marked --external Auth), how a page reads who is signed in, how to test against it, and how an end-to-end journey signs up for real through Mailpit. Read it when a slice touches the Auth lane or sign-in. A draft on first use.
---

# Better Auth: sign-in, which the kit provides

> **Draft, on first use** (ADR-042's rule: distil on solid ground). The scaffold's sign-in (the `auth/` service, the
> sign-in screens, `web/src/lib/auth-client.ts`, `session.tsx`, the API's `src/shared/signIn.ts`) is proven by its
> own tests and in licensing (2026-10-09); the account screens and step-up (ADR-056) by their own tests only, until
> PLAN 2b.2d step 8. Follow it; where a slice doesn't fit, block the job with
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
| **The sign-in screens:** Sign In with its second factor (the emailed code, the app's code, a backup code, a passkey), Sign Up, "check your email" with "send it again", forgotten and reset password, an expired link (`/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password`) | `web/src/lib/sign-in.tsx`, routed in `routes.tsx` |
| **The account page** (`/account`): email, password, the authenticator app and backup codes, passkeys, sessions | `web/src/lib/account.tsx` |
| **The step-up prompt:** "Confirm it's you" over any page whose action needs the app or a passkey, with setting one up | `web/src/lib/step-up.tsx` (`StepUpProvider` in `App.tsx`) |
| The header: who is signed in (a link to the account page), and Sign out | `web/src/Layout.tsx` |
| The client, and every call to it | `web/src/lib/auth-client.ts`: **`signInService`** |
| The session; the sign-in form in place of a protected page | `web/src/lib/session.tsx` (`RequireSession`) |
| The bearer token on every API request; a step-up's 401 shows the prompt, then sends the request again | `web/src/lib/api.ts` |
| Checking the token in the API | `src/shared/signIn.ts` (`signedInOf(res)`) |

**A screen card marked `--external Auth` is the sign-in system's** (ADR-057). emcli gives it no job, so it never
reaches you. If one does, block with `request-feedback`: the model needs `--external Auth` on it.

**A step-up is never yours to handle in a slice's screen.** The API client shows the prompt and sends the request
again; a form just awaits `command(...)` as usual. Only if the person puts it off does the call throw `ApiError` with
`status` 401 and `stepUp` set: show its message like any other refusal.

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

## Signed out on a page: back to it, registered (the kit's; ADR-068)

Someone who opens a page signed out (an invitation's link, a bookmark) comes back to it, whichever way they sign in.
The kit does this; a slice never builds or changes it:
- **Every way into sign-in carries the page** as `next`: the page's own sign-in form (`RequireSession`), its "Sign up"
  link, and the header's Sign in and Sign up (`Layout.tsx`; on the sign-in pages, their own `next`). An expired link
  sends a new one to the same page, `next` and all.
- **A new person registers first:** sign-up's verification link lands on the registration page that `navigation.json`
  names (`register`), carrying `next` (`afterSignUp`); that page goes on to `next` after its command
  (the kit's `ModelPage`, ADR-069). Without a registration page, it lands on `next` itself.
- **The model says which page registers** (`emcli navigation` shows it, and warns when none or several could).
- **Its test:** `web/src/lib/signed-out.test.tsx` walks the chain (a page → sign in's Sign up → the verification
  link's landing → back). A change to any step keeps it passing; a journey (`member-joins` in licensing) runs it
  for real.

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
- **Signing in again needs the second factor** (ADR-056 D2): after the password, the journey reads the "Your
  sign-in code" email from Mailpit the same way and enters the 6-digit code.

## Decided, built (ADR-056, Accepted 2026-10-11; PLAN 2b.2d)

**The sign-in service has all of it** (`auth/src`: `signInMethod.ts`, `accountChanges.ts`, `unverified.ts`), the API
checks each role's sign-in level (`src/shared/permissions.ts`, `signIn.ts`), and the screens are in `web/src/lib`.
Proving it end to end in a project is PLAN 2b.2d steps 7 and 8.
- **Every password sign-in needs an emailed code** (D2), and "remember this device" lasts 30 days.
- **A role may need more** (D1, D3). The role map's sign-in level (`second-factor` or `not-by-email`) is checked by
  the API, not by Better Auth. The token's `amr` says how the session signed in. A weaker session gets **401
  `insufficient_user_authentication`**, and the web app asks for the passkey or the app code. Roles never reach the
  sign-in service.
- **These screens come with the kit, never from a slice** (D13): forgot and reset password, enter a code, set up the
  app and backup codes, passkeys, and the account page (password, email, second factors, sessions). In the model
  they're `--external Auth`.
- **A change of email** is recorded by identity's `self` command, which takes the new email from the token (D6).
  Its screen is the project's own, at **`/email-changed`**: the change's links land there whenever the app has a page
  with that route (Gary, 2026-10-11). It shows the new address (`SignedInUser`) and one button, "Use this address",
  that submits the command. It's an ordinary screen of ours, built by the loop.
- **The rest**, each a setting in `auth/src/auth.ts` or `config.ts` (see the ADR):
  - reset (D4);
  - password rules and breached passwords (D7);
  - passkeys (D8);
  - sessions (D9);
  - notices (D10);
  - rate limits (D11);
  - sign-up's unhappy paths and the 7-day removal of unverified accounts (D12).
- **Security evidence** (D14): `security/POLICY.md` and `EVIDENCE.md` list each policy and its tests.

## Deployments

The same screens work in our cloud and on-premises: only the sign-in service's settings differ (`DEPLOYMENT`,
ADR-055: SES or SMTP, secure cookies, the client IP header).
