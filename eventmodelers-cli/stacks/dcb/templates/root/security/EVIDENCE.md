# Security evidence

What proves each policy in [POLICY.md](POLICY.md), and when it last ran. A policy can have several rows: the unit
tests that come with the kit, this project's end-to-end scripts, a check by hand.

- **Proved by:** each `path` is from the project's root (only paths go in backticks here); each "name" after it is
  a test's name in that file (or a line an end-to-end script prints).
- **Last run:** the date, the result, and a link to the recorded run in [results/](results/) (`npm run
  security:record`, see [README.md](README.md)).

`npm run security:check` warns when a policy names no test, or a file or test it names doesn't exist.

## Access control

| ID | Proved by | Last run |
|---|---|---|
| AC-1 | `src/shared/signIn.tests.ts` "a valid token says who is signed in", "is refused with 401, and the route doesn't run" (expired, another issuer, an unverified email, another key, tampered with), "an Authorization header that isn't a bearer token is refused", "when sign-in isn't configured, any token is refused rather than trusted" | — |
| AC-1 | `auth/src/server.tests.ts` "signs a person up, verifies their email, and issues a JWT the API can check" | — |
| AC-2 | `src/shared/signIn.tests.ts` "the signed-in person's sub and email come from the token, never the request", "the token's email wins over the session lookup's older copy" | — |
| AC-3 | `src/shared/contract.tests.ts` "a served route the model doesn't have is an error"; the build's check `.build-kit/lib/checks/92-api-contract.cjs` | — |
| AC-4 | `src/shared/signIn.tests.ts` "runs for a member whose role holds it, in the organisation the body names", "runs in the organisation the path names", "answers 404 in an organisation the caller has no role in: it doesn't say whether it exists", "answers 403 to a member whose roles don't hold it", "answers 403 when the request names no organisation and no platform role holds it", "runs for a platform role in any organisation, and where none is named" | — |
| AC-5 | `src/shared/signIn.tests.ts` "denies everyone when the roles aren't configured" | — |
| AC-6 | `src/shared/signIn.tests.ts` "a route that needs the signed-in person refuses a request without a token (401)", "signed in but not registered: 403, register first" | — |
| AC-7 | `src/shared/inbox.tests.ts` "a bad signature answers 401 and records nothing", "a redelivery answers 200 and records nothing again" | — |
| AC-8 | `auth/src/server.tests.ts` "refuses a browser request with cookies from an origin it doesn't trust, and a redirect to one"; `web/src/lib/sign-in.test.tsx` "only ever returns to a page on this site" | — |

## Account security

