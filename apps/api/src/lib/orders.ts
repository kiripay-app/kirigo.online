import { assertTransition, type OrderStatus } from '@kirigo/shared';
import type { Actor, Env } from '../env';
import { moveMoney } from './money';
import { ApiError, newId, nowIso } from './util';
import { notify } from './notify';

export interface OrderRow {
  id: string; kind: string; parent_order_id: string | null; source: string; source_ref: string;
  shop_id: string; customer_id: string; driver_id: string | null; quote_id: string | null; fallback_json: string;
  pickup_lat: number; pickup_lng: number; drop_lat: number; drop_lng: number; landmark: string; size: string; distance_m: number;
  goods_cents: number; delivery_cents: number; hold_id: string | null; status: OrderStatus; share_phone: number; shop_ready: number;
  handoff_code_hash: string | null; handoff_code_fails: number; driver_paid: number; shop_paid: number;
  extra_cost_cents: number; discount_cents: number; discount_offer_cents: number | null; return_received_at: string | null; failed_corrections: number;
  problem_reason: string | null; problem_choice: string | null; problem_note: string | null; shop_fault: 'agree' | 'dispute' | null;
  offer_driver_id: string | null; offer_expires_at: string | null;
  assigned_at: string | null; picked_up_at: string | null; handed_over_at: string | null; accepted_at: string | null;
  problem_at: string | null; closed_at: string | null; created_at: string;
  service: 'delivery' | 'ride'; seats: number; at_pickup_at: string | null; waiting_cents: number; eta_s: number | null;
  emergency_at: string | null; drop_note: string;
  send_job_id: string | null; deliver_by: string | null; return_trip: number;
  pickup_side: "lagoon" | "ocean" | null; drop_side: "lagoon" | "ocean" | null; here_at: string | null;
}

export async function getOrder(db: D1Database, id: string): Promise<OrderRow> {
  const o = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first<OrderRow>();
  if (!o) throw new ApiError('ORDER_NOT_FOUND', 404);
  return o;
}

export function eventStmt(db: D1Database, orderId: string, actor: Actor, type: string, data?: unknown, at?: { lat: number; lng: number } | null) {
  return db.prepare('INSERT INTO order_events (order_id, actor_type, actor_id, type, data_json, lat, lng) VALUES (?,?,?,?,?,?,?)')
    .bind(orderId, actor.type, actor.id, type, data === undefined ? null : JSON.stringify(data), at?.lat ?? null, at?.lng ?? null);
}

export async function logEvent(env: Env, orderId: string, actor: Actor, type: string, data?: unknown, at?: { lat: number; lng: number } | null) {
  await eventStmt(env.DB, orderId, actor, type, data, at).run();
}

/**
 * Move an order to a new status. Only the transitions in the shared state machine are allowed, the update
 * only applies if nobody else changed the status first (optimistic check), and one event row is written
 * in the same batch.
 */
export async function transition(
  env: Env, o: OrderRow, to: OrderStatus, actor: Actor,
  opts: { set?: Record<string, unknown>; data?: unknown; at?: { lat: number; lng: number } | null } = {},
): Promise<OrderRow> {
  assertTransition(o.status, to);
  const set = { status: to, ...(opts.set ?? {}) };
  const cols = Object.keys(set);
  const upd = env.DB.prepare(`UPDATE orders SET ${cols.map((c) => `${c}=?`).join(', ')} WHERE id=? AND status=?`)
    .bind(...cols.map((c) => (set as any)[c]), o.id, o.status);
  const [r] = await env.DB.batch([upd, eventStmt(env.DB, o.id, actor, `status:${to}`, { from: o.status, ...(opts.data as object ?? {}) }, opts.at)]);
  if (!r?.meta.changes) throw new ApiError('ORDER_CHANGED', 409);
  const next = { ...o, ...set } as OrderRow;
  await notify(env, next, `status:${to}`);
  return next;
}

