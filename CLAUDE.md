# KiriGo — build brief for Claude Code

KiriGo (kirigo.online) is an open delivery network for South Tarawa that plugs into **KiriPay** (wallet, kiripay.online) and **KiriPOS** (point of sale, kiripos.online). Anyone can sign up as a driver. Customers pick a driver by price, rating and distance. KiriPay holds all money until the order is delivered and accepted.

Full product spec (source of truth for business rules): KiriGo — Delivery Platform Spec (Claude Doc). If this file and the spec disagree, the spec wins; flag it.

Repo: `kiripay-app/kirigo.online` (private). Deploys to Cloudflare on push to `main`.

---

## Golden rules

1. **KiriGo never holds money.** Every money movement is a call to the KiriPay internal API (`hold`, `release`, `refund`, `charge`). KiriGo stores references to KiriPay transaction IDs, never balances.
2. **Pay first.** No shop or driver is notified until the KiriPay hold succeeds.
3. **Money is integer cents (AUD).** Never floats.
4. **Every money call is idempotent.** Use `idempotency_key = <order_id>:<action>:<seq>`. Safe to retry.
5. **`order_events` is append-only.** No UPDATE or DELETE on it, ever, including admin.
6. **Store UTC, display Kiribati time** (Pacific/Tarawa, UTC+12), dates `dd/mm/yyyy`.
7. **Every number in the rules is a setting** (table `settings`), never hard-coded.
8. **Location is tracked only from accept to handed-over.** Never while a driver is merely online.
9. Greeting in UI is "Mauri". English UI first; Kiribati strings come later after native-speaker review.

---

## Stack

| Part | Tech |
|---|---|
| API | Cloudflare Workers (TypeScript, Hono router) |
| Database | Cloudflare D1 (SQLite), migrations in `apps/api/migrations` |
| Live tracking | Durable Object `OrderTracker` (one per active order, WebSockets) |
| Driver presence | Durable Object `DriverPresence` (single instance, online drivers + last position) |
| Photos | R2 bucket `kirigo-photos` (private, signed URLs ≤ 10 min) |
| Map tiles | Protomaps PMTiles of South Tarawa in R2 bucket `kirigo-tiles`, rendered with Leaflet |
| Scheduled jobs | Workers Cron Triggers |
| Driver app | React + Vite + Capacitor (Android), background geolocation as a foreground service |
| Admin | React + Vite, served at `/admin` |
| Public site | Static landing at `/` (driver sign-up info, terms, privacy) |
| Email | Resend (same as KiriPay) |

---

## Repo layout

```
apps/
  api/            Worker: src/routes (svc = customers via KiriPay, pos = shops via KiriPOS, driver, admin, auth),
                  src/lib (orders, money, kiripay, matching, problems, ratings, fees, photos, handoff, notify, views),
                  src/do (OrderTracker, DriverPresence), src/cron, migrations, test/smoke.mjs, test/integration.mjs
  web/            React + Vite: index.html (landing), driver/ (driver app, Capacitor), admin/ — built into apps/web/dist
packages/
  shared/         types, order state machine, pricing, road distance + en-route check, handoff QR signing, Kiribati time, ratings, zod schemas
docs/             kiripay-kirigo-escrow.patch (the KiriPay side), kiripay-escrow.md, integrations.md, road-data.md
```

All API routes are under `/api` (`/api/svc`, `/api/pos/shops/:shopId`, `/api/driver`, `/api/admin`); `/auth/*` is sign-in.
Customer UI lives in the **kiripay.online** repo (KiriPay app). Shop UI lives in the **kiripos.online** repo. See docs/integrations.md.

## Auth

- Customers never sign in to KiriGo: KiriPay's server calls `/api/svc` for them (`x-kirigo-key` + `x-kirigo-user`).
- Drivers and admins use "Sign in with KiriPay" (`/auth/start` → KiriPay `/kirigo/authorize` → one-time code → KiriGo session).
- Drivers and admins: two-step sign-in required.
- Admin: max 2 concurrent sessions (same as KiriPay).
- Service-to-service (KiriPay ↔ KiriGo ↔ KiriPOS): HMAC-signed requests with shared secrets in Worker secrets.

---

## Order state machine (`packages/shared/state.ts`)

