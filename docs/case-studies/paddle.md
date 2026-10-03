# Paddle: a working knowledge, for selling a web app by seats (PLAN 16.1)

> **Status: desk research, then sandbox results (§11), 2026-09-29.** Taken from Paddle's developer docs (sources at the end). Everything marked
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
- **Seen for real through a tunnel** (2026-10-03, `licensing/e2e/paddle/README.md`):
  - a delivery carries exactly the stream's event (same `event_id`, same `data`) plus a `notification_id`;
  - delivered **0.7 s** after `occurred_at`; in the stream within **2 s** of the change;
  - `POST /notifications/{id}/replay` redelivers the same `event_id` under a new `notification_id`, about a minute
    later;
  - a failed delivery became `needs_retry`, retried after about 20 s and again about a minute after the first, then
    delivered (`times_attempted: 3`);
  - three changes a second apart were delivered in order.
  - A destination is created and changed through the API (`/notification-settings`): its `endpoint_secret_key` comes
    back on creation, and `active: false` pauses it.

### 7b. The event stream: the same events, pulled (2026-10-02, ADR-041)

Paddle keeps every event that occurred and lets us read them: `GET /events` ("the event stream").

- **From the API reference:**
  - events of the **last 90 days**; older ones aren't retained;
  - each is `event_id`, `event_type`, `occurred_at`, `data`: the webhook's envelope, with the same `evt_…` id;
  - `order_by=id[ASC]`, and `after=<event_id>` returns the events after that one, so **the last event id is a
    checkpoint**; up to 200 per page;
  - filters: `event_type` (a list), `filter` (a Paddle id, such as a subscription's), `from` and `to`;
  - it needs the `notification.read` permission.
- **Read in the sandbox** (read-only):
  - 156 events are there, although **the sandbox has no notification destination**: the stream doesn't depend on
    webhooks being set up or delivered. (*Corrected 2026-10-02: first recorded as 1,850, which was Paddle's
    `estimated_total`. Paging through the whole stream counted 156. The estimate isn't reliable.*);
  - paging with `after` works as described;
  - across our 42 subscription and transaction events, **ascending id order was also `occurred_at` order** (none
    out of order). The ids look time-ordered. Paddle doesn't document that as a guarantee.
- **Deliveries can be inspected too:** `GET /notifications` filters by `status` (`delivered`, `failed`,
  `needs_retry`, `not_attempted`), destination and time, and a failed or delivered one can be replayed.
- **Rate limit:** 240 requests a minute per IP address; past it, 429 with `Retry-After`.
- **Not answered by the documentation:** what happens to a destination that keeps failing (whether Paddle disables
  it, and whether we're told).
- **Still to verify, with a destination set up:** that a delivered webhook's `event_id` is the stream's; how soon
  after it happens an event is in the stream.

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

Results in §11. What's left is scheduled: the lifecycle in PLAN 16.2b, webhook delivery in PLAN 16.4.

- [x] Signup and keys: sandbox API key, client-side token, the default payment link set (§11, setup lessons).
      *The webhook destination and its secret: moved to 16.4.*
- [x] A per-seat monthly price (quantity maximum raised); checkout with the quantity set by our page; `customData`
      on the resulting subscription (§11). *Overlay only; the inline checkout is 16.5's.*
- [x] The webhooks of one purchase, in the order they arrive (§11). *Their payloads kept as fixtures: moved to 16.4.*
- [x] Preview and update the quantity: every proration mode previewed, increase and decrease applied (§11).
      *The declined card on an immediate charge: moved to 16.2b.*
- [x] The customer portal: confirmed there's no seat change (§11). *What cancelling from it sends: moved to 16.2b.*
- [x] Cancel at the period's end, and undo it (§11). *Cancel immediately: moved to 16.2b.*
- [ ] A declined renewal: what the sandbox can simulate, given Retain is live-only. *16.2b.*
- [ ] Trials: with and without a payment method, and changing the quantity during one. *16.2b.*
- [ ] Out-of-order and repeated delivery (the simulator, or replay). *16.4.*

## 11. Sandbox results (2026-09-29, through the Paddle plugin's sandbox API and a test card)

The setup: a product "Team (per seat)" (`tax_category: saas`), with prices of £10 per seat monthly and £100 per seat
yearly (placeholders), and quantity 1 to 1,000. A customer (a UK business) with `custom_data.organisationId =
org-test-1`. Checkout opened from a local page (`paddle-sandbox/checkout.html`, which loads Paddle.js with the
sandbox client-side token and calls `Paddle.Checkout.open({ transactionId })`), paid with 4242… for 5 seats.

**Setup lessons**
- **The default payment link** must be set before *any* transaction, even an invoiced one. The dashboard refused
  `https://localhost/`, despite Paddle's docs saying it's fine in the sandbox; `https://crainelabs.ai/` was accepted.
  That link only builds the URLs Paddle generates (`checkout.url` is `<link>?_ptxn=txn_…`), and the page there must
  run Paddle.js. Our own pages open checkouts directly with `Paddle.Checkout.open`, on localhost too.
- **Invoiced (manual) collection** refused every address ("must be suitable for the transaction's collection
  mode"), even a full London one. We don't need it: our buyers pay by card.
- **The Isle of Man** has its own country code, `IM`, which matters for addresses and tax.
- On macOS, a local page server needs Python allowed through the firewall dialog.

**Prices and tax**
- `tax_mode` came back `location`: for a UK buyer the £10 **includes VAT**. 5 seats cost £50.00, of which VAT is
  £8.33, **Paddle's fee £2.88**, and **our earnings £38.79**. So the fee is about 6.9% of the £41.67 net, more than
  the headline 5% + 50¢. Check it at the real seat price (ADR-036's condition).

**One purchase's webhooks, in the order they happened**
1. `transaction.created` and `transaction.ready`: 5 seats, £50, `organisationId` on it;
2. `address.created`: the checkout took the buyer's address again, as a new address;
3. `transaction.updated` (paid), then `transaction.paid`;
4. `subscription.activated` **and** `subscription.created`: active, 5 seats, **`custom_data.organisationId` copied
   onto the subscription**, next billed a month later. **Both have the same `occurred_at`**, to the microsecond;
5. `transaction.updated` (linked to the subscription; fee and earnings added), then `transaction.updated`
   (completed), then `transaction.completed`.

So:
- **ordering by `occurred_at` needs a tie-break**: order by (`occurred_at`, `event_id`), since event ids increase in
  time order;
- **every change fires a generic `*.updated` beside the specific event**: listen to the specific ones.

**Changing seats**
- **Proration modes:** `prorated_immediately`, `prorated_next_billing_period`, `full_immediately`,
  `full_next_billing_period` and `do_not_bill`.
- **Preview**, for 5 to 8 seats a few minutes into the period:
  - an immediate mode charges £30.00 now;
  - a next-period mode adds £30.00 to the renewal (£110 instead of £80);
  - `do_not_bill` gives the seats until renewal.

  `update_summary` gives the credit, the charge and the result (`charge` or `credit`, with the amount), which is
  exactly what our confirm screen shows.
- **Increase applied** (5 to 8, `prorated_immediately`):
  - a new transaction, `origin: subscription_update`, for 3 seats at a proration rate of 0.99998, went created,
    billed, paid, completed;
  - `subscription.updated` (8 seats) arrived with the payment;
  - the API call returned only after the charge succeeded, so a change we make is confirmed when the call returns.
- **Decrease applied** (8 to 6):
  - a transaction for −2 seats (−£20.00), then `subscription.updated` (6 seats);
  - **no refund to the card: £20.00 goes on the customer's credit balance** (`available`), which Paddle spends on
    later renewals;
  - no adjustment is created.

**Cancelling**
- `cancel` with `next_billing_period` leaves the status `active`, sets `scheduled_change: { action: "cancel",
  effective_at }`, and clears `next_billed_at`.
- **The only webhook is `subscription.updated`**; there's no "cancel scheduled" event, so our translation reads
  `scheduled_change`.
- Undoing it (`scheduled_change: null`) restores `next_billed_at`.

**The customer portal links**
- A subscription carries `management_urls` (`update_payment_method`, `view_subscription`, `cancel`): signed links
  with a customer token that lasts about 24 hours.
- **Mint them when needed; never store or log them.**

**A declined card at checkout** (`4000 0000 0000 0002`, 1 seat)
- The buyer saw "This payment was declined by your bank. Please try again, or use a different payment method…",
  and stayed in the checkout to retry.
- Paddle recorded the attempt on the transaction (`payments[]`: `status: error`, `error_code: declined`, Visa
  •••• 0002) and sent **`transaction.payment_failed`**.
- The transaction stayed `ready`, payable again, and **no subscription was created**.
- **So a decline at checkout needs nothing from us:** no subscription, no seats, no access. The restaurant's
  decline kinds, paying again and the card component are all Paddle's job here.
  `transaction.payment_failed` could at most feed a report of abandoned checkouts.

**The customer portal, seen by Gary**
- **It offers only cancel and update the payment method. The seat quantity is fixed; there's no way to change it
  there.** (The API's description says customers can make "changes", but not to seats.)
- **Confirmed: changing seats is our own screen**, through the preview and update API.
- **From Gary's screenshot of the portal:**
  - it's branded with the vendor's name ("Craine Labs Limited");
  - the next payment shows the credit applied: 6 seats at £60.00 including VAT (£50.00 + £10.00 at 20%), less
    £20.00 credit, so **£40.00 due at renewal**;
  - the payments list calls the mid-month seat changes **"Renewal"**: the £30.00 increase, and the decrease as a
    £0.00 "Paid" renewal. That's confusing, so our own screen should explain seat changes and their cost in our
    words;
  - the only actions are "Update payment method" and "Cancel subscription".

**VAT (Gary is not VAT-registered)**
- As merchant of record, **Paddle is the seller**: it charges VAT, GST and sales tax wherever the law requires,
  whatever the vendor's registration. That can't be turned off, and it isn't the vendor's charge (Paddle's help:
  "How Paddle handles VAT on your behalf").
- **The vendor chooses `tax_mode` per price:**
  - `external`: tax added on top, so the buyer sees £10 + VAT and our net stays £10;
  - `internal`: tax included, so the buyer pays £10 and our net is £8.33 in the UK;
  - `location`: follows each country's custom, and gave VAT-included in the UK.
- **Business buyers:** an EU business with a valid VAT number isn't charged VAT (the reverse charge). A UK business
  pays UK VAT and normally reclaims it. So for B2B seats, "ex VAT" prices (`external`) are the usual and more
  competitive display. A pricing decision for 16.3.
- **The vendor's own VAT status** matters for how it invoices Paddle for payouts (Paddle's help: "Should I charge
  Paddle VAT/tax for payouts?"). That's a question for an accountant, not the model.
- **What the vendor keeps depends on `tax_mode`:**

  | Price setting (`tax_mode`) | UK customer pays for a "£10" seat | Vendor receives (before Paddle's fee) |
  |---|---|---|
  | `external` (tax on top) | £10 + £2 VAT = £12 | £10 |
  | `internal` (tax included) | £10 | £8.33 |

  The VAT goes from the customer to Paddle to the tax authority. It never passes through the vendor, so the
  vendor's VAT registration doesn't affect it, and there's nothing for the vendor to reclaim.
- **Recommended for B2B seats: `external`, advertised "excl. VAT"** ("£10 per seat per month, excluding VAT").
  - An EU business with a VAT number pays no VAT (the reverse charge), and a UK VAT-registered business reclaims it.
  - Show "excl. VAT" beside every price, or show the visitor's own total with `Paddle.PricePreview()`. Paddle's
    checkout shows the tax as its own line.
  - For consumers, UK rules expect VAT-inclusive display: use `internal`, or show the inclusive figure.
  - To confirm with an accountant.
- **Applied in the sandbox (Gary, 2026-09-29):**
  - both seat prices switched to `external` (`prices.update`);
  - Paddle's pricing preview for 5 seats to a UK buyer now gives **£50.00 + £10.00 VAT = £60.00** (before: £50.00
    including £8.33 VAT);
  - still to check: whether the existing test subscription, bought under `location`, renews on the new basis.

### 11b. The lifecycle (PLAN 16.2b, 2026-09-30)

**The setup:**
- Products **"Web seat (admin)"** (£10) and **"Mobile seat (engineer)"** (£5), monthly, `external` tax, 1 to 1,000 each
  (ADR-037's seat types).
- Test organisations:
  - `org-test-2`: 2 web seats, paid at checkout with Paddle's "success then decline" card `4000 0027 6000 3184`;
  - `org-test-3`: a 14-day cardless trial, made through the API;
  - `org-test-4`: a trial with both seat types;
  - `org-test-5`: a one-day trial with a card, 1 web and 2 mobile seats.
- **Tools:**
  - `subscriptions.update({ next_billed_at })` brings a renewal forward, but **at least 30 minutes ahead** ("new
    next_billed_at needs to be 30m0s from now");
  - `events.list` is the event stream: every webhook Paddle would send, readable with no destination set up.

**Two seat types on one subscription**
- **Web seats only, then mobile seats added later:** both work. Adding the mobile item is a normal update. With
  `prorated_immediately` it charged 3 × £5 for the rest of the month (£14.99 + £3.00 VAT = £17.99), for the new item
  only.
- **A price can't have a minimum of 0** ("Invalid request"), so every item on a subscription has at least 1 seat. To
  have no mobile seats, leave the item off.
- **Paddle's checkout shows each line's total with VAT** ("£12.00/month" for 2 mobile seats), not the price per
  seat. It also lets the buyer change the numbers with + and −, and **remove the web item with a bin icon**. So our
  page chooses the seats, and we must lock the numbers in Paddle's checkout or check them when the purchase arrives
  (ADR-037: at least one web seat). For `provider-paddle` (16.5).

**A declined card when adding seats** (`prorated_immediately`, the default `on_payment_failure: prevent_change`)
- The API call fails ("payment declined"), and **the subscription keeps its seats**.
- A transaction for the charge is left `past_due` (`transaction.payment_failed`, `transaction.past_due`), and
  **Paddle cancels it by itself about 45 seconds later** (`transaction.canceled`). Nothing is left to retry, and the
  subscription stays `active`.
- The error code was `authentication_failed`: this test card fails later charges by asking for 3D Secure, which
  can't happen without the customer present. The card also asked for 3D Secure at checkout.

**A failed renewal, and recovery**
1. At the renewal, `subscription.updated` (still `active`): **the period moves on first**.
2. `transaction.created` and `transaction.billed` (`origin: subscription_recurring`), then
   `transaction.payment_failed` and `transaction.past_due`.
3. `subscription.updated` **and** `subscription.past_due`, with the same `occurred_at`.
- **While `past_due`, Paddle refuses any change:** "cannot update subscription, as the subscription status is
  'past_due'". ADR-037's rule of no seat changes while payment is overdue matches Paddle's own.
- **Recovery:** `subscriptions.updatePaymentMethodTransaction.get` returns the unpaid renewal. Paid through Paddle.js
  with a good card, it sent `transaction.paid`, then `subscription.activated` **and** `subscription.updated`
  (`active`), then `transaction.completed`. **There's no "recovered" event.** Our translation reads
  `subscription.activated` after `past_due` as "payment recovered".
- **Payment Recovery's settings** (the retry window, and pause or cancel at the end) **aren't in the sandbox.** Retain
  there has only Cancellation Flows, and Checkout Settings' "Recovery" is for abandoned checkouts. So ADR-037's
  14-day window is checked in the live dashboard (§10).

**Trials**
- **Cardless** (`requires_payment_method: false`): our backend creates a transaction with `status: "billed"`. Paddle
  completes it at £0 and creates a `trialing` subscription. There's no `next_billed_at` until a card is added.
  `subscriptions.activate` is refused without a card.
- **With a card** (the choice in ADR-037 decision 6): the checkout shows "1 day free trial", £0.00 today, the amount
  due on the end date, and "Cancel anytime". Events: `subscription.created` and `subscription.trialing`, together.
- **Seats during a trial:** a quantity change works only with `do_not_bill` (any other mode is refused). **Items
  can't be added or removed** ("You can't add or remove items for a subscription in trial"), and **every item must
  share the same trial period** ("prices that have differing trial period intervals"). So a trial starts with both
  seat types, each price having its own trial version.
- **A trial ending** (`org-test-5`, watched 2026-10-01; web changed 1 → 2 during the trial):
  - **The first bill is for the seats held at the end:** **£36** (£30 + £6 VAT), one transaction with both items (web
    2 × £10, mobile 2 × £5), not the £24 the checkout showed. It pays for the first month after the trial, in advance
    (period 2026-10-01 → 2026-11-01).
  - **It's charged about 46 seconds after the trial ends** (14:51:16 → billed 14:52:02). The status goes `trialing`
    → `active`.
  - **The events, in order:**
    1. `subscription.activated` and `subscription.updated`, at the same `occurred_at`;
    2. `transaction.created` and `transaction.billed`;
    3. `transaction.paid`, then `transaction.updated`;
    4. `transaction.completed`.

    The transaction's origin is `subscription_recurring`, the same as every later renewal.
  - **For the translations: neither event says "trial converted".**
    - `subscription.activated` is the same event as a recovery after `past_due`.
    - `transaction.completed` (`subscription_recurring`) is the same as a renewal.

    So the translation decides from **our own state**: an organisation that's trialing → `trialWasConverted`; one
    whose renewal payment failed → `renewalPaymentWasRecovered`; otherwise → `subscriptionWasRenewed`. The
    subscription's previous status isn't in the payload.

**Cancelling**
- **From the customer portal:** only a confirm dialog, with no reason asked and no offer, because no Cancellation Flow
  is set up (Retain has them, in the sandbox too). It cancels **at the period's end**: `scheduled_change: cancel`,
  status `active`, and only `subscription.updated`, the same as through the API. Undone with `scheduled_change: null`.
- **Immediately:** `subscription.canceled` and `subscription.updated`, together. **No refund and no credit**, even
  for a month charged minutes before.

**Pause and resume**
- **Pause immediately:** `subscription.paused` and `subscription.updated`, together. The status is `paused`, with no
  `next_billed_at`.
- **Resume immediately** (the default, `start_new_billing_period`): `subscription.resumed` and `subscription.updated`,
  then **a full new month charged at once** (£42), **with no credit for the unused paid period**. To keep the paid
  period, use `on_resume: continue_existing_billing_period`. ADR-037 doesn't offer pausing.

**What the webhooks mean for the translations** (16.4)
- **`subscription.created` can be missing.** None ever came for `org-test-2`'s checkout purchase, the only one paid
  with a card that asked for 3D Secure; `subscription.activated` did. Every other subscription got both. So treat
  whichever of `created` and `activated` arrives first as the purchase being confirmed.
  **2026-10-02: it's the checkout, not the card.** `org-test-6`'s trial, started at Paddle's checkout from our page
  with an ordinary test card, sent `subscription.trialing` and no `created` either. The subscriptions that got
  `created` were all made through the API. So a start is `trialing`, `activated` or `created`, whichever arrives
  first (§11c).
- **Paddle often sends a specific event and `subscription.updated` with the same `occurred_at`:** activated,
  past_due, paused, resumed and canceled all do. Order by (`occurred_at`, `event_id`) and listen to the specific one.
  A scheduled cancel comes only as `subscription.updated`, so read `scheduled_change` there.
- **`subscriptions.history.list` failed** ("URL called is invalid") through the plugin.

**Still to try**
- The renewal of `org-test-1` (2026-10-29) after the switch to `tax_mode: external`.
- The webhook destination, with payloads kept as fixtures, and repeated and out-of-order delivery (PLAN 16.4).

### 11c. Paddle.js from our page, and the calls we make (PLAN 16.5, 2026-10-02)

**Paddle.js** (`@paddle/paddle-js` 1.6.5, opened from a page on `localhost`, ADR-044):
- `Paddle.Checkout.open({ items, customData, customer: { email }, settings: { displayMode: "overlay" } })` opened
  the overlay with both trial items, "1 day free trial", £0.00 due today and the amount due on the trial's end date.
  Passing the email skips asking for it and creates the customer at once (`checkout.customer.created`).
- A draft transaction exists at Paddle as soon as the overlay loads, carrying our `organisationId`.
- **Its events:** the first has no `name`; then `checkout.loaded` and `checkout.customer.created`. By Paddle.js's
  types, `checkout.completed` carries the transaction as `data.transaction_id` (not yet seen: see below).
- **A price that doesn't exist:** `checkout.error` with `type: "api_error"`, `code: "validation"` and a `detail`.
  Closing the overlay afterwards sends `checkout.closed`.
- **The buyer can change the numbers and remove an item** in the overlay (+, −, a bin icon on each item), seen here
  when opened with `items`. `CheckoutSettings` has no setting to lock them.
- **Paid by hand** (Gary, card 4242…; browser automation can't type into Paddle's frame). Paddle's events for it, in
  order: `transaction.created` (draft, when the overlay loaded), `address.created`, `transaction.updated` and
  `transaction.ready`, `transaction.updated` and `transaction.paid`, **`subscription.trialing`**,
  `transaction.updated` and `transaction.completed`. All within a second of the payment, and in the event stream
  within 30 seconds.
- **No `subscription.created`** came for it (none five minutes later; org-test-2's never came). `subscription.trialing` is the trial's start.
- **`transaction.completed` names its subscription** (`subscription_id`) and carries our `organisationId`, with
  `origin: web` and £0.00. That's how the transaction the page reports is matched to the subscription.
  (`subscription.created`, when there is one, carries `transaction_id`.)
- **Cancelling the trial** (`effective_from: next_billing_period`): it stays `trialing`, with
  `scheduled_change: cancel` at the trial's end and `next_billed_at` null; one `subscription.updated`. Nothing is
  charged.

**The inline checkout** (`displayMode: "inline"`, `frameTarget`: a class on our page; org-test-7):
- Paddle's frame shows only its form: the buyer's details, then the payment. **No list of items, no bin, no + or −.**
- `checkout.loaded` carries what our page needs to draw the summary itself: each item with `quantity`, `totals` and
  `recurring_totals`, and the checkout's `totals` (due today: 0) and `recurring_totals` (18, of which tax 3). Amounts
  are in pounds here, where the API uses pence.
- Paddle.js also sends events of its own with no `name` (`{ type: "checkout.ping.size", height: 430 }`).
- Not yet seen: the payment step, and a payment through it.

**Cancelling at once** (`effective_from: immediately`):
- org-test-6's trial, which already had a cancel scheduled, was cancelled at once: `canceled`, with
  `subscription.canceled` and `subscription.updated` together. Nothing was charged.
- On a subscription that's already cancelled: 400 `subscription_update_when_canceled`.

**The calls** (plain HTTP, org-test-5's subscription; every answer kept in `licensing/e2e/paddle/fixtures/`):
- **Preview** (`PATCH /subscriptions/{id}/preview`): adding a web seat with `prorated_immediately` showed £11.60 now
  (`immediate_transaction`, and `update_summary.result: charge`) and £48.00 at the next renewal; removing a mobile
  seat with `do_not_bill` showed nothing now and £30.00 next.
- **A seat increase** charged £11.60 at once, in one `subscription_update` transaction. `subscription.updated`
  followed the call's answer by about three seconds.
- **The same call again did nothing:** no transaction, no event, `updated_at` unchanged. Paddle is told every item's
  quantity, so the call is safe to repeat.
- **A decrease with `do_not_bill` outside a trial** made no transaction: no charge and no credit. The next renewal
  (2026-11-01) should be for the lower number.
- **Cancel at the period's end:** still `active`, `scheduled_change: { action: "cancel", effective_at }`, and
  `next_billed_at` becomes null. **A second cancel is refused:** 400 `subscription_locked_pending_changes`. Seats can
  still be changed while it's scheduled.
- **Withdraw** (`scheduled_change: null`) restores `next_billed_at`. With nothing scheduled, it changes nothing.
- **Refusals:** 404 `not_found` for an unknown subscription; 400 `subscription_update_when_canceled` for a cancelled
  one.

## 12. Getting paid

Sources: Paddle help, [When and how do I get paid?](https://www.paddle.com/help/manage/get-paid/when-and-how-do-i-get-paid),
[What statements will I receive?](https://www.paddle.com/help/manage/get-paid/what-statements-will-i-receive) and
[Should I charge Paddle VAT/tax for payouts?](https://www.paddle.com/help/manage/get-paid/should-i-charge-paddle-vattax-for-payouts).

- **Automatic, once set up.** The vendor enters the bank details once, in the live dashboard's **Payout settings**.
  Paddle then pays out **monthly**:
  - the balance becomes a payout on the **1st**, is sent by the **15th**, and arrives within 3 working days;
  - only when the balance is over the vendor's **threshold** (minimum $100 / £100 / €100; below it, the balance
    carries over to the next month).
- **Currency and method:** payouts in GBP, USD or EUR, by wire transfer (or Payoneer). Usually no payout fee; some
  countries pay a $15 SWIFT fee, and the vendor's own bank may charge.
- **The vendor raises no invoices.** Paddle generates:
  - a **reverse invoice** (self-billing, from the vendor to Paddle, for the payout amount);
  - a **remittance advice**;
  - a **monthly statement** (gross sales, taxes withheld, fees, adjustments, balance).
- **Tax on the payout:** the vendor charges Paddle no VAT. It's a B2B supply, taxed in Paddle's country by the
  reverse charge. An accountant should confirm this for a non-registered Isle of Man company.

## 10. For onboarding (Gary)

- [ ] Live account review: the business in the Isle of Man, the web app, the website's pricing and terms pages.
- [ ] The fee at the intended seat price.
- [ ] Payout currency (GBP) and bank.
- [ ] Once approved: **Payout settings** in the live dashboard (GBP, the bank account, the threshold). After that,
      payouts and their paperwork are automatic (§12).
- [ ] **Retain → Payment Recovery** (live only, not in the sandbox): set the recovery window to **14 days** and the
      end action to **cancel** (ADR-037 decision 7), and see whether yearly plans can have their own window.
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
