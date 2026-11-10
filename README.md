# KiriGo — kirigo.online

Delivery for KiriPay and KiriPOS. Anyone can sign up to drive; customers choose a driver by price, rating and distance;
KiriPay holds the money until the order is delivered and accepted. Drivers keep 100% of delivery charges; KiriGo's only
income is a monthly driver fee.

Full product spec: *KiriGo — Delivery Platform Spec* (Claude Doc). Build brief for Claude Code: `CLAUDE.md`.

## What's here

| Folder | What |
|---|---|
| `apps/api` | Cloudflare Worker (Hono): the API, Durable Objects for live tracking and driver presence, cron jobs, D1 migrations |
| `apps/web` | Public page (`/`), driver app (`/driver/`, wrapped for Android with Capacitor) and admin (`/admin/`), React + Vite |
| `packages/shared` | Rules shared by everything: order statuses, pricing, road distance, handoff QR signing, Kiribati time, ratings |
| `docs/kiripay-kirigo-escrow.patch` | The KiriPay side (escrow holds, KiriGo routes, "Sign in with KiriPay"). See `docs/kiripay-escrow.md` |

## Run it locally (no KiriPay needed)

```bash
npm install
cd apps/api
cp .dev.vars.example .dev.vars
npm run keys >> .dev.vars        # handoff signing keys + session secret
npm run dev                       # http://localhost:8787  (KIRIPAY_MODE=mock: a built-in stand-in for KiriPay)
npm run smoke                     # in another terminal: a full delivery, a return + refund, a cancel — checks every cent
```

The web apps: `cd apps/web && npm run dev` (proxies the API to :8787). Sign in locally with
`http://localhost:8787/auth/dev?user=u_me` (admin: add `&admin=1`), then open `/driver/#token=…`.

`npm test` (root) runs the shared rule tests. `apps/api/test/integration.mjs` runs KiriPay and KiriGo together with
real escrow — see `docs/kiripay-escrow.md`.

## Deploy (kirigo.online)

1. `cd apps/api && npx wrangler d1 create kirigo` → put the id in `wrangler.jsonc`.
2. `npx wrangler r2 bucket create kirigo-photos` and `npx wrangler r2 bucket create kirigo-tiles`.
3. `npm run db:migrate:remote`
4. Secrets (once): `npm run keys`, then `npx wrangler secret put` each of:
   `SESSION_SECRET`, `HANDOFF_PRIVATE_KEY`, `HANDOFF_PUBLIC_KEY`, `KIRIPAY_URL` (https://kiripay.online),
   `KIRIPAY_ESCROW_KEY`, `KIRIPAY_SERVICE_KEY`, `KIRIPOS_SERVICE_KEY`, `KIRIPOS_URL` (https://kiripos.online),
   `KIRIPAY_MODE` (`live`), `APP_ENV` (`production`). Generate the three shared keys with
   `openssl rand -base64 32` and set the **same** values on the KiriPay / KiriPOS side.
5. Build the web apps (`cd apps/web && npm run build`), then `cd apps/api && npm run deploy`, and add `kirigo.online` as a
   custom domain. Or connect the GitHub repo in Cloudflare Workers Builds (root `apps/api`, build command
   `cd ../.. && npm ci && npm run build -w @kirigo/web`).
6. In KiriGo admin (`/admin/`), set the launch settings (monthly fee, price caps, night hours, en-route fee), then switch
   **Delivery service open** on. It refuses to open while any of those are blank.

## What's built (phase 1)

- Driver sign-up (KiriPay KYC + vehicle + licence photo), admin approval with licence check, rate cards, shift selfies
- Quotes: online drivers near the shop priced by their own rate card, sorted closest / cheapest / top rated
- Pay first: the customer's goods + delivery go into a KiriPay hold before anyone is told; a hold can pay for one order only
- 60-second offers, automatic fallback to the customer's next driver, driver can give a job back before pickup
- Live GPS (accept → handoff) over WebSockets; the route saved once per trip
- Handoff: signed QR (checked offline on the driver's phone) or 4-digit code (online, 5 tries), in-app photo, someone-else
  and child flags, adults only after 22:00, offline handoffs synced later
- Driver paid 100% at handoff; shop paid on "Received, all correct" or 24 h later
- Problems: fault check (shop agrees/disputes in 24 h), keep (+ shop discount offer), return, correction (after return),
  2 failed corrections → refund; shop pays its own mistakes from its goods money, then its wallet, then as a debt
- Admin rulings (shop / customer / driver at fault, partial refunds), dispute deadlines, full order log, route replay
- Three-way blind ratings, review flags, rating removal on appeal, customer delivery restriction
- Monthly driver fee (VAT incl.) after the free period; can't go online while unpaid
- Retention: photos 90 days (kept while disputed), GPS 12 months, records 7 years; append-only event log

**Not yet (phase 2):** swaps, en-route pickups for returns (the matching rule is built and tested in `packages/shared`),
check-at-the-door returns with the same driver, "request quotes" for bulky jobs, scheduled deliveries, person-to-person parcels.
The KiriPay app and KiriPOS screens are in their own repos — see `docs/integrations.md`.
