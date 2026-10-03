# Shopify Referral Program (Discontinued)

A custom Shopify embedded app that ran a customer-account-native referral program for a small independent e-commerce brand for roughly four weeks in 2026 before being decommissioned. This repository is preserved as a public artifact: the code, the architectural decisions, and the reasoning behind shutting it down.

> **Anonymized for public release.** The original brand name, store domains, API credentials, and customer data have been replaced with generic placeholders (`ExampleShop`, `your-shop.myshopify.com`, etc.). The shape and history of the project are preserved.

---

## The referral loop

A customer shares their code. Their friend saves on a first order, and the
customer earns credit toward their own next one.

```
┌────────────────────────────────────────────────────────────┐
│  1   A customer finds their referral code inside their     │
│      Shopify account                                       │
└────────────────────────────────────────────────────────────┘
                              │
                              │   they share it with a friend
                              ▼
┌────────────────────────────────────────────────────────────┐
│  2   The friend places their first order using it          │
└────────────────────────────────────────────────────────────┘
                              │
                              │   one order, two winners
               ┌──────────────┴────────────────┐
               ▼                               ▼
┌────────────────────────────┐  ┌────────────────────────────┐
│  3a  The friend gets       │  │  3b  The customer earns    │
│      20% off their order   │  │      credit toward theirs  │
└────────────────────────────┘  └────────────────────────────┘
                                               │
                              ┌────────────────┘
                              ▼
┌────────────────────────────────────────────────────────────┐
│  4   The customer spends that credit on their own next     │
│      order — so sharing keeps paying off                   │
└────────────────────────────────────────────────────────────┘
```

The whole loop lived inside the customer's own Shopify account page — no
separate portal to sign into, no third-party branding.

---

## Context — why this was built

A small DTC brand wanted to test whether a structured customer-driven referral channel could meaningfully grow new-customer acquisition. The hypothesis: a warm word-of-mouth incentive, surfaced inside the customer's own Shopify account, would convert better and feel more native than an off-the-shelf SaaS overlay.

Before paying ~€60/month for a hosted solution like ReferralCandy or Friendbuy, the call was to build a minimal in-house version with three goals:

1. **Validate the channel cheaply** — does word-of-mouth actually convert at this brand's scale?
2. **Get full UX control** inside the new Shopify customer account, with native components rather than a third-party hosted page.
3. **Decide post-validation** whether the channel deserved investment in tooling, marketing, or a switch to a hosted vendor.

## What it did

- Issued unique referral codes to a curated cohort of ~100 top customers via batch import
- Each customer's referral page in their account showed: their code, a shareable link, lifetime referral count, available credit balance
- Customers redeemed earned credit by generating a single-use discount code through their account UI
- Referrer credit accrued automatically when a referred friend completed their first order
- Self-referral and repeat-customer cases were filtered post-checkout in the webhook handler

## How it was built

**Stack**
- Shopify embedded app, Node 20 + React Router 7
- Prisma ORM with SQLite, Litestream-replicated to S3-compatible storage for backups
- Hosted on Fly.io (single-machine deployment, EU region)
- Customer account UI extension (Preact, `s-*` web components)

**Key components**

