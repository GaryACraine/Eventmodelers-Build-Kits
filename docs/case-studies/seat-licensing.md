# Seat licensing: how other vendors sell a web app by seats (PLAN 16.2)

> **Status: desk research, 2026-09-30.** From each vendor's public help and developer docs (sources at the end).
> What Paddle itself does is in [`paddle.md`](paddle.md). The decisions this leads to are proposed in ADR-037
> (`eventmodelers-cli/stacks/dcb/ADR.md`), for Gary to settle before the model (16.3).

**Why this note.** The licensing model is ours (PLAN Phase 16): Paddle takes the money, and we decide who may use
the app. Before designing that, this note looks at how established vendors answer the same questions, so our
model follows what customers already expect.

**The vendors:**
- **Slack, Linear, Notion:** seats follow membership. Everyone in the workspace is billed.
- **GitHub:** members are billed. On the Team plan, a pending invitation can hold a seat.
- **Figma, Zoom:** seats are bought, then assigned by an admin.
- **Polar:** a merchant of record, like Paddle, with seats built in (customers, members, invitations, claims). It's
  the closest match to our situation.
- **Laravel Spark:** a billing starter kit on Paddle. It shows how an app keeps Paddle's quantity in step with its
  team size.
- **Paddle's own guidance:** trials, failed renewals, and what access to give in each subscription state.

## 1. Two families

Every vendor fits one of two models. **Which one we pick shapes the rest of the model.**