```
PAID_HELD → DRIVER_ASSIGNED → READY_AT_SHOP → PICKED_UP → ON_THE_WAY → ARRIVED → HANDED_OVER
HANDED_OVER → ACCEPTED → CLOSED
HANDED_OVER → PROBLEM_REPORTED → (KEPT | RETURNING | SWAPPING | CORRECTING) → … → CLOSED
any pre-pickup state → CANCELLED (full refund)
ARRIVED → NOT_DELIVERED (no adult after 22:00, customer absent) → refund goods, customer pays delivery
```

Only the transitions in the state module are allowed. Every transition writes one `order_events` row.

---

## Money flow

| Moment | KiriPay call |
|---|---|
| Checkout | `hold(customer, goods + delivery)` |
| Handoff code scanned (or synced offline) | `release(hold, driver, delivery_charge)` |
| Customer taps "Received, all correct" or 24 h after handoff with no problem | `release(hold, shop, goods)` |
| Cancel before pickup | `refund(hold, customer, all)` |
| Problem, shop agrees or admin rules shop at fault | `refund(hold, customer, goods)` + `charge(shop, original delivery + return/swap/correction trip)` → `refund` delivery to customer |
| Admin rules for shop | `release(hold, shop, goods)`; customer pays return trip |
| Driver damaged goods (admin ruling) | `charge(driver, delivery_charge)` → customer |
| Driver monthly fee | `charge(driver, fee)` incl. 12.5% VAT |

Shop wallet may go negative; KiriPay recovers from next sales.

### KiriPay API to build first (in the kiripay.online repo)

```
POST /internal/holds                 {customer_id, amount_cents, ref, idempotency_key} → {hold_id}
POST /internal/holds/:id/release     {to_wallet_id, amount_cents, idempotency_key}
POST /internal/holds/:id/refund      {amount_cents, idempotency_key}
POST /internal/charges               {wallet_id, amount_cents, reason, ref, idempotency_key}
GET  /internal/holds/:id             → {amount, released, refunded, remaining}
```

Holds sit in the ring-fenced customer-funds ledger. Every call lands in KiriPay's 7-year transaction records.

---

## Pricing (`packages/shared/pricing.ts`)

```
charge = max(rate.minimum, rate.base + rate.per_km * distance_km) + surcharges
distance_km = road distance shop → customer (driver's trip to shop is NOT charged)
```

- Distance: project both pins onto the South Tarawa road polyline (`apps/api/src/lib/road.geojson`) and measure along it; add straight-line from pin to road for each end.
- Clamp `per_km` to `settings.max_per_km`; `minimum` ≥ `settings.floor_minimum`.
- Surcharges: night (hours from settings), bulky.
- En-route jobs: `rate.per_km * detour_km + settings.enroute_pickup_fee`.

---

## Driver list at checkout

`POST /quotes {shop_id, dropoff:{lat,lng}, size}` →
- online drivers from `DriverPresence` within `settings.pickup_radius_km` of the shop, fee paid (or in free period), approved, vehicle fits size
- price each with their rate card
- return up to `settings.drivers_shown` with: photo URL, first name, driver code (KG-0142), vehicle + plate, verified, rating, delivery count, price, ETA
- sort options: closest (default), cheapest, top rated
- empty list → `delivery_available: false`

Quote is valid 5 min. Checkout passes `quote_id` + chosen `driver_id`.

---

## API endpoints (Worker)

Customer (called by KiriPay app)
```
POST /quotes
POST /orders                         create + hold; then notify shop + driver
GET  /orders/:id                     status, driver card, handoff code (customer only)
WS   /orders/:id/track               live position
POST /orders/:id/accept              "Received, all correct"
POST /orders/:id/problem             reason + photo → keep | return | swap | correction
POST /orders/:id/cancel
POST /orders/:id/rate                shop + driver
POST /orders/:id/choose-driver       re-pick after decline / for correction
```

Shop (called by KiriPOS)
```
GET  /shop/orders
POST /shop/orders/:id/ready
POST /shop/orders/:id/pickup-photo
POST /shop/orders/:id/fault          agree | dispute
POST /shop/orders/:id/offer-discount
POST /shop/orders/:id/return-received  + photo
POST /shop/orders/:id/rate           customer + driver
PUT  /shop/settings                  delivery on/off, pickup pin, min customer rating
```

