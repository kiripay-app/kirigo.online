import type { Env } from '../env';
import { ApiError } from './util';

/**
 * Client for the KiriPay escrow API (built in the kiripay.online repo, see docs/kiripay-escrow.md).
 * KiriGo never holds money: every movement is one of these calls, each with an idempotency key so a
 * retry can never move money twice.
 *
 * KIRIPAY_MODE=mock swaps in a stand-in backed by two local tables, for development and tests only.
 */

export type Party =
  | { kind: 'user'; id: string }       // a KiriPay member's wallet (customers, drivers)
  | { kind: 'merchant'; id: string }   // a KiriPay merchant's wallet (shops)
  | { kind: 'fees' };                  // KiriPay income (driver monthly fee, VAT split by KiriPay)

export interface Hold {
  id: string;
  payerId: string;
  amount: number;
  released: number;
  refunded: number;
  remaining: number;
  ref: string | null;
  status: 'open' | 'closed';
}

export type MoneyResult = { ok: true; ref: string; duplicate?: boolean } | { ok: false; code: string };

export interface KiriPay {
  getHold(holdId: string): Promise<Hold | null>;
  /** tie a hold to a KiriGo order the first time it is used; fails if it already belongs to another */
  bindHold(holdId: string, orderId: string): Promise<MoneyResult>;
  release(holdId: string, to: Party, amount: number, key: string, reference: string): Promise<MoneyResult>;
  refund(holdId: string, amount: number, key: string, reference: string): Promise<MoneyResult>;
  charge(from: Party, to: Party, amount: number, key: string, reference: string): Promise<MoneyResult>;
}

export function kiripay(env: Env): KiriPay {
  if (env.KIRIPAY_MODE === 'mock') {
    if (env.APP_ENV === 'production') throw new Error('KIRIPAY_MODE=mock is not allowed in production');
    return mockKiriPay(env.DB);
  }
  return liveKiriPay(env);
}

function liveKiriPay(env: Env): KiriPay {
  const base = (env.KIRIPAY_URL ?? 'https://kiripay.online').replace(/\/$/, '');
  if (!env.KIRIPAY_ESCROW_KEY) throw new ApiError('KIRIPAY_NOT_SET_UP', 503);
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> => {
    try {
      const res = await fetch(`${base}/api/internal/escrow${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-kirigo-key': env.KIRIPAY_ESCROW_KEY! },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    } catch {
      return { status: 599, data: { error: 'KIRIPAY_UNREACHABLE' } };
    }
  };
  const result = (r: { status: number; data: any }): MoneyResult =>
    r.status >= 200 && r.status < 300 && r.data?.ref
      ? { ok: true, ref: r.data.ref, duplicate: !!r.data.duplicate }
      : { ok: false, code: r.data?.error ?? r.data?.reason ?? `HTTP_${r.status}` };
  const party = (p: Party) => (p.kind === 'fees' ? { kind: 'fees' } : { kind: p.kind, id: p.id });
  return {
    async getHold(id) {
      const r = await call('GET', `/holds/${encodeURIComponent(id)}`);
      if (r.status === 404) return null;
      if (r.status !== 200) throw new ApiError('KIRIPAY_UNAVAILABLE', 502);
      return r.data as Hold;
    },
    bindHold: async (id, orderId) => result(await call('POST', `/holds/${encodeURIComponent(id)}/bind`, { ref: orderId })),
    release: async (id, to, amount, key, reference) => result(await call('POST', `/holds/${encodeURIComponent(id)}/release`, { to: party(to), amount, idempotency_key: key, reference })),
    refund: async (id, amount, key, reference) => result(await call('POST', `/holds/${encodeURIComponent(id)}/refund`, { amount, idempotency_key: key, reference })),
    charge: async (from, to, amount, key, reference) => result(await call('POST', '/charges', { from: party(from), to: party(to), amount, idempotency_key: key, reference })),
  };
}

/** Development stand-in. Wallet balances are not modelled: charges always succeed unless the
 *  reference contains "[insufficient]", which lets tests exercise the shop-debt path. */
export function mockKiriPay(db: D1Database): KiriPay {
  const done = async (key: string, f: () => Promise<MoneyResult>): Promise<MoneyResult> => {
    const dup = await db.prepare('SELECT key FROM mock_moves WHERE key=?').bind(key).first();
    if (dup) return { ok: true, ref: `mock_${key}`, duplicate: true };
    return f();
  };
  const getHold = async (id: string): Promise<Hold | null> => {
    const h = await db.prepare('SELECT * FROM mock_holds WHERE id=?').bind(id).first<any>();
    if (!h) return null;
    return { id: h.id, payerId: h.payer_id, amount: h.amount, released: h.released, refunded: h.refunded, remaining: h.amount - h.released - h.refunded, ref: h.ref, status: h.status };
  };
  const take = async (id: string, col: 'released' | 'refunded', amount: number, key: string, action: string, to: string | null): Promise<MoneyResult> => {
    const h = await getHold(id);
    if (!h) return { ok: false, code: 'HOLD_NOT_FOUND' };
    if (amount <= 0 || amount > h.remaining) return { ok: false, code: 'MORE_THAN_HELD' };
    await db.batch([
      db.prepare(`UPDATE mock_holds SET ${col} = ${col} + ?, status = CASE WHEN amount - released - refunded - ? = 0 THEN 'closed' ELSE status END WHERE id=?`).bind(amount, amount, id),
      db.prepare('INSERT INTO mock_moves (key, hold_id, action, to_id, amount) VALUES (?,?,?,?,?)').bind(key, id, action, to, amount),
    ]);
    return { ok: true, ref: `mock_${key}` };
  };
  return {
    getHold,
    async bindHold(id, orderId) {
      const h = await getHold(id);
      if (!h) return { ok: false, code: 'HOLD_NOT_FOUND' };
      if (h.ref && h.ref !== orderId) return { ok: false, code: 'HOLD_ALREADY_USED' };
      await db.prepare('UPDATE mock_holds SET ref=? WHERE id=?').bind(orderId, id).run();
      return { ok: true, ref: id };
    },
    release: (id, to, amount, key) => done(key, () => take(id, 'released', amount, key, 'release', to.kind === 'fees' ? 'fees' : `${to.kind}:${to.id}`)),
    refund: (id, amount, key) => done(key, () => take(id, 'refunded', amount, key, 'refund', null)),
    charge: (from, to, amount, key, reference) => done(key, async () => {
      if (reference.includes('[insufficient]')) return { ok: false, code: 'INSUFFICIENT_FUNDS' };
      await db.prepare('INSERT INTO mock_moves (key, action, from_id, to_id, amount) VALUES (?,?,?,?,?)')
        .bind(key, 'charge', from.kind === 'fees' ? 'fees' : `${from.kind}:${from.id}`, to.kind === 'fees' ? 'fees' : `${to.kind}:${to.id}`, amount).run();
      return { ok: true, ref: `mock_${key}` };
    }),
  };
}

/** Test helper: create a mock hold as if the customer had paid in the KiriPay app. */
export async function mockCreateHold(db: D1Database, payerId: string, amount: number): Promise<string> {
  const id = `hld_mock_${crypto.randomUUID().slice(0, 8)}`;
  await db.prepare('INSERT INTO mock_holds (id, payer_id, amount) VALUES (?,?,?)').bind(id, payerId, amount).run();
  return id;
}
