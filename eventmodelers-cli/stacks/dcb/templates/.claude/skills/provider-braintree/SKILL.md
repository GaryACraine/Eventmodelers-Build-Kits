---
name: provider-braintree
description: Braintree (PayPal's card gateway) for an external automation built with build-automation. The SDK setup, how every Braintree answer and error is read (paid, a decline and its kind, a stall), never charging twice, and the mock and sandbox. Read it when an automation's description names Braintree.
---

# Braintree, for an external automation

`build-automation` holds what's true of every automation. This skill holds what's true of **Braintree**: read it before
writing the automation's `activities.ts`, its tests and `mocks/braintree/`. Decisions: ADR-034 (and ADR-036: for
selling digital products, a merchant of record's hosted checkout replaces all of this).

Checked against Braintree's Node SDK (`braintree` 3.40.0) and its **sandbox** (2026-09-29). Where they differ from
what you'd assume, this skill says so: follow it, not memory.

## The gateway, from the environment

```typescript
import braintree from "braintree"

/**
 * BRAINTREE_ENVIRONMENT "Sandbox" or "Production" uses Braintree's hosts; otherwise BRAINTREE_HOST and BRAINTREE_PORT
 * (default localhost:4010, the mock) over plain HTTP. BRAINTREE_TIMEOUT_MS (default 20000) is our deadline per call,
 * below the activity's 30 s startToCloseTimeout: the SDK's own is 60 s.
 */
export function braintreeGateway(env: NodeJS.ProcessEnv = process.env): braintree.BraintreeGateway {
    const named = env["BRAINTREE_ENVIRONMENT"]
    const environment =
        named === "Sandbox" || named === "Production"
            ? braintree.Environment[named]
            : new (braintree.Environment as any)(env["BRAINTREE_HOST"] ?? "localhost", env["BRAINTREE_PORT"] ?? "4010", "", false)
    const gateway = new braintree.BraintreeGateway({
        environment,
        merchantId: env["BRAINTREE_MERCHANT_ID"] ?? "mock-merchant",
        publicKey: env["BRAINTREE_PUBLIC_KEY"] ?? "mock-public-key",
        privateKey: env["BRAINTREE_PRIVATE_KEY"] ?? "mock-private-key"
    })
    // The constructor ignores a timeout; the config object is shared with the SDK's HTTP client
    ;(gateway as any).config.timeout = Number(env["BRAINTREE_TIMEOUT_MS"] ?? 20000)
    return gateway
}
```

- **The merchant account sets the currency**, not the sale. Pass `merchantAccountId` (`BRAINTREE_MERCHANT_ACCOUNT_ID`)
  on every sale; unset, the account's default is used (a sandbox made outside the UK may default to EUR).
- `package.json` needs `braintree`; if it's missing, block the job asking for `npm install braintree`.

## A card sale

The customer's page tokenises the card (Hosted Fields) into a single-use **nonce**, valid 3 hours; our server charges
it. There's **no card webhook**: the sale answers at once.

```typescript
const result = await gateway.transaction.sale({
    amount: "12.00",                        // a decimal string
    paymentMethodNonce: input.paymentMethodNonce,
    orderId: input.orderId,                 // our reference: what the search-first finds
    merchantAccountId,                      // the currency
    options: { submitForSettlement: true }
})
```

## Never charging twice

Braintree has **no idempotency key**. Combine its guards:

1. **Search first.** Before every sale, look for a transaction with our order id, and answer from it if found:
   ```typescript
   const stream = gateway.transaction.search(s => s.orderId().is(orderId)) as unknown as AsyncIterable<braintree.Transaction>
   ```
   A charged status (`authorized`, `submitted_for_settlement`, `settling`, `settlement_pending`, `settled`) is paid; a
   decline (other than a `duplicate` rejection) is that decline.
2. **A spent nonce is validation error `91564`** (the Transaction group's `PaymentMethodNonceConsumed`). **Not
   `93107`**, the PaymentMethod API's code, which a sale never returns. The SDK's types leave `ValidationErrorCodes`
   out: use the literal `"91564"`.
3. **Duplicate checking** (`gateway_rejected`, `duplicate`): the same card, order id and amount within the account's
   window (600 s in the restaurant's sandbox, 30 s by default).
4. A `duplicate` or `91564` means **look again, not decline**: our own earlier charge may not show in search yet. But
   **bound it**: if the search still finds nothing of ours on the 3rd attempt (Temporal's
   `Context.current().info.attempt`, injectable for tests), the nonce went on something else: decline, "payment method
   already used", kind `payment-method-unusable`.

## Reading the answer

The step returns a **business answer** and throws a **technical failure** (build-automation). The answers carry `kind`,
`code` and `card` for the failure event (ADR-032 decision 9):

| Braintree says | Answer | `kind` |
|---|---|---|
| `result.success` | paid | |
| `processor_declined` with `processorResponseType` `hard_declined` (e.g. 2004 Expired Card) | declined | `declined-hard` |
| `processor_declined`, `soft_declined` (2000 Do Not Honor, 2001 Insufficient Funds) | declined | `declined-soft` |
| `gateway_rejected` for `avs`, `cvv`, `avs_and_cvv`, `fraud`, `risk_threshold`, `three_d_secure`, `token_issuance` | declined | `declined-hard` |
| status `failed`, code **3000** ("Processor Network Unavailable") | declined: "card payments couldn't be completed, please try again". It **spends the nonce**, so only the customer can try again | `gateway-unavailable` |
| validation **91564**, nothing of ours found by the 3rd attempt | declined, "payment method already used" | `payment-method-unusable` |
| validation **91565** (unknown or expired nonce) | declined, "please enter your card again" | `payment-method-unusable` |

- `code` is `transaction.processorResponseCode` (or the validation code); the reason is `'Payment declined: ' +
  processorResponseText`.
- `card` is `transaction.creditCard.cardType + ' •••• ' + transaction.creditCard.last4` when there's a transaction.

## Reading the errors: retry or stall

Errors are the SDK's exceptions, by `err.name` (`http.js` maps the HTTP status). The categories are build-automation's
(ADR-032): a stall's `configuration`, `unavailable` or `unknown`.

| Error | Meaning | Throw |
|---|---|---|
| `tooManyRequestsError` (429), `serverError` (500), `serviceUnavailableError` (503), `gatewayTimeoutError` (504) | Braintree busy or down | retryable, type `unavailable` |
| `unexpectedError` "Unexpected request error…" / "Request timed out" | the network; **the charge may have gone through** (the search-first finds it) | retryable, type `unavailable` |
| `authenticationError` (401), `authorizationError` (403) | keys wrong or expired, or not permitted. **The sandbox's auth is flaky** (a wrong key sometimes accepted, good keys once refused), so retry first | retryable until attempt `PAYMENT_GATEWAY_AUTH_ATTEMPTS` (default 3), then **non-retryable**, type `configuration` |
| `upgradeRequired` (426) | the SDK is too old | non-retryable at once, type `configuration` |
| anything else | unknown | thrown as it is (a stall after the retries is `unknown`) |

Same behaviour in every environment: branching on sandbox vs production would leave the production path untested.

## The mock: `mocks/braintree/`

The SDK talks **XML over HTTP** (`Content-Type: application/xml`). Serve only the endpoints the step calls: the sale
(`POST /merchants/<id>/transactions`) and the search (`POST …/transactions/advanced_search_ids`, then
`…/advanced_search`). Read the exact request and response shapes in `node_modules/braintree/lib/braintree/`.

Answer as the sandbox does, so the model's scenarios run unchanged:
- **Test nonces:** `fake-valid-nonce` (paid), `fake-processor-declined-visa-nonce` (2000 Do Not Honor, soft); both
  reusable. **Any other nonce is single-use:** a second use is `91564`, recorded but left out of searches (it creates no
  transaction). An unknown nonce is `91565`.
- **Test amounts** decide the processor's answer: `2000.00`–`2999.99` decline with that code (2004 `hard_declined`,
  the rest `soft_declined` unless the sandbox table says otherwise), `3000.00` gives status `failed`, code 3000.
- **Duplicate checking:** the same amount, order and nonce within the window is `gateway_rejected`, `duplicate`.
- **Failure switches** for the outages the categories need: 401, 403, 426, 429, 500, 503, 504 (for example `POST
  /__mock/fail {"status":503,"times":2}`), so every row above can be reached in tests.
- Keep every sale, so a test can check a charge happened once.

## Braintree's sandbox

- Keys only in a **gitignored** env file (the restaurant's `e2e/.env.sandbox`), run with `node --env-file=…`. Never
  print or commit them.
- Check assumptions against the sandbox, not memory: the restaurant's `e2e/sandbox-probe.mjs` asks it every answer
  above. Run its wrong-key probes last: they disturb the next calls.
- The control panel's settings and where they are (merchant accounts, duplicate window, fraud rules, keys): the user
  manual, §21.7.
