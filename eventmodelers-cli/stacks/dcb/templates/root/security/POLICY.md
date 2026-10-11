# Security policies

Each policy in plain terms, the setting that holds it, and where it was decided. What proves each one is in
[EVIDENCE.md](EVIDENCE.md), under the same id. The ADRs are the build kit's (`ADR.md` in the eventmodelers DCB kit).

These come with the kit: the sign-in service (`auth/`), the API's sign-in and permission check
(`src/shared/signIn.ts`, `src/shared/permissions.ts`) and the web app's sign-in screens (`web/src/lib/`). Add this
project's own policies below them, with ids that follow on, and their evidence as each lands.

## Access control

Who may call what. The model declares every endpoint and who may call it; the export writes the contract
(`api/openapi.json`), the role map (`api/roles.json`) and the catalogue of who may do what (`api/permissions.md`).

| ID | Policy | Setting | Decided in |
|---|---|---|---|
| AC-1 | **One issuer of identities.** Only the sign-in service signs people in. The API accepts a token only when the sign-in service's keys signed it, for its issuer and audience, and refuses every other token. When sign-in isn't configured, every token is refused rather than trusted | `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URL` | ADR-037, ADR-055 |
| AC-2 | **Who is calling comes from the token, never the request.** The signed-in person's id and email are read from the token; a value in the body or path can't change them | `session:` values in the model | ADR-055 part 2 |
| AC-3 | **No endpoint unless the model declares one, and the declaration says who may call it:** a permission, the caller's own data (`self`), anyone (`anonymous`), or another system's webhook. A route the code serves that the contract doesn't have fails the build's check | `--api`, `--intake` in the model; `api/openapi.json` | ADR-058 point 1 |
| AC-4 | **Permissions by role, per organisation.** A route with a permission runs only for a caller whose role in the organisation it names holds that permission, or whose platform role does. A caller with no role there gets 404, so it doesn't learn whether the organisation exists; one whose roles don't hold it gets 403 | `api/roles.json` (`emcli role …`); `requirePermission` | ADR-060 |
| AC-5 | **Deny by default.** With no role map, or no way to look up the caller's roles, every permission route refuses everyone | `api/roles.json`; the `RoleLookup` in `src/index.ts` | ADR-058, ADR-060 |
| AC-6 | **A `self` endpoint acts only on the caller's own data.** It needs a signed-in caller, and reads who they are from the token | `--api self` | ADR-058 point 1, ADR-055 part 2 |
| AC-7 | **Another system's webhook is proven by its signature.** A bad signature answers 401 and records nothing; a redelivery records nothing new | the system's secret (e.g. `PADDLE_WEBHOOK_SECRET`) | ADR-040, ADR-058 point 1 |
| AC-8 | **Browser requests come from our own sites.** The sign-in service refuses a cookie-carrying request from an origin it doesn't trust, and never redirects to one; the web app only returns to pages on its own site | `AUTH_TRUSTED_ORIGINS` | ADR-055 |

## Account security

How people sign in, and how their accounts are kept safe (ADR-056's decisions D1 to D15).

| ID | Policy | Setting | Decided in |
|---|---|---|---|
| AS-1 | **Every session records how it signed in,** and the API's token says so (`amr`). A session created any other way records nothing, so it passes no check | `auth/src/signInMethod.ts` | ADR-056 D1 |
| AS-2 | **A role's sign-in level is enforced by the API, by step-up.** Each role has a level: `second-factor` (an emailed code, the app or a passkey) or `not-by-email` (the app or a passkey, which survive a stolen inbox). A session weaker than the caller's roles need is answered 401 `insufficient_user_authentication` (RFC 9470), and the web app asks for the stronger factor, then sends the request again. The answer never says more than a 404 or 403 would | `emcli role sign-in <role> <level>`; `api/roles.json` | ADR-056 D1, D3 |
| AS-3 | **A password alone never signs anyone in.** Everyone has an emailed code from the moment their email is verified. A trusted device skips it for 30 days | `twoFactor` (OTP) | ADR-056 D2 |
| AS-4 | **Once someone has the app or a passkey, the inbox alone signs them in nowhere.** The emailed code is no longer offered | `auth/src/signInMethod.ts` | ADR-056 D4a |
| AS-5 | **Adding a factor doesn't strengthen the session that adds it.** Setting up the app doesn't step up until its next code; adding, removing or viewing a factor needs the strongest factor the person already has | `auth/src/signInMethod.ts` | ADR-056 (the spike) |
| AS-6 | **A passkey must check it's you** (biometric or PIN), so it counts as two factors. No magic links and no SMS | `@better-auth/passkey`, `userVerification: required` | ADR-056 D8 |
| AS-7 | **A step-up lasts 12 hours.** After that, the app or passkey is asked for again before an action that needs it | `AUTH_STEP_UP_HOURS` (12) | ADR-056 D15 |
| AS-8 | **A forgotten password:** an emailed link that works once, for an hour, and signs out every session. The answer is the same whether or not the address has an account. A reset doesn't skip the app or a passkey | `resetPasswordTokenExpiresIn` 3600; `revokeSessionsOnPasswordReset` | ADR-056 D4 |
| AS-9 | **Changing the password** needs the current one, signs out every other session, and is emailed | `changePassword`, other sessions revoked | ADR-056 D5 |
| AS-10 | **Changing the email** is confirmed at the old address, verified at the new one, and the old one is told. Our record of the address takes the new one from the token | `user.changeEmail` | ADR-056 D6 |
| AS-11 | **Passwords:** 12 to 128 characters, no composition rules, and passwords found in breaches refused (only the first 5 characters of a hash leave, to Have I Been Pwned) | `minPasswordLength` 12; `AUTH_BREACHED_PASSWORDS` (on) | ADR-056 D7 |
| AS-12 | **Sessions** last 7 days, refreshed daily; the API's token lasts 15 minutes. People see their sessions and can sign out everywhere | `session.expiresIn` 604800; `updateAge` 86400 | ADR-056 D9 |
| AS-13 | **Security notices by email:** the password changed or reset, the email changed (to the old address), a factor or passkey added or removed, a backup code used, a sign-in from a new device | `auth/src/accountChanges.ts` | ADR-056 D10 |
| AS-14 | **Abuse:** rate limits on every sign-in path, stricter on sign-in, sign-up, reset, codes and verification, with the wait shown; wrong codes lock the second factor for a while | `rateLimit.customRules` | ADR-056 D11 |
| AS-15 | **Signing up reveals nothing:** signing up again with an address looks the same as a new sign-up (its owner is emailed); accounts never verified are removed after 7 days; an email that can't be sent is an alert without the address; an expired link offers a new one | `AUTH_UNVERIFIED_RETENTION_DAYS` (7) | ADR-056 D12 |
| AS-16 | **A wrong setting stops the sign-in service** rather than running insecurely, naming every problem. Cookies are secure over https and always in the cloud; the client's address comes from the deployment's proxy | `auth/src/config.ts` | ADR-055, ADR-056 |