| Path | Purpose |
|---|---|
| `app/routes/app._index.tsx` | Admin UI for assigning and viewing referral codes (Polaris) |
| `app/routes/api.referral-init.ts` | Issue a new referral code on first customer-account visit — **unreferenced in the shipped build**, see [Known limitations](#known-limitations) |
| `app/routes/api.referral-data.ts` | Read the customer's current referral state for the extension |
| `app/routes/api.redeem.ts` | Convert accumulated credit into a single-use discount code |
| `app/routes/webhooks.orders-paid.ts` | Credit referrers post-checkout; idempotent via `ProcessedOrder` table |
| `extensions/referral-page/` | Customer-account UI extension (`customer-account.page.render`) |
| `scripts/batch-import.ts` | One-off import of a customer cohort with auto-generated codes |
| `prisma/schema.prisma` | Sessions, referral codes, processed-order tracking |

**Notable design decisions**

- **Customer state lives in Shopify metafields, not the app's DB.** Codes, balance, and history survive app uninstall and are visible/editable in the merchant admin. The local DB is just a code→customer index plus webhook idempotency.
- **Fraud checks happen post-checkout in the webhook**, not at the discount level. Self-referral and first-order-only rules gate the *credit*, not the *discount*. This kept the checkout flow simple and reversible — no Cart Validation Function, no checkout-blocking risk.
- **Webhook idempotency via a unique-constraint table** (`ProcessedOrder.orderId`). Shopify retries webhooks up to 19 times over ~48 hours on non-2xx responses; without dedup, a single referral could be credited multiple times.
- **Customer account migration was a hard requirement.** The `customer-account.page.render` extension target only works with Shopify's new customer accounts, not the legacy storefront login. The brand's existing legacy accounts had to be migrated first.

## Why it was discontinued

After ~30 days of soft launch with the cohort:

- **3 of ~99 customers** actively shared their referral code
- **8 referral orders** were placed in total
- Adoption rate ~3% — well below the 15–20% needed to justify ongoing maintenance and the engineering work still ahead

Two future-cost realities tipped the decision:

1. **An open abuse vector required more engineering.** Customers could use referral codes on non-first orders because only the *credit* was first-order-gated, not the discount itself. Closing this would have required either a checkout-time Cart Validation Function (real risk of blocking legitimate checkouts on a logic error) or migrating all live discount codes to a customer-segment-restricted version with a backfill migration. Neither was small.
2. **The build-vs-buy math no longer worked.** At the observed channel volume, a hosted solution at ~€60/month plus a percentage commission on referred revenue would have cost roughly the same over two years as ongoing maintenance — but the SaaS path also solves the abuse vector and the analytics gap without further engineering. At higher channel volume, custom would win; at this volume, neither was worth investing in.

The program was wound down: VIP discount codes deactivated in Shopify, the app uninstalled from the store, the three customers with active credit were sent equivalent vouchers manually, and Fly infrastructure was destroyed.

## Learnings

1. **Validate the channel before building the tool.** A manually-administered version (codes via merchant admin + Klaviyo email automation) would have surfaced the 3% adoption rate without writing a single route. The instinct to "just build it" cost time that could have gone to channels with stronger early signals.

2. **Customer Account UI Extensions are more constrained than the docs suggest.** `s-details` (collapsible sections) silently renders empty divs in production. `document` is unavailable in the sandbox. Only `s-*` web components work — native HTML throws "No component found" errors. Modal-based interaction patterns via `commandFor` / `command="--show"` are the only reliable workaround for disclosure UI. Prototype against the real component set on day one.

3. **Webhook idempotency is load-bearing — and ordering it correctly is subtler than it looks.** Without a `ProcessedOrder` deduplication table, Shopify's retry behavior would have caused double credit on a non-trivial fraction of referrals, and catching exceptions, *logging*, and *re-throwing* rather than swallowing errors to return 200s was the right instinct. But the two mechanisms as shipped work against each other: the dedup row is inserted *before* the crediting mutations, so a transient failure mid-credit re-throws, Shopify retries — and the retry short-circuits on the marker that is already there, dropping the referral silently. A dedup write has to commit *after* the side effect it guards, or the handler has to be genuinely re-entrant. Preserving a retry signal is worth nothing if the retry is a no-op. See [Known limitations](#known-limitations).

4. **Don't push fraud prevention into the discount path until you have to.** The post-hoc webhook gate was the right architectural call for this scale: simple, reversible, zero checkout-killing risk. Migrating to a Shopify Function or Cart Validation Function would have introduced real customer-facing risk for marginal abuse-prevention gain at the observed volume.

5. **Build-vs-buy is a forward-looking calculation, not a sunk-cost one.** The custom app reached production. The right question wasn't *"should we throw away what we built?"* but *"what's the next 24 months of engineering cost vs. SaaS subscription cost?"* At the channel's actual conversion rate, neither path was worth investing in — so neither was chosen.

6. **Decommissioning is its own discipline.** Sunsetting required: deactivating all live discount codes, sending replacement vouchers to customers with earned-but-unredeemed credit, uninstalling cleanly from the store, destroying Fly resources in the right order (machine → volume → object storage → app), and removing secrets from the repository before going public. A good shutdown is as deliberate as a good launch.

---

## Known limitations

Documented rather than fixed — the program was decommissioned before these were addressed. Listing them because a reader evaluating the code should not have to find them, and because the shortest honest description of this project includes its defects.

- **Redemption is not concurrency-safe.** `api.redeem.ts` reads `successful_count`, mints a discount worth `count × €7.50`, and only then resets the count to zero — with no transaction, lock, or idempotency key spanning those steps. Two concurrent requests both read the same balance and both mint a full-value code. The fix mirrors the pattern already used for webhooks: a `Redemption` row with a unique constraint, written before the discount is created. The same path also never inspects `userErrors` on the mutation that clears the balance, so a failed reset leaves credit redeemable twice.

- **The webhook dedup marker commits before the side effect it guards.** `webhooks.orders-paid.ts` inserts `ProcessedOrder` ahead of the crediting mutations, so a failure during crediting is retried by Shopify and then short-circuited by the marker — the referral is dropped rather than retried. See [Learnings](#learnings) #3.

- **`api.referral-init.ts` is unreferenced, and would be an abuse vector if it were reachable.** The customer-account extension only calls `/api/referral-data` and `/api/redeem`. The route remains an authenticated POST that mints a 20% code with `usageLimit: null` and **no minimum subtotal**, where both the admin and batch-import paths require €29.90. It should have been deleted rather than left in place.

- **Self-referral prevention compares customer IDs only.** A second account or email address bypasses it. "Self-referral filtered" under [What it did](#what-it-did) should be read with that caveat — the check raised the effort required, it did not close the hole.

- **The admin dashboard makes one Admin API call per referral code.** `app._index.tsx` loops sequentially on every page load (~100 round-trips for the production cohort) and a bare `catch {}` renders zeros instead of surfacing failures. This would have hit Shopify's rate limits as the cohort grew.

- **Litestream replication was running without a verified restore path.** `dbsetup.js` disables the restore step after a corrupt backup, with a comment to re-enable it once the database stabilised — which never happened. Replication without a tested restore is not a backup.

- **No automated tests.** The three cases worth having were a duplicate webhook crediting once, a self-referral being rejected, and concurrent redemption being unable to double-issue — which is to say, exactly the three claims this README makes most confidently.

## Repository status

- **Production deployment:** destroyed (Fly.io app, machine, volume, and Tigris S3 bucket all removed)
- **Shopify integration:** uninstalled from the production store; discount codes deactivated
- **Customer data:** never committed to this repository; lived only in production Shopify (now uninstalled) and on a Fly volume (destroyed)
- **Code:** anonymized and preserved here as a reference

Forked from Shopify's [`shopify-app-template-react-router`](https://github.com/Shopify/shopify-app-template-react-router) as the starting point. Original template instructions are upstream — this README replaces them.