| | **A. Seats follow membership** | **B. Seats are bought, then assigned** |
|---|---|---|
| Who | Slack, Linear, Notion, GitHub | Figma, Zoom, Polar |
| What the customer buys | nothing up front: the bill is the number of members | a number of seats |
| Adding a person | just invite them; the bill goes up | assign a free seat, or buy another |
| At the limit | there is no limit | blocked, or a request to an admin, or an automatic purchase (Figma lets the admin choose) |
| Removing a person | the bill goes down (credit, or at renewal) | the seat is free for someone else; the bill stays the same |
| Unused seats | none | billed until removed |
| Surprises | a bill that grows unnoticed (Figma's forum is full of complaints about unexpected seat charges) | a person who can't get in until an admin acts |

**How each fits Paddle.** Paddle bills a **quantity** that we set (`paddle.md` §3, §11).
- **B is Paddle's natural shape.** The quantity is the number of seats bought. Assigning a seat is ours alone and
  never calls Paddle.
- **A is possible.** Laravel Spark does it: it listens for a member joining or leaving and updates the quantity.
  But every join and leave becomes a Paddle update, and an increase charges the card at once. A declined charge
  would then block a person from joining.

## 2. Who buys, and who uses

- **Everyone separates the payer from the users.** Polar puts it most plainly: "A Customer is the billing entity:
  who pays", and "A Member is a person under a customer: who uses."
- **The buyer is an organisation** (a workspace, a team, an account), not a person. The person who buys becomes
  its **owner**.
- **Does the owner use a seat?**
  - Slack and GitHub bill owners and admins like any member.
  - Polar's purchaser is the owner member. Its separate `billing_manager` role manages seats and billing but gets
    no product access.
  - GitHub's billing managers don't use a seat either.
- **So there are two kinds of role:**
  - **people who use the app** hold a seat, whether owner, admin or member;
  - **a billing-only person** (someone from finance, say) needs no seat.

## 3. Invitations

- **An invitation is sent by email, and accepting it gives access.** Polar calls this a seat's **claim**: *pending*
  (assigned, invitation sent), then *claimed* (access granted), or *revoked*.
- **Whether a pending invitation holds a seat:**
  - On GitHub Team, a pending invitation to an outside collaborator "temporarily uses an available seat".
  - Polar assigns the seat when it sends the invitation.
  - Among the vendors whose seats follow membership (family A), an invitation costs nothing until it's accepted.
- **Invitations expire.** Polar's claim links last 24 hours. Most vendors allow days, and the invitation can be sent
  again.

## 4. Assigning and removing seats

- **Revoking a seat and reducing the seat count are different things.** Polar: "Revoking a seat removes a
  specific user's access and frees that seat for reassignment", whereas reducing the count "changes the
  subscription quantity itself".
- **A freed seat can be reassigned** to someone else at no cost (Figma, Polar, Notion).
- **Zoom limits how often a seat can move** from person to person, so that one seat can't be shared among many
  people. That's for later, if ever.
- **Who manages seats:** owners and admins everywhere. Figma adds billing-group admins for large customers.

## 5. At the limit

In family B, when every seat is taken:
- **Zoom blocks:** "buy more licenses to increase the limit".
- **Figma lets the admin choose one of three settings:**
  - approve every request by hand;
  - approve automatically while a seat is free, and by hand when none is (the default);
  - approve every request, buying a new seat when needed.
- **Polar:** the seats bought are the maximum; the buyer adds seats to assign more.

## 6. Adding and removing seats mid-term

| | Adding | Removing |
|---|---|---|
| Slack | charged for the time used | credit when a member goes inactive (28 days) |
| Linear | prorated charge on the next invoice (yearly plans) | prorated credit toward later invoices |
| Notion | prorated charge on the next invoice | **no credit**: the seat can be reused until renewal, and the bill drops then |
| Figma | prorated from approval, on the next invoice | at renewal: unused seats aren't renewed (monthly), or are removed before an annual renewal |
| Polar | charged at once, prorated | prorated credit |
| **Paddle (sandbox, `paddle.md` §11)** | charged at once when we use `prorated_immediately`; the call returns once the charge succeeds | **credit on the customer's Paddle balance**, spent on later renewals, not refunded to the card |

- **Adding seats is charged when it happens** almost everywhere, now or on the next invoice.
- **Removing seats is where vendors differ:** an immediate credit (Linear, Polar, Paddle's default) or no change
  until renewal (Notion, Figma).
- **Paddle can't schedule a seat decrease for renewal.** Its `scheduled_change` only cancels, pauses or resumes.
  To take seats off at renewal, we'd have to remember the change and make it ourselves at the right time.
- **Seats in use come first.** None of the docs describes the seat count falling below the seats in use. The
  nearest case is Atlassian's downgrade to Free, which asks the admin to "reduce the number of users … and then
  continue". Polar doesn't say what happens to claimed seats when the count is reduced below them.

## 7. Trials

- **Lengths:** Atlassian gives 14 days (Standard) or 30 days (Premium).
- **Paddle offers three kinds** (`paddle.md`; 16.2b tries them):
  - **free**: a card at signup, charged when the trial ends;
  - **paid**: a reduced price for the trial;
  - **cardless**: no card. If none is added before the trial ends, "Paddle automatically cancels the
    subscription". A cardless trial can't be paused.
- **Access during a trial:** Paddle says to treat `trialing` "the same as `active`". So a trial needs no access rule
  of its own, only its end date for the banner.
- **Changing seats during a trial:** ADR-036's research found Paddle doesn't allow it. Paddle's trial page doesn't
  say, and the paid-trials changelog says "changes during the trial aren't prorated". 16.2b settles it.

## 8. Failed renewals and grace

- **Paddle's recommendation:** keep full access while a subscription is `past_due`, and "show a banner and link to
  the customer portal so the customer can update their payment method".
- **How long it lasts:**
  - Without Retain, Paddle retries 7 times over 30 days.
  - With Retain, its own schedule, plus recovery emails on about days 1, 3, 5 and 7.
- **At the end, the vendor chooses** "Pause subscription" or "Cancel subscription" (Retain → Payment Recovery).
  After a pause, access is off or read-only; after a cancel, access is off.
- **GitHub is stricter:** paid features lock as soon as payment is past due. Nothing is deleted, and "GitHub does not
  ask you to pay for the time elapsed in locked mode".

## 9. Cancellation and access

- **Access continues until the end of the paid period.** Paddle: "If `scheduled_change.effective_at` is in the
  future, revoke access at that time".
- **Data is kept.**
  - Linear: "Nothing will be deleted." A cancelled workspace falls back to the free plan, with limits (over 250
    issues, no new issues).
  - GitHub keeps private repositories, locked, and never makes them public.
- **Coming back:** the owner can subscribe again, and the organisation and its data are still there. With Paddle
  that's a new subscription, since a cancelled one can't be resumed.

## 10. Roles

| Vendor | Roles |
|---|---|
| Polar | `owner` (the purchaser), `billing_manager` (manages seats and billing, gets no product access), `member` |
| GitHub | owners, members, billing managers (hold no seat), outside collaborators |
| Slack | owners, admins, full members; single-channel guests are free |
| Figma | team or organisation admins manage seats; billing-group admins for large customers |

**The pattern:**
- an **owner**, one at least, who can't leave without handing over;
- **admins** who manage people and seats;
- **members** who use the app;
- optionally, a **billing-only** role.

## 11. What this means for our model (the questions for ADR-037)

1. **Family A or B.** B fits Paddle and a "seats for your employees" product, and a declined card never blocks a
   person joining. A is the easier sale, with no admin step and nothing unused.
2. **Does the owner use a seat,** and is there a billing-only role?
3. **Does a pending invitation hold a seat,** and how long does an invitation last?
4. **At the limit:** block, or a request to an admin, or buy automatically?
5. **Removing seats:** at once with a credit (Paddle's default, nothing to schedule), or at renewal (we remember
   the change and make it then)?
6. **Trials:** which kind, and how long. Waits on 16.2b.
7. **Failed renewal:** full access and a banner during `past_due` (Paddle's advice), then pause or cancel after
   the window. Waits on 16.2b.
8. **After cancellation:** read-only, or no access? How long is data kept?

## Sources

- Polar, [Seat-based pricing](https://polar.sh/docs/features/seat-based-pricing)
- GitHub, [About per-user pricing](https://docs.github.com/en/billing/managing-the-plan-for-your-github-account/about-per-user-pricing);
  [Unlocking a locked account](https://docs.github.com/articles/unlocking-a-locked-account)
- Slack, [Fair billing policy](https://slack.com/help/articles/218915077-Fair-billing-policy)
- Linear, [Billing and plans](https://linear.app/docs/billing-and-plans)
- Notion, [How members impact billing](https://www.notion.com/help/members-and-billing)
- Figma, [Manage seats](https://help.figma.com/hc/en-us/articles/360039960434-Manage-seats-in-Figma);
  [Set approval settings for new seats](https://help.figma.com/hc/en-us/articles/4414038570007-Set-approval-settings-for-new-seats);
  [Manage billing on the Professional plan](https://help.figma.com/hc/en-us/articles/360041061034-Manage-billing-on-the-Professional-plan)
- Zoom community, [license assignment limits](https://community.zoom.com/t5/Billing-Account-Management/unable-to-assign-lisence-because-quot-You-have-exceeded-the/m-p/111460)
- Atlassian, [Manage your bill for Standard and Premium plans](https://support.atlassian.com/subscriptions-and-billing/docs/manage-your-bill-for-standard-and-premium-plans/)
- Laravel Spark (Paddle), [Plans](https://spark.laravel.com/docs/spark-paddle/plans)
- Paddle, [Provision access and handle subscription state](https://developer.paddle.com/build/subscriptions/provision-access-webhooks/);
  [Subscription past due](https://developer.paddle.com/build/lifecycle/subscription-renewal-dunning);
  [Trials](https://developer.paddle.com/concepts/subscriptions/trials/);
  [Cardless trials](https://developer.paddle.com/build/trials/cardless-trials/);
  [Paid trials](https://developer.paddle.com/changelog/2026/paid-trials/);
  [Paddle for SaaS](https://developer.paddle.com/get-started/how-paddle-works/saas/)
