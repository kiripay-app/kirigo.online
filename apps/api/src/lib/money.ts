import type { Env } from '../env';
import { kiripay, type MoneyResult, type Party } from './kiripay';
import { newId } from './util';

/**
 * Every money movement goes through here: it is written to money_calls first (status pending) with a
 * unique idempotency key, then sent to KiriPay, then marked done or failed. A failed call that KiriPay
 * might not have received (network, 5xx) is retried by the cron job with the SAME key, so KiriPay can
 * never move it twice.
 */
export type MoneyAction =
  | { action: 'release'; holdId: string; to: Party; toKind: 'driver' | 'shop' | 'customer' }
  | { action: 'refund'; holdId: string }
  | { action: 'charge'; from: Party; to: Party; toKind: 'driver' | 'shop' | 'customer' | 'fees' };

export interface MoneyCall {
  orderId: string | null;
  driverId?: string | null;
  amount: number;
  key: string;
  reference: string;
  move: MoneyAction;
}

const TRANSIENT = /UNREACHABLE|UNAVAILABLE|^HTTP_5|^HTTP_429|TIMEOUT/;
export const isTransient = (code: string) => TRANSIENT.test(code);

export async function moveMoney(env: Env, m: MoneyCall): Promise<MoneyResult> {
  if (!Number.isInteger(m.amount) || m.amount <= 0) return { ok: true, ref: 'nothing_to_move' };
  const existing = await env.DB.prepare('SELECT status, kiripay_ref FROM money_calls WHERE idempotency_key=?').bind(m.key).first<{ status: string; kiripay_ref: string | null }>();
  if (existing?.status === 'done') return { ok: true, ref: existing.kiripay_ref ?? '', duplicate: true };
  const toId = m.move.action === 'refund' ? null : m.move.to.kind === 'fees' ? 'fees' : m.move.to.id;
  const toKind = m.move.action === 'refund' ? 'customer' : m.move.toKind;
  if (!existing) {
    await env.DB.prepare(
      'INSERT INTO money_calls (id, order_id, driver_id, action, to_kind, to_id, amount_cents, idempotency_key, status) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING',
    ).bind(newId('mc'), m.orderId, m.driverId ?? null, m.move.action, toKind, toId, m.amount, m.key, 'pending').run();
  }
  const kp = kiripay(env);
  const mv = m.move;
  const r = mv.action === 'release' ? await kp.release(mv.holdId, mv.to, m.amount, m.key, m.reference)
    : mv.action === 'refund' ? await kp.refund(mv.holdId, m.amount, m.key, m.reference)
    : await kp.charge(mv.from, mv.to, m.amount, m.key, m.reference);
  await env.DB.prepare('UPDATE money_calls SET status=?, kiripay_ref=?, error=? WHERE idempotency_key=?')
    .bind(r.ok ? 'done' : 'failed', r.ok ? r.ref : null, r.ok ? null : r.code, m.key).run();
  return r;
}

/** Re-send money calls that failed for a reason KiriPay may not have seen (cron, every minute). */
export async function retryMoney(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM money_calls WHERE status IN ('pending','failed') AND created_at < ? ORDER BY created_at LIMIT 25",
  ).bind(new Date(Date.now() - 60_000).toISOString()).all<any>();
  let n = 0;
  for (const c of results ?? []) {
    if (c.status === 'failed' && !isTransient(c.error ?? '')) continue;
    const call = await rebuild(env, c);
    if (!call) continue;
    const r = await moveMoney(env, call);
    if (r.ok) n++;
  }
  return n;
}

async function rebuild(env: Env, c: any): Promise<MoneyCall | null> {
  // the hold always comes from the (parent) order
  const o = c.order_id ? await env.DB.prepare('SELECT id, hold_id, parent_order_id, shop_id FROM orders WHERE id=?').bind(c.order_id).first<any>() : null;
  const holdOrder = o?.parent_order_id ? await env.DB.prepare('SELECT hold_id FROM orders WHERE id=?').bind(o.parent_order_id).first<any>() : o;
  const party = (kind: string, id: string): Party => (kind === 'shop' ? { kind: 'merchant', id } : kind === 'fees' ? { kind: 'fees' } : { kind: 'user', id });
  const base = { orderId: c.order_id, driverId: c.driver_id, amount: c.amount_cents, key: c.idempotency_key, reference: `KiriGo ${c.order_id ?? c.driver_id} (retry)` };
  if (c.action === 'refund' && holdOrder?.hold_id) return { ...base, move: { action: 'refund', holdId: holdOrder.hold_id } };
  if (c.action === 'release' && holdOrder?.hold_id) return { ...base, move: { action: 'release', holdId: holdOrder.hold_id, to: party(c.to_kind, c.to_id), toKind: c.to_kind } };
  // charges keep their payer in the key: "<order>:charge:<fromKind>:<fromId>:…"
  if (c.action === 'charge') {
    const m = /:charge:(user|merchant):([^:]+):/.exec(c.idempotency_key);
    if (!m) return null;
    return { ...base, move: { action: 'charge', from: { kind: m[1] as 'user' | 'merchant', id: m[2]! }, to: party(c.to_kind, c.to_id), toKind: c.to_kind } };
  }
  return null;
}
