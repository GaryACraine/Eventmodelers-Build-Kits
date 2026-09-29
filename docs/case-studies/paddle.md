# Paddle: a working knowledge, for selling a web app by seats (PLAN 16.1)

> **Status: desk research, 2026-09-29.** Taken from Paddle's developer docs (sources at the end). Everything marked
> **to verify** is checked in the sandbox once Gary's accounts exist, and the results are added here. Decisions go in
> ADRs (ADR-036 chose Paddle); this note is what we know about Paddle.

**Why this note.** The licensing model is ours: customers, subscriptions, seats, assignments and access (PLAN
Phase 16). Paddle is an outside system that takes the money, the tax and the declines. In the model it's an
automation (a call to Paddle) and translations (its webhooks become our events). This note says what Paddle can
and can't do, so the model asks it for the right things.

## 1. Accounts and onboarding

- **Two separate accounts.**
  - **Sandbox** at `sandbox-vendors.paddle.com`: its own signup, no website or checkout approval, test cards.
  - **Live** at `vendors.paddle.com`: needs Paddle's review (the business, the product, the website).
- **Isle of Man:** Paddle serves sellers everywhere except a sanctions list, and the Isle of Man isn't on it
  (ADR-036).
- **Conditions to confirm in onboarding** (ADR-036):
  - that Gary's business and product are accepted;
  - the fee at his price point (5% + 50¢ published; the fixed 50¢ weighs on small amounts);
  - payout in GBP to an Isle of Man bank.
- **Before a checkout can open:** set a **default payment link** (Checkout settings), which Paddle uses for its
  payment and subscription links. `https://localhost/` will do in the sandbox.
- **Catalog:** "everything you offer is a product". Plans, add-ons and one-time charges each have prices; "additional
  seats" can be a product of its own, or the quantity of a plan's price (to decide in 16.3).
- **Keys:**
  - API keys, server side: sandbox keys contain `_sdbx`, and the API is at `sandbox-api.paddle.com`;
  - a **client-side token** for Paddle.js, prefixed `test_` in the sandbox;
  - a **webhook secret** for each notification destination.

## 2. Checkout (the buyer's side)

- **Paddle.js** (`@paddle/paddle-js`, typed) runs in the browser, so it works in our Vite React SPA. The official
  Next.js starter is a reference only (ADR-036).
- **Opening it:** `Paddle.Initialize({ token, eventCallback })`, then:

  ```js
  Paddle.Checkout.open({
    items: [{ priceId, quantity }],
    customer: { email, address, business },
    customData: { … },
    discountCode,
    settings: { displayMode, successUrl, … }
  })
  ```

  `displayMode` is `overlay` (a modal) or `inline` (inside our page). The `variant` is `multi-page`, `one-page` or
  `express`.
- **Seats at checkout:** the quantity is set by **our page**. There's no checkout setting that lets the buyer change
  it inside Paddle's form; the page changes it with `Paddle.Checkout.updateItems()`. So the seat picker is our UI,
  and Paddle shows the price. **To verify:** how the inline checkout shows the quantity and per-seat totals.
- **Our reference travels with the purchase.** `customData` passed at checkout is kept on the transaction, and
  **copied onto the subscription** when it's created. Our organisation's id goes there, which ties every later
  webhook to our records.
- **Our pricing page** can show Paddle's localised prices (the visitor's currency, with estimated tax) through
  `Paddle.PricePreview()`, so the page never hard-codes a price.
- **Business buyers:** `customer.business` (name, tax id) lets a company buy with its VAT number.
- **The page's events** come through `eventCallback`, e.g. `checkout.completed` and `checkout.payment.failed`.
  They're for the page only. **Access is granted from webhooks, never from the page's event.**
- **Declines, 3D Secure and trying another card** all happen inside Paddle's checkout. We build none of it.

## 3. Prices and seats

- **Product** (`pro_…`), and its **prices** (`pri_…`). A price has:
  - `unit_price` (an amount in the lowest unit, and a currency);
  - `billing_cycle` (`interval` day | week | month | year, and a `frequency`);
  - optionally a `trial_period` (`requires_payment_method` defaults to true);
  - `tax_mode`;
  - per-country overrides.
- **Per-seat pricing is a quantity on a subscription item:** price × quantity.
- **Quantity limits per price:** `quantity.minimum` 1 and `quantity.maximum` 100 by default (up to 999,999,999). Set
  the maximum deliberately, or a customer can't buy more than 100 seats.
- Every recurring item on one subscription shares the same billing interval: monthly and annual prices can't be
  mixed.

## 4. Changing a subscription