| ID | Proved by | Last run |
|---|---|---|
| AS-1 | `auth/src/signInMethod.tests.ts` "the verification link signs in with email-link", "a password alone never signs in; with the emailed code it's pwd and email-otp", "a trusted device skips the code, and says so" | — |
| AS-2 | `src/shared/signIn.tests.ts` "an owner who proved only the inbox is asked for the app or a passkey, and doesn't run", "an owner with the app, a backup code or a passkey runs", "a role the caller also holds, with a lower level, is enough on its own", "a platform admin needs the app or a passkey too", "asking for a step-up never says more than a 404 or 403 would" | — |
| AS-2 | `web/src/lib/step-up.test.tsx` "shows the prompt, then sends the same request again (same body, same Idempotency-Key)", "requests refused together share one prompt and one code", "put off, the 401 stands, and says what it asked for" | — |
| AS-3 | `auth/src/signInMethod.tests.ts` "a password alone never signs in; with the emailed code it's pwd and email-otp", "a trusted device skips the code, and says so"; `web/src/lib/sign-in.test.tsx` "after the password, emails a code once and checks it, trusting the device when asked" | — |
| AS-4 | `auth/src/signInMethod.tests.ts` "with the app, the inbox alone signs no one in (D4a)"; `web/src/lib/sign-in.test.tsx` "someone with the app is asked for its code, never emailed one", "someone with only a passkey is offered nothing by email" | — |
| AS-5 | `auth/src/signInMethod.tests.ts` "setting up the app doesn't step up; its code afterwards does", "an older session can't change a factor"; `web/src/lib/step-up.test.tsx` "adding a passkey when the service wants the strongest factor first: asks for it, then adds it" | — |
| AS-6 | `auth/src/signInMethod.tests.ts` "a passkey that checks it's you signs in on its own; one that doesn't is refused" | — |
| AS-7 | `auth/src/accountLifecycle.tests.ts` "after 12 hours the token stops listing the app, so the API asks again", "a passkey-only session after 12 hours keeps a second factor (mfa)"; `src/shared/signIn.tests.ts` "a passkey or the app proved over 12 hours ago (mfa, D15) is still a second factor, but an owner is asked again" | — |
| AS-8 | `auth/src/accountLifecycle.tests.ts` "an emailed link, once, that ends every session; the same answer for an address with no account"; `web/src/lib/sign-in.test.tsx` "emails a link, with the same answer whether or not there's an account", "the link's page sets a new password, then says every session was signed out" | — |
| AS-9 | `auth/src/accountLifecycle.tests.ts` "needs the current one, and ends every other session even when the form asks not to"; `web/src/lib/step-up.test.tsx` "changes the password, signing out the other sessions (D5)" | — |
| AS-10 | `auth/src/accountLifecycle.tests.ts` "confirmed at the old address, verified at the new one, the old one told; the links sign no one in"; `src/shared/signIn.tests.ts` "the token's email wins over the session lookup's older copy"; `web/src/lib/step-up.test.tsx` "changes the email: confirmed at the current address, then verified at the new one (D6)" | — |
| AS-11 | `auth/src/accountLifecycle.tests.ts` "at least 12 characters, at most 128, no composition rules"; `auth/src/config.tests.ts` "refusing breached passwords is Better Auth's Have I Been Pwned plugin, on unless turned off" | — |
| AS-12 | `auth/src/accountLifecycle.tests.ts` "last 7 days; the person sees them and can sign out everywhere"; `auth/src/server.tests.ts` "issues a JWT the API can check" (15 minutes); `web/src/lib/step-up.test.tsx` "signs out everywhere else (D9)" | — |
| AS-13 | `auth/src/accountLifecycle.tests.ts` "a sign-in from a new device is told", "setting up the app, new backup codes, a backup code used, the app removed", "a passkey added and removed" | — |
| AS-14 | `auth/src/accountLifecycle.tests.ts` "five password attempts a minute from one address, then 429", "the 429 says how long to wait, within the window"; `auth/src/signInMethod.tests.ts` "wrong app codes while signed in lock the account, as at sign-in"; `web/src/lib/sign-in.test.tsx` "too many attempts says so (D11)" | — |
| AS-15 | `auth/src/accountLifecycle.tests.ts` "signing up again looks the same as a new sign-up", "accounts never verified are removed after the retention", "is an alert line in the log, without the address"; `web/src/lib/sign-in.test.tsx` "shows above the page it landed on, and sends a new link back to that page" | — |
| AS-16 | `auth/src/config.tests.ts` "a missing or bad setting stops it, naming every problem", "on-premises: SMTP, cookies secure only over https, the client IP from the reverse proxy", "cloud: SES with the task's role, cookies always secure, the client IP set at the edge" | — |

## Security releases

| ID | Proved by | Last run |
|---|---|---|
| SR-1 | `.build-kit/lib/security-audit.cjs` "no package-lock.json, so it can't be audited" (run by npm run security:audit) | — |
| SR-2 | `.build-kit/lib/security-audit.cjs` "not an exact version", "better-auth's packages aren't one version" | — |
| SR-3 | `.build-kit/lib/security-audit.cjs` "isn't an exact version" | — |
| SR-4 | `scripts/auth-image-check.mjs` "the sign-in image holds no test tooling", "better-auth loads in the sign-in image", "the sign-in image runs as the node user, not root" | — |
| SR-5 | `.build-kit/lib/security-audit.cjs` "what runs", "tooling"; `security/audit-exceptions.json` | — |
| SR-6 | `security/RELEASES.md` | — |