// ------------------------------------------------------------------ money helpers

async function driverUserId(env: Env, driverId: string): Promise<string> {
  const d = await env.DB.prepare('SELECT kiripay_user_id FROM drivers WHERE id=?').bind(driverId).first<{ kiripay_user_id: string }>();
  if (!d) throw new ApiError('DRIVER_NOT_FOUND', 404);
  return d.kiripay_user_id;
}

async function shopMerchant(env: Env, shopId: string): Promise<string> {
  const s = await env.DB.prepare('SELECT kiripay_merchant_id FROM shops WHERE id=?').bind(shopId).first<{ kiripay_merchant_id: string }>();
  if (!s) throw new ApiError('SHOP_NOT_FOUND', 404);
  return s.kiripay_merchant_id;
}

/** The order that owns the KiriPay hold (a child trip pays from its parent's hold). */
export async function holdOrder(env: Env, o: OrderRow): Promise<OrderRow> {
  return o.parent_order_id ? getOrder(env.DB, o.parent_order_id) : o;
}

/** Goods money still in the hold, after shop-fault trips already paid out of it. */
export function goodsLeft(p: OrderRow): number {
  return Math.max(0, p.goods_cents - p.extra_cost_cents);
}

/**
 * Pay the driver of `o` at handoff. Parent delivery: the delivery charge from the hold.
 * Child trip (return/correction): the trip charge from the parent's goods money (the shop pays for its
 * own mistakes); if that runs out, from the shop's wallet; if that is short too, a shop debt.
 */
export async function payDriver(env: Env, o: OrderRow): Promise<void> {
  if (o.driver_paid || !o.driver_id) return;
  const to = { kind: 'user' as const, id: await driverUserId(env, o.driver_id) };
  const p = await holdOrder(env, o);
  const ref = `KiriGo delivery ${o.id}`;
  if (o.id === p.id) {
    const r = await moveMoney(env, { orderId: o.id, driverId: o.driver_id, amount: o.delivery_cents, key: `${o.id}:release:driver`, reference: ref, move: { action: 'release', holdId: p.hold_id!, to, toKind: 'driver' } });
    if (!r.ok) throw new ApiError('PAYOUT_FAILED', 502, { code: r.code });
  } else {
    const fromHold = Math.min(o.delivery_cents, goodsLeft(p));
    if (fromHold > 0) {
      const r = await moveMoney(env, { orderId: o.id, driverId: o.driver_id, amount: fromHold, key: `${o.id}:release:driver`, reference: ref, move: { action: 'release', holdId: p.hold_id!, to, toKind: 'driver' } });
      if (!r.ok) throw new ApiError('PAYOUT_FAILED', 502, { code: r.code });
      await env.DB.prepare('UPDATE orders SET extra_cost_cents = extra_cost_cents + ? WHERE id=?').bind(fromHold, p.id).run();
    }
    const rest = o.delivery_cents - fromHold;
    if (rest > 0) await chargeShop(env, p, rest, { kind: 'driver', id: to.id }, `${o.id}:driver-rest`);
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE orders SET driver_paid=1 WHERE id=?').bind(o.id),
    env.DB.prepare('UPDATE drivers SET deliveries = deliveries + 1 WHERE id=?').bind(o.driver_id),
    eventStmt(env.DB, o.id, { type: 'system', id: null }, 'money:driver_paid', { cents: o.delivery_cents }),
  ]);
}