- **Seats up or down:** `PATCH /subscriptions/{id}` with the full `items` list (each `price_id` and `quantity`) and a
  `proration_billing_mode`:
  - `prorated_immediately`: bill or credit the difference now;
  - `prorated_next_billing_period`: settle it on the next renewal;
  - `full_immediately`, and others (**to verify** the full list).
- **Preview first:** `PATCH /subscriptions/{id}/preview` returns `immediate_transaction`, `next_transaction` and
  `recurring_transaction_details`. So our screen can show "adding 3 seats costs £X now", before the customer
  confirms.
- An immediate charge that fails: `on_payment_failure` defaults to `prevent_change`, so the seats aren't added.
- **Not allowed:**
  - while the subscription is `past_due`;
  - within 30 minutes of the next billing date;
  - during a trial, for the quantity (reported; **to verify**).
- **Webhooks:** `subscription.updated`; `adjustment.created` for an immediate proration; `transaction.created` when it
  bills now.
- **Cancel:** `POST /subscriptions/{id}/cancel`, with `effective_from` `next_billing_period` (the default: a
  `scheduled_change`, status stays `active` until then) or `immediately`.
  - A scheduled cancel is undone with `PATCH` `scheduled_change: null`.
  - **A canceled subscription can't be reinstated.** The customer subscribes again.
- **Pause and resume** exist (`subscription.paused` and `subscription.resumed`). **To verify:** the API and its
  options.

## 5. The customer portal (hosted by Paddle)

- **Can:**
  - past payments and invoices;
  - update the payment method;
  - view subscriptions;
  - cancel (with a retention flow).
- **Opening it:** by magic link, or an authenticated session created by our backend (the portal session API).
  Deep links: `overview`, and per subscription `view_subscription`, `cancel_subscription` and
  `update_subscription_payment_method`.
- **Can't: change seats or plan.** There's no portal deep link or documented form for it. **Seat changes are our
  screen**, using the preview and update API above. **To verify** in the sandbox.
- It's a hosted page, not embeddable: we link to it.

## 6. Lifecycle and access

- **Statuses:**
  - `trialing`;
  - `active`;
  - `past_due` (a renewal failed, and payment recovery is running);
  - `paused`;
  - `canceled`.
- A scheduled change moves the status on its `effective_at` date.
- **Paddle's guidance on access:**
  - grant it on `subscription.created`;
  - restrict it on `subscription.paused` and `subscription.past_due`;
  - remove it on `subscription.canceled`;
  - elsewhere: full access while `trialing`, `active` or `past_due`.

  The two conflict for `past_due`. **Access during `past_due` is our business decision**, for 16.2 and 16.3.
- **Failed renewals** (payment recovery, part of Paddle Retain):
  - retried **7 times over 30 days** by default; with Retain, "tactical retries" and up to 4 emails (days 1, 3, 5
    and 7), and an in-app prompt;
  - at the end, **pause or cancel** (our setting);
  - Retain works **only in live accounts**.

## 7. Webhooks (the translations' input)

- **Events** (entity.action). The ones the licensing model needs:
  - `subscription.created`, `activated`, `trialing`, `updated`, `past_due`, `paused`, `resumed`, `canceled`;
  - `transaction.completed`, `payment_failed`, `past_due`;
  - `customer.created` and `updated`;
  - `adjustment.created` (refunds and credits).
- **One purchase, in the order Paddle creates things** (from its quickstart; delivery order still isn't guaranteed):
  1. `transaction.created`: the checkout opens a transaction and updates it as the buyer goes;
  2. `customer.created`: the email is entered;
  3. `address.created`: the country and postal code;
  4. `business.created`: only if a tax or VAT number is entered;
  5. `transaction.paid`: **the payment went through; provisioning can start**;
  6. `subscription.created`: for recurring items, `active` or `trialing`;
  7. `transaction.completed`: invoice number, fees and payouts added.
- **The envelope:** `event_id`, `event_type`, `occurred_at`, `notification_id`, and `data` (the whole entity as it
  now stands).
- **Signature:** the `Paddle-Signature` header is `ts=<unix>;h1=<hex>`. `h1` is the HMAC-SHA256 of `ts + ":" + raw
  body` with the destination's secret. Verify against the **raw** body, unparsed. The SDKs allow 5 seconds between
  `ts` and now. The Node SDK's `paddle.webhooks.unmarshal(rawBody, secret, signature)` does it all.
- **Delivery:**
  - answer **200 within 5 seconds** (record first, work later);
  - failures are retried **60 times over 3 days** live (20 in the first hour), and **3 times in 15 minutes** in the
    sandbox;
  - notifications can be replayed for 90 days.
- **Not in order, and possibly more than once.** Paddle says so. So:
  - **ignore a repeat by `event_id`** (our idempotency key);
  - **compare `occurred_at`**: an older event must not overwrite a newer state.
- **Notification destinations** have a usage type. **Platform** (or both) receives real events; *simulation* only
  receives the simulator's. **Hookdeck Console** shows webhooks with no endpoint of our own, which is handy for a
  first look.
- **A webhook simulator** (with scenario configuration) sends sample events to a destination, for tests.

## 8. What this means for our model (input to 16.2 and 16.3)

- **Ours:**
  - the organisation (the buyer);
  - its members and invitations;
  - seat assignment within the paid quantity;
  - access decisions.
- **Paddle's:** the money: checkout, charges, tax, invoices, failed renewals, cancellation.
- **Each Paddle webhook becomes a translation slice:** verify the signature, ignore a repeat by `event_id`, skip it
  if older than what we know (`occurred_at`), and record **our** event named for the business. For example,
  `subscription.created` becomes *Subscription Started*, and `subscription.updated` with a new quantity becomes
  *Seats Changed*. This is PLAN 16.4's kit work.
- **Changing seats from our side** is a command (*Change Seats*) whose automation calls Paddle's update (after a
  preview on the screen). Paddle's `subscription.updated` then confirms it, as a translation. The seat count we
  enforce is the one Paddle confirms, so a charge that fails (`prevent_change`) never gives seats away.
