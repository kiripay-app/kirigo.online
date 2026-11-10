# The KiriPay side: escrow for KiriGo

`kiripay-kirigo-escrow.patch` adds to the **kiripay.online** repo:

| File | What |
|---|---|
| `migrations/0048_kirigo_escrow.sql` | `escrow_holds`, `escrow_moves` (append-only), `kirigo_auth_codes` |
| `worker/kirigo.ts` | the routes below |
| `worker/index.ts` | registers the module and adds three env vars (6 lines) |

It was written against your current `worker/index.ts` and checked: it applies cleanly, `tsc` passes, all 48 migrations
apply, and a full delivery runs against it with real wallets (`apps/api/test/integration.mjs`).

## Apply it

```bash
cd ~/projects/kiripay
git checkout -b kirigo-escrow
git apply ~/projects/kirigo/docs/kiripay-kirigo-escrow.patch
npm run typecheck && npm run db:migrate
```

Then set the secrets (same values as KiriGo's):

```bash
npx wrangler secret put KIRIGO_ESCROW_KEY    # = KiriGo's KIRIPAY_ESCROW_KEY
npx wrangler secret put KIRIGO_SERVICE_KEY   # = KiriGo's KIRIPAY_SERVICE_KEY
# KIRIGO_URL defaults to https://kirigo.online
```

## How the money moves

Each hold is **its own ledger account with no owner** — the same design as your cash vouchers (0030). So:

- nobody can cash it out or spend it;
- `CHECK (balance >= 0)` on accounts means it can never pay out more than was put in;
- a trigger on `escrow_holds` also refuses `released + refunded > amount`, even with two calls at the same moment;
- every move uses your existing `move()` — double entry, idempotency key, `balance_after`, all of it.

| When | Ledger |
|---|---|
| Customer pays (`POST /api/kirigo/orders`) | member wallet → hold account (`transfer`, tag `kirigo_hold`; normal limits, PIN override) |
| Driver at handoff | hold → driver's wallet (`payment`, tag `kirigo_release`) |
| Shop on acceptance | hold → merchant wallet, **KiriPay's merchant fee applies as for any sale** (always taken from what the shop receives) |
| Refund | hold → customer wallet (`transfer`, tag `kirigo_refund`) |
| Shop pays back a customer / return driver | merchant wallet → member wallet (`transfer`, tag `kirigo_charge`) |
| Driver monthly fee | driver wallet → `sys_fees` with VAT split into `sys_vat` (`payment`, tag `kirigo_fee`) |

All `initiated_by = 'kirigo'` except the customer's own payment. Reconcile still balances: hold accounts are ordinary
accounts in the sum.

## Routes

Member (signed in, KiriPay app):
- `POST /api/kirigo/orders` — `{ quoteId, driverId, fallbackDriverIds?, source, sourceRef, goodsCents, deliveryCents, landmark?, sharePhone?, key, pin? }`.
  Holds the money, creates the KiriGo order; if KiriGo refuses (price changed, quote expired…) the hold goes straight back.
- `ANY /api/kirigo/svc/*` — everything else, passed to KiriGo for this member: quotes, order status, handoff QR,
  accept, problem (+ photo upload), discount answer, choose driver, ratings, messages, live-tracking ticket.

KiriGo's server only (`x-kirigo-key: KIRIGO_ESCROW_KEY`):
- `GET /api/internal/escrow/holds/:id`
- `POST /api/internal/escrow/holds/:id/bind` `{ ref }` — once; a hold can't pay for two orders
- `POST /api/internal/escrow/holds/:id/release` `{ to: {kind: 'user'|'merchant', id}, amount, idempotency_key, reference }`
- `POST /api/internal/escrow/holds/:id/refund` `{ amount, idempotency_key, reference }`
- `POST /api/internal/escrow/charges` `{ from, to: {…} | {kind:'fees'}, amount, idempotency_key, reference }`
- `POST /api/internal/kirigo/exchange` `{ code }` — "Sign in with KiriPay" step 3

Browser:
- `GET /kirigo/authorize?state&redirect_uri` — signed in: straight back to KiriGo with a one-time code (5 minutes, once).
  Not signed in: sends them to `/login?next=…`. **Check your login page honours `next`**; if it doesn't, the member
  signs in and then taps "Sign in with KiriPay" again.
- `POST /api/kirigo/webhook` — KiriGo's signed status updates (kept in the audit log for now; wire them into the
  app's notices / push when ready).

## Testing locally with real escrow

```bash
# KiriPay (port 8788), with KIRIGO_URL=http://localhost:8787 and the two keys in .dev.vars
npx wrangler dev --port 8788 --inspector-port 9331
# KiriGo (port 8787) with KIRIPAY_MODE=live, KIRIPAY_URL=http://localhost:8788 and the matching keys
npm run dev
node apps/api/test/integration.mjs    # KP_DIR=~/projects/kiripay KP_JWT_SECRET=<your local JWT_SECRET>
```

The test seeds nothing itself; it expects these rows in the local KiriPay DB (copy into a file and
`npx wrangler d1 execute kiripay --local --file seed.sql`):

```sql
INSERT INTO users (id,email,name,pw_hash,pw_salt,email_verified,kyc_tier) VALUES
 ('u_cust','cust@test.ki','Tekaai Customer','x','x',1,2), ('u_drv','drv@test.ki','Teeta Driver','x','x',1,2),
 ('u_owner','owner@test.ki','Shop Owner','x','x',1,2), ('u_shopwallet','wallet@test.ki','Smoke Shop','x','x',1,2);
UPDATE users SET role='merchant' WHERE id='u_shopwallet';
INSERT INTO accounts (id, owner_id, kind, balance) VALUES ('acc_cust','u_cust','user',100000),('acc_drv','u_drv','user',0),('acc_owner','u_owner','user',0),('acc_shop','u_shopwallet','user',0);
UPDATE accounts SET balance = balance - 100000 WHERE id='sys_cash';
INSERT INTO ledger_transactions (id,type,initiated_by,idempotency_key,reference) VALUES ('tx_seed','deposit','seed','seed1','seed');
INSERT INTO ledger_entries (transaction_id,account_id,amount,balance_after) VALUES ('tx_seed','sys_cash',-100000,-100000),('tx_seed','acc_cust',100000,100000);
INSERT INTO merchants (id,owner_id,wallet_user_id,business_name,website_url,website_host,status,live_enabled) VALUES ('mer_smoke','u_owner','u_shopwallet','Smoke Shop','https://smoke.ki','smoke.ki','approved',1);
```

Result on 11/11/2026: 15/15 checks passed — customer wallet down by goods + delivery, money in the hold, hold can't be
reused, driver +100% at handoff, shop paid only after acceptance, hold closed at zero, nothing more can be released,
cancel refunds in full, a tampered price is refused and returned, ledger still sums to zero.

## For KFSA

KiriPay now holds money in the middle of a sale (escrow), in the ring-fenced customer-funds account. Mention it in the
pilot approval.