/** Take money from the shop's wallet for someone it owes. Short of funds → recorded as a debt, recovered from its next release. */
async function chargeShop(env: Env, p: OrderRow, amount: number, creditor: { kind: 'customer' | 'driver'; id: string }, tag: string) {
  if (amount <= 0) return;
  const merchant = await shopMerchant(env, p.shop_id);
  const r = await moveMoney(env, {
    orderId: p.id, amount, key: `${p.id}:charge:merchant:${merchant}:${tag}`, reference: `KiriGo ${p.id}: shop pays ${creditor.kind}`,
    move: { action: 'charge', from: { kind: 'merchant', id: merchant }, to: { kind: 'user', id: creditor.id }, toKind: creditor.kind },
  });
  if (!r.ok) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO shop_debts (id, shop_id, order_id, creditor_kind, creditor_id, amount_cents) VALUES (?,?,?,?,?,?)')
        .bind(newId('debt'), p.shop_id, p.id, creditor.kind, creditor.id, amount),
      eventStmt(env.DB, p.id, { type: 'system', id: null }, 'money:shop_debt', { cents: amount, creditor: creditor.kind, reason: r.code }),
    ]);
  }
}

/** Pay outstanding shop debts out of money that would otherwise go to the shop. Returns what is left for the shop. */
async function settleDebts(env: Env, p: OrderRow, available: number): Promise<number> {
  if (available <= 0) return available;
  const { results } = await env.DB.prepare('SELECT * FROM shop_debts WHERE shop_id=? AND settled_cents < amount_cents ORDER BY created_at').bind(p.shop_id).all<any>();
  let left = available;
  for (const d of results ?? []) {
    if (left <= 0) break;
    const pay = Math.min(left, d.amount_cents - d.settled_cents);
    const r = await moveMoney(env, {
      orderId: p.id, amount: pay, key: `${p.id}:release:debt:${d.id}`, reference: `KiriGo: shop debt from ${d.order_id}`,
      move: { action: 'release', holdId: p.hold_id!, to: { kind: 'user', id: d.creditor_id }, toKind: d.creditor_kind },
    });
    if (!r.ok) break;
    await env.DB.prepare('UPDATE shop_debts SET settled_cents = settled_cents + ? WHERE id=?').bind(pay, d.id).run();
    left -= pay;
  }
  return left;
}

/**
 * Close a parent order in the shop's favour: the shop gets the goods money left, less any discount the
 * customer accepted, and — when the shop was at fault — less the original delivery charge, which goes back
 * to the customer. Whatever the shop owes beyond its goods money is charged to its wallet.
 */
export async function settleAccept(env: Env, p: OrderRow, actor: Actor, opts: { shopAtFault: boolean; partialRefund?: number } = { shopAtFault: false }) {
  if (p.parent_order_id) throw new Error('settleAccept on a child order');
  if (p.service === 'ride') throw new Error('settleAccept on a ride');
  if (p.shop_paid) return;
  const inHold = goodsLeft(p);
  const owedToCustomer = p.discount_cents + (opts.partialRefund ?? 0) + (opts.shopAtFault ? p.delivery_cents : 0);
  const fromHold = Math.min(inHold, owedToCustomer);
  if (fromHold > 0) {
    const r = await moveMoney(env, { orderId: p.id, amount: fromHold, key: `${p.id}:refund:accept`, reference: `KiriGo ${p.id}: refund`, move: { action: 'refund', holdId: p.hold_id! } });
    if (!r.ok) throw new ApiError('REFUND_FAILED', 502, { code: r.code });
  }
  // the shop owes the customer more than its goods money: the rest comes from its wallet
  if (owedToCustomer > fromHold) await chargeShop(env, p, owedToCustomer - fromHold, { kind: 'customer', id: p.customer_id }, 'accept');
  const shopShare = await settleDebts(env, p, inHold - fromHold);
  if (shopShare > 0) {
    const r = await moveMoney(env, {
      orderId: p.id, amount: shopShare, key: `${p.id}:release:shop`, reference: `KiriGo ${p.id}: goods`,
      move: { action: 'release', holdId: p.hold_id!, to: { kind: 'merchant', id: await shopMerchant(env, p.shop_id) }, toKind: 'shop' },
    });
    if (!r.ok) throw new ApiError('PAYOUT_FAILED', 502, { code: r.code });
  }
  await env.DB.prepare('UPDATE orders SET shop_paid=1 WHERE id=?').bind(p.id).run();
  const fresh = await getOrder(env.DB, p.id);
  await transition(env, fresh, 'ACCEPTED', actor, { set: { accepted_at: nowIso(), closed_at: nowIso() }, data: { shopCents: shopShare, refundCents: owedToCustomer } });
}

