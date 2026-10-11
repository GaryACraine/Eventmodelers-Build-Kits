# Security policies and evidence

Kept together from the start, so a security questionnaire, a customer's review or a certification (Cyber Essentials,
ISO 27001, SOC 2) can be answered from one place (ADR-056 D14).

| File | What |
|---|---|
| [POLICY.md](POLICY.md) | each policy in plain terms, with its setting and the decision behind it |
| [EVIDENCE.md](EVIDENCE.md) | each policy's tests (unit, end-to-end, by hand), and their last run |
| [results/](results/README.md) | the recorded runs, dated |
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
  ```

  Each writes `results/<date>-<name>.log`. End-to-end scripts are recorded the same way.
- **The check:** `npm run security:check` warns when a policy names no test, or a file or test it names doesn't
  exist (`--strict` makes a warning fail, for CI). It never blocks a commit.