Driver
```
POST /driver/apply                   vehicle, licence photo, rate card
PUT  /driver/rate-card               only while offline
POST /driver/online                  + shift selfie
POST /driver/offline
GET  /driver/offers                  incoming job (60 s), en-route offers
POST /driver/jobs/:id/accept | decline
POST /driver/jobs/:id/status         at_shop | picked_up | arrived
WS   /driver/jobs/:id/gps            location every 10–15 s
POST /driver/jobs/:id/handoff        signed code + photo + gps + recipient flags (someone_else, name, child, adult_confirmed)
POST /driver/sync                    queued offline handoffs
POST /driver/jobs/:id/rate           customer + shop
GET  /driver/earnings
```

Admin
```
GET/PUT /admin/settings
GET  /admin/drivers?status=pending
POST /admin/drivers/:id/approve | suspend   (licence_seen, licence_expiry, licence_matches_kyc)
GET  /admin/disputes
POST /admin/disputes/:id/rule        shop | customer | driver, partial amounts
GET  /admin/orders/:id               full event log, route replay, photos
GET  /admin/flags                    low ratings, failed corrections
GET  /admin/selfies?sample=20        spot-check shift selfies vs KYC
```

Webhooks out: order status → KiriPOS and KiriPay (HMAC signed, retried).

---

## Handoff (works offline)

- At order creation the API issues a 4-digit code + QR containing `{order_id, code, exp}` signed with Ed25519. The driver app ships the public key, so it can verify the scan with no internet.
- Driver app requires: valid scan → in-app camera photo (no gallery) → recipient flags. After 22:00 Kiribati time, "adult received" must be ticked.
- Offline: save to IndexedDB/Capacitor storage, show "Saved, will sync", sync on reconnect. Driver payout releases on sync.
- Photos are stamped (EXIF + DB): time, GPS, driver ID, order ID.

---

## Problems, returns, swaps, corrections

- Problem report requires customer photo + reason.
- Shop has 24 h to Agree or Dispute; no answer = Agree. Dispute → admin, target 3 days.
- Customer options: keep (optional shop discount) | return | swap | correction (after return; customer picks a new driver).
- Check at the door: driver may wait 5 min; a return in that window goes back with the same driver.
- Return not handed over within 48 h (driver GPS + photo at pin) → problem closed, shop paid.
- Shop doesn't confirm return receipt in 24 h → customer refunded automatically.
- 2 failed corrections → full refund + shop flagged.
- Return trips are charged to the shop only after fault is settled.

### En-route pickups
Offer returns/swaps/small jobs first to drivers on an active job whose direction along the road passes the customer and then the shop. Max detour 1 km, max 2 extra jobs, driver ticks "I have space", first accept wins, fallback to normal list after 10 min.

---

## Ratings

- Customer → shop, customer → driver, driver → customer, driver → shop, shop → customer.
- Stars 1–5; driver/shop rating customers use fixed reason tags.
- Blind until both sides rated or 48 h.
- Show "New" until 5 ratings. Show own score + reasons, not who gave them.
- Flags: driver < 3.5 after 20, customer < 3.0 after 5, shop < 3.5 after 20.

---

## Cron jobs

| Job | Every |
|---|---|
| Auto-release shop payment 24 h after handoff (reminder at 20 h) | 15 min |
| Shop fault-check timeout (24 h → Agree) | 15 min |
| Return not handed over (48 h) / return receipt not confirmed (24 h) | 15 min |
| Unblind ratings (48 h) | hourly |
| Driver monthly fee on anniversary date | daily 00:30 Kiribati |
| Delete photos older than 90 days with no open dispute | daily |
| Delete GPS routes older than 12 months | daily |
| Expire stale quotes / unaccepted offers | 1 min |

---

## D1 tables (first migration)