/**
 * Close a parent order with a refund: everything left in the hold goes back to the customer. If the shop was
 * at fault the customer also gets back the delivery charge and any return trips, charged to the shop.
 * If the customer was at fault they have paid the return trip out of their own goods money.
 */
export async function settleRefund(env: Env, p: OrderRow, actor: Actor, opts: { shopAtFault: boolean }) {
  if (p.parent_order_id) throw new Error('settleRefund on a child order');
  const left = goodsLeft(p);
  if (left > 0) {
    const r = await moveMoney(env, { orderId: p.id, amount: left, key: `${p.id}:refund:all`, reference: `KiriGo ${p.id}: refund`, move: { action: 'refund', holdId: p.hold_id! } });
    if (!r.ok) throw new ApiError('REFUND_FAILED', 502, { code: r.code });
  }
  if (opts.shopAtFault) await chargeShop(env, p, p.extra_cost_cents + p.delivery_cents, { kind: 'customer', id: p.customer_id }, 'refund');
  const fresh = await getOrder(env.DB, p.id);
  await transition(env, fresh, 'REFUNDED', actor, { set: { closed_at: nowIso() }, data: { refundCents: left, shopAtFault: opts.shopAtFault } });
}

/** Cancel before pickup: the whole hold goes back to the customer. */
export async function cancelOrder(env: Env, o: OrderRow, actor: Actor, reason: string) {
  if (o.parent_order_id) {
    await transition(env, o, 'CANCELLED', actor, { set: { closed_at: nowIso() }, data: { reason } });
    return;
  }
  const hold = o.goods_cents + o.delivery_cents;
  const r = await moveMoney(env, { orderId: o.id, amount: hold, key: `${o.id}:refund:cancel`, reference: `KiriGo ${o.id}: cancelled`, move: { action: 'refund', holdId: o.hold_id! } });
  if (!r.ok) throw new ApiError('REFUND_FAILED', 502, { code: r.code });
  await transition(env, o, 'CANCELLED', actor, { set: { closed_at: nowIso() }, data: { reason } });
}

/** Could not hand over (no adult after 22:00, nobody home): the driver is paid, the goods are refunded. */
export async function notDelivered(env: Env, o: OrderRow, actor: Actor, reason: string) {
  await payDriver(env, o);
  if (!o.parent_order_id) {
    const r = await moveMoney(env, { orderId: o.id, amount: o.goods_cents, key: `${o.id}:refund:not_delivered`, reference: `KiriGo ${o.id}: not delivered`, move: { action: 'refund', holdId: o.hold_id! } });
    if (!r.ok) throw new ApiError('REFUND_FAILED', 502, { code: r.code });
  }
  const fresh = await getOrder(env.DB, o.id);
  await transition(env, fresh, 'NOT_DELIVERED', actor, { set: { closed_at: nowIso() }, data: { reason } });
}

/** Is the shop at fault for a problem? Shop agreed (or didn't answer), or an admin ruled against it. */
export async function shopAtFault(env: Env, p: OrderRow): Promise<boolean | 'pending'> {
  if (p.shop_fault === 'agree') return true;
  if (p.shop_fault === 'dispute') {
    const d = await env.DB.prepare('SELECT at_fault, ruled_at FROM disputes WHERE order_id=?').bind(p.id).first<{ at_fault: string | null; ruled_at: string | null }>();
    if (!d?.ruled_at) return 'pending';
    return d.at_fault === 'shop';
  }
  return 'pending';
}
