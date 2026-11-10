import { addToAverage, shouldFlag } from '@kirigo/shared';
import type { Actor, Env } from '../env';
import type { OrderRow } from './orders';
import { ApiError, newId, nowIso } from './util';

type Side = 'customer' | 'shop' | 'driver';
const ALLOWED: Record<Side, Side[]> = { customer: ['shop', 'driver'], driver: ['customer', 'shop'], shop: ['customer', 'driver'] };
const TABLE: Record<Side, string> = { customer: 'customers', shop: 'shops', driver: 'drivers' };

function idOf(o: OrderRow, side: Side): string | null {
  return side === 'customer' ? o.customer_id : side === 'shop' ? o.shop_id : o.driver_id;
}

/**
 * Blind ratings: a rating stays hidden until the person rated has rated back on the same order, or 48 hours
 * pass. Only then does it count in their average — so nobody can retaliate against a rating they've seen.
 */
export async function submitRatings(env: Env, o: OrderRow, from: Actor, items: { to: Side; stars: number; reasons: string[]; comment: string }[]) {
  const fromSide = from.type as Side;
  if (!['ACCEPTED', 'HANDED_OVER', 'PROBLEM_REPORTED', 'REFUNDED', 'NOT_DELIVERED'].includes(o.status)) throw new ApiError('TOO_EARLY_TO_RATE', 409);
  if (idOf(o, fromSide) !== from.id) throw new ApiError('FORBIDDEN', 403);
  const stmts: D1PreparedStatement[] = [];
  for (const it of items) {
    if (!ALLOWED[fromSide]?.includes(it.to)) throw new ApiError('CANNOT_RATE_THEM', 422);
    const toId = idOf(o, it.to);
    if (!toId) throw new ApiError('NOBODY_TO_RATE', 422);
    stmts.push(env.DB.prepare('INSERT INTO ratings (id, order_id, from_type, from_id, to_type, to_id, stars, reasons_json, comment) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(order_id, from_type, to_type) DO NOTHING')
      .bind(newId('rt'), o.id, fromSide, from.id, it.to, toId, it.stars, JSON.stringify(it.reasons), it.comment));
  }
  await env.DB.batch(stmts);
  // anything now answered both ways becomes visible
  const { results } = await env.DB.prepare(`
    SELECT a.id FROM ratings a JOIN ratings b ON b.order_id=a.order_id AND b.from_type=a.to_type AND b.to_type=a.from_type
    WHERE a.order_id=? AND a.visible_at IS NULL`).bind(o.id).all<{ id: string }>();
  for (const r of results ?? []) await reveal(env, r.id);
}

/** Make a rating count. */
export async function reveal(env: Env, ratingId: string) {
  const r = await env.DB.prepare('SELECT * FROM ratings WHERE id=?').bind(ratingId).first<any>();
  if (!r || r.visible_at || r.removed_by) return;
  const upd = await env.DB.prepare('UPDATE ratings SET visible_at=? WHERE id=? AND visible_at IS NULL').bind(nowIso(), ratingId).run();
  if (!upd.meta.changes) return;
  const table = TABLE[r.to_type as Side];
  if (r.to_type === 'customer') {
    await env.DB.prepare('INSERT INTO customers (id) VALUES (?) ON CONFLICT(id) DO NOTHING').bind(r.to_id).run();
  }
  const cur = await env.DB.prepare(`SELECT rating_avg, rating_count FROM ${table} WHERE id=?`).bind(r.to_id).first<{ rating_avg: number | null; rating_count: number }>();
  if (!cur) return;
  const next = addToAverage(cur.rating_avg, cur.rating_count, r.stars);
  await env.DB.prepare(`UPDATE ${table} SET rating_avg=?, rating_count=? WHERE id=?`).bind(next.avg, next.count, r.to_id).run();
}

/** Cron: unblind ratings older than the blind window. */
export async function unblindOld(env: Env, hours: number): Promise<number> {
  const before = new Date(Date.now() - hours * 3600_000).toISOString();
  const { results } = await env.DB.prepare('SELECT id FROM ratings WHERE visible_at IS NULL AND removed_by IS NULL AND created_at < ? LIMIT 200').bind(before).all<{ id: string }>();
  for (const r of results ?? []) await reveal(env, r.id);
  return results?.length ?? 0;
}

/** Admin: remove a rating on appeal (e.g. "not home" but the GPS log shows the driver never reached the pin). */
export async function removeRating(env: Env, ratingId: string, admin: string, reason: string) {
  const r = await env.DB.prepare('SELECT * FROM ratings WHERE id=?').bind(ratingId).first<any>();
  if (!r) throw new ApiError('NOT_FOUND', 404);
  if (r.removed_by) return;
  await env.DB.prepare('UPDATE ratings SET removed_by=?, removed_reason=? WHERE id=?').bind(admin, reason, ratingId).run();
  if (r.visible_at) {
    // recompute the average from what is left
    const table = TABLE[r.to_type as Side];
    const agg = await env.DB.prepare('SELECT AVG(stars) AS a, COUNT(*) AS n FROM ratings WHERE to_type=? AND to_id=? AND visible_at IS NOT NULL AND removed_by IS NULL')
      .bind(r.to_type, r.to_id).first<{ a: number | null; n: number }>();
    await env.DB.prepare(`UPDATE ${table} SET rating_avg=?, rating_count=? WHERE id=?`).bind(agg?.a == null ? null : Math.round(agg.a * 100) / 100, agg?.n ?? 0, r.to_id).run();
  }
}

/** Everyone currently over a review threshold (patterns only). */
export async function flagged(env: Env) {
  const pick = async (kind: 'driver' | 'customer' | 'shop', sql: string) => {
    const { results } = await env.DB.prepare(sql).all<any>();
    return (results ?? []).filter((r) => shouldFlag(kind, r.rating_avg, r.rating_count)).map((r) => ({ kind, ...r }));
  };
  return [
    ...(await pick('driver', 'SELECT id, first_name AS name, driver_code, rating_avg, rating_count, status FROM drivers WHERE rating_count >= 20')),
    ...(await pick('customer', 'SELECT id, first_name AS name, rating_avg, rating_count, delivery_restricted FROM customers WHERE rating_count >= 5')),
    ...(await pick('shop', 'SELECT id, name, rating_avg, rating_count FROM shops WHERE rating_count >= 20')),
  ];
}