```sql
drivers(id, kiripay_user_id UNIQUE, driver_code UNIQUE, status /*pending|approved|suspended*/,
        licence_photo_key, licence_expiry, licence_matches_kyc INTEGER, approved_by, approved_at,
        fee_paid_until, free_until, rating_avg, rating_count, deliveries, created_at)
vehicles(id, driver_id, type /*motorbike|car|van|truck*/, plate, photo_key, can_bulky, active)
rate_cards(id, driver_id, base_cents, per_km_cents, minimum_cents, night_cents, bulky_cents, updated_at)
shifts(id, driver_id, selfie_key, online_at, offline_at, spot_checked_by, spot_check_result)
orders(id, source /*kiripay_market|kiripos*/, source_ref, shop_id, customer_id, driver_id,
       pickup_lat, pickup_lng, drop_lat, drop_lng, landmark, size, distance_m,
       goods_cents, delivery_cents, hold_id, status, share_phone INTEGER,
       handoff_code_hash, handed_over_at, accepted_at, parent_order_id, kind /*delivery|return|swap|correction|enroute*/,
       created_at)
order_events(id, order_id, at, actor_type, actor_id, type, data_json, lat, lng)   -- append-only
order_routes(order_id, points_json, created_at)
photos(id, order_id, kind /*pickup|handoff|problem|return_receipt*/, r2_key, taken_at, lat, lng, taken_by, delete_after)
ratings(id, order_id, from_type, from_id, to_type, to_id, stars, reasons_json, comment, visible_at, created_at)
disputes(id, order_id, reason, shop_response, opened_at, ruled_at, ruling, ruled_by, notes)
offers(id, order_id, driver_id, kind /*primary|enroute*/, extra_cents, detour_m, expires_at, result)
money_calls(id, order_id, action, kiripay_ref, amount_cents, idempotency_key UNIQUE, status, created_at)
settings(key PRIMARY KEY, value_json, updated_by, updated_at)
```

Add a SQLite trigger that raises on UPDATE/DELETE of `order_events`.

### Settings seed

```
monthly_fee_cents: null (TBD)   free_period_months: 3   max_per_km_cents: null   floor_minimum_cents: null
night_hours: null   enroute_pickup_fee_cents: null   pickup_radius_km: 3   drivers_shown: 5
accept_window_s: 60   door_wait_min: 5   auto_release_h: 24   shop_fault_response_h: 24
return_handover_h: 48   return_receipt_h: 24   max_failed_corrections: 2
enroute_max_detour_m: 1000   enroute_max_jobs: 2   enroute_fallback_min: 10
rating_blind_h: 48   gps_interval_s: 12   adults_only_after: "22:00"
retention_gps_months: 12   retention_photos_days: 90   retention_records_years: 7
driver_signup_open: true   delivery_open: false
```

`null` settings block launch: the admin dashboard shows them as "must set before go-live".

---

## Privacy and safety

- Customer phone shown to driver only if `share_phone` is true for that order; otherwise in-app chat, closed 24 h after delivery.
- Exact customer pin shown to driver only after accept.
- Photo visibility: handoff → customer, driver, admin (not shop). Pickup → shop, driver, admin.
- Privacy policy: operator Nauoi IT Services, privacy@nauoi.com.ki; add location + photo sections.
- Google Play: background-location declaration + in-app prominent disclosure before first tracking.

---

## Phase 1 task list (in order)

- [ ] KiriPay: hold / release / refund / charge endpoints + tests (kiripay.online repo)
- [ ] Scaffold monorepo, wrangler config, D1 + R2 + DO bindings, CI deploy
- [ ] Migrations + settings seed + `order_events` trigger
- [ ] `packages/shared`: types, state machine, pricing, road distance (with unit tests)
- [ ] Driver apply/approve flow + admin approvals (licence check, KYC match)
- [ ] Rate cards, online/offline + shift selfie, `DriverPresence`
- [ ] Quotes + order creation with KiriPay hold
- [ ] Offers: 60 s accept/decline, roll to next choice
- [ ] `OrderTracker` DO + driver GPS + customer/shop WebSocket
- [ ] Handoff: signed code, offline verify, photo, sync, driver release
- [ ] Customer accept / 24 h auto-release
- [ ] Problems: fault check, keep/return/correction, disputes in admin
- [ ] Ratings (blind, thresholds, flags)
- [ ] Cron jobs
- [ ] KiriPay app screens (checkout, list, tracking, handoff code, confirm/problem, rate) — kiripay.online repo
- [ ] KiriPOS screens (delivery setting, orders status, ready, pickup photo, fault, return receipt) — kiripos.online repo
- [ ] Field test on Tarawa with test money

Phase 2: swap, en-route pickups, check-at-door, shop discounts, request quotes, scheduled deliveries, person-to-person parcels, monthly fee billing.
Phase 3: multi-drop, business accounts, KiriPOS stock transfers, TradeIt, outer islands.

---

## Testing

- Unit tests (Vitest) for pricing, distance, state machine, idempotency.
- Integration tests with Miniflare for every money path in the "Money flow" table, including retries and partial refunds.
- A KiriPay sandbox (test money) is used for all non-production environments.
