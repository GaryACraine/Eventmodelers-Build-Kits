# Security releases

Each release that ships a security fix, newest first, with how long it took (SR-6: critical within 2 days, high
within 7). The advisory's date is when it was published; "released" is when a release customers can install was
ready, and when our cloud had it. Customers are emailed at release, to the contact each one names.

How a fix gets here (ADR-063):

1. **Known:** `npm run security:audit` lists it (daily, before a release, after a kit update), or the library's own
   notice arrives first (Better Auth: a GitHub watch on its security advisories, and its monthly post).
2. **The kit first,** when it's in the kit's scaffold: the pinned version upgraded, the tests that guard the library's
   behaviour and the whole evidence re-run.
3. **This project:** `kit-drift`, `npm ci` in each package, the evidence re-run and recorded (`npm run
   security:record`), then `npm run security:audit -- --strict` passes.
4. **Released:** the images built, each digest recorded below; our cloud deployed; the release and its notes (what was
   fixed, the advisory, how urgent) sent to every on-premises customer. The sign-in service's migrations run before
   its new version starts (`auth-migrate`).

| Release | Advisory | Severity | Published | Released (cloud, on-premises) | Images (digests) |
|---|---|---|---|---|---|
| — | none yet | | | | |
