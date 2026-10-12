# Security policies and evidence

Kept together from the start, so a security questionnaire, a customer's review or a certification (Cyber Essentials,
ISO 27001, SOC 2) can be answered from one place (ADR-056 D14).

| File | What |
|---|---|
| [POLICY.md](POLICY.md) | each policy in plain terms, with its setting and the decision behind it |
| [EVIDENCE.md](EVIDENCE.md) | each policy's tests (unit, end-to-end, by hand), and their last run |
| [results/](results/README.md) | the recorded runs, dated |
| [RELEASES.md](RELEASES.md) | each security release, and how long it took |
| [audit-exceptions.json](audit-exceptions.json) | advisories accepted for now, each with its reason and a date to look again |
| [../api/permissions.md](../api/permissions.md) | who may call each endpoint: the catalogue, written from the model at export |
| [../api/roles.json](../api/roles.json) | the role map: each role's permissions and sign-in level |
| [../api/openapi.json](../api/openapi.json) | the contract: every endpoint, with its security |

## Keeping it current

- **A new policy:** a row in POLICY.md with the next id, and a row in EVIDENCE.md naming the tests that prove it, in
  the same change as the code.
- **A run:** record it, then update the policy's "Last run" with the date, the result and a link:

  ```bash
  npm run security:record -- auth-tests -- npm --prefix auth test
  npm run security:record -- api-tests -- npm test -- src/shared
  npm run security:record -- web-tests -- npm --prefix web test
  npm run security:record -- audit -- npm run security:audit -- --strict
  npm run security:record -- auth-image -- node scripts/auth-image-check.mjs
  ```

  Each writes `results/<date>-<name>.log`. End-to-end scripts are recorded the same way.
- **The check:** `npm run security:check` warns when a policy names no test, or a file or test it names doesn't
  exist (`--strict` makes a warning fail, for CI). It never blocks a commit.
- **The audit (ADR-063):** `npm run security:audit` lists the known advisories in what runs and in the tooling, and
  warns when a package has no lockfile, the sign-in path isn't pinned in step, or an image isn't an exact version.
  `--strict` is the release gate: a warning, or a high or critical advisory in what runs, fails it. It needs the
  network. Run it daily, before every release and after every kit update.
- **An advisory with no fix,** or one that doesn't reach what runs, can be accepted in `audit-exceptions.json` with
  its reason and a review date. After that date it counts again.