- **Correlation:** our organisation's id in `customData` at checkout, so every subscription webhook names the
  organisation.
- **Access during `past_due`, a trial's length, and what cancel means for assigned seats** are business decisions for
  16.2 and 16.3, not Paddle's.

## 9. To verify in the sandbox

- [ ] Signup and keys: sandbox API key, client-side token, webhook destination (usage type platform) and secret;
      the default payment link set.
- [ ] A per-seat monthly price (quantity maximum raised); checkout, overlay and inline, with the quantity set by our
      page; `customData` on the resulting subscription.
- [ ] The webhooks of one purchase, in the order they arrive, with their payloads kept as fixtures.
- [ ] Preview and update the quantity: both proration modes, and the declined card on an immediate charge.
- [ ] The customer portal: confirm there's no seat change, and what cancelling from it sends.
- [ ] Cancel at the period's end, undo it, then cancel immediately.
- [ ] A declined renewal: what the sandbox can simulate, given Retain is live-only.
- [ ] Trials: with and without a payment method, and changing the quantity during one.
- [ ] Out-of-order and repeated delivery (the simulator, or replay).

## 10. For onboarding (Gary)

- [ ] Live account review: the business in the Isle of Man, the web app, the website's pricing and terms pages.
- [ ] The fee at the intended seat price.
- [ ] Payout currency (GBP) and bank.
- [ ] Anything Paddle asks of a seat-based SaaS (refund policy, terms) that the model or the site must provide.

## Tools Paddle offers for working with an AI assistant

- the **Paddle MCP server** (its API: catalog, customers, subscriptions), to drive the sandbox in experiments;
- the **docs MCP server**, and the docs index at <https://developer.paddle.com/llms.txt>, so the `provider-paddle`
  skill (PLAN 16.5) can point to the docs instead of copying them.

Installing either is Gary's decision. The API server is pointed at the sandbox only.

## Sources

- Quickstart (sandbox, catalog, pricing page, checkout, webhooks): <https://developer.paddle.com/get-started/quickstart>

- Overlay checkout: <https://developer.paddle.com/build/checkout/build-overlay-checkout>
- `Paddle.Checkout.open`: <https://developer.paddle.com/paddlejs/methods/paddle-checkout-open>
- Create a price: <https://developer.paddle.com/api-reference/prices/create-price>
- Change subscription items: <https://developer.paddle.com/build/subscriptions/add-remove-products-prices-addons>
- Cancel subscriptions: <https://developer.paddle.com/build/subscriptions/cancel-subscriptions>
- Customer portal: <https://developer.paddle.com/concepts/customer-portal>, portal sessions:
  <https://developer.paddle.com/api-reference/customer-portals/create-customer-portal-session>
- Provision access: <https://developer.paddle.com/build/subscriptions/provision-access-webhooks/>
- Custom data: <https://developer.paddle.com/build/transactions/custom-data>
- Payment recovery: <https://developer.paddle.com/build/lifecycle/subscription-renewal-dunning>
- Webhooks: <https://developer.paddle.com/webhooks/overview>, signatures:
  <https://developer.paddle.com/webhooks/signature-verification>, delivery:
  <https://developer.paddle.com/webhooks/respond-to-webhooks>
- Sandbox: <https://developer.paddle.com/build/tools/sandbox>
