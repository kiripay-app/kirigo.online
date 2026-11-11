import { vatPortion } from '@kirigo/shared';
import type { Env } from '../env';
import { moveMoney } from './money';
import { loadSettings } from './settings';
import { newId, nowIso } from './util';

const kiPeriod = (ms = Date.now()) => new Date(ms + 12 * 3600_000).toISOString().slice(0, 7);
const addMonth = (iso: string) => { const d = new Date(iso); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString(); };

/**
 * KiriGo's only income: a monthly fee from each driver (VAT included). Drivers keep 100% of delivery charges.
 * Free during the launch period. A driver whose fee is unpaid can't go online; their account stays as it is.
 */
export async function feeStatus(env: Env, d: { free_until: string | null; fee_paid_until: string | null }) {
  const s = await loadSettings(env.DB);
  const now = nowIso();
  const free = !!d.free_until && d.free_until > now;
  const paid = !!d.fee_paid_until && d.fee_paid_until > now;
  const noFeeSet = !s.monthly_fee_cents;
  return {
    canGoOnline: free || paid || noFeeSet,
    freeUntil: d.free_until, paidUntil: d.fee_paid_until,
    amountCents: s.monthly_fee_cents, vatCents: s.monthly_fee_cents ? vatPortion(s.monthly_fee_cents) : 0,
    due: !(free || paid || noFeeSet),
  };
}

export async function chargeMonthlyFee(env: Env, d: any, manual = false) {
  const s = await loadSettings(env.DB);
  const st = await feeStatus(env, d);
  if (!s.monthly_fee_cents) return { charged: false, reason: 'NO_FEE_SET' };
  if (!st.due && !manual) return { charged: false, reason: 'NOT_DUE' };
  const period = kiPeriod();
  const already = await env.DB.prepare("SELECT status FROM driver_fees WHERE driver_id=? AND period=?").bind(d.id, period).first<{ status: string }>();
  if (already?.status === 'paid') return { charged: false, reason: 'ALREADY_PAID' };
  await env.DB.prepare('INSERT INTO driver_fees (id, driver_id, period, amount_cents) VALUES (?,?,?,?) ON CONFLICT(driver_id, period) DO NOTHING')
    .bind(newId('fee'), d.id, period, s.monthly_fee_cents).run();
  const key = `fee:${d.id}:${period}:charge:user:${d.kiripay_user_id}:monthly`;
  const r = await moveMoney(env, {
    orderId: null, driverId: d.id, amount: s.monthly_fee_cents, key, reference: `KiriGo driver fee ${period} (VAT incl.)`,
    move: { action: 'charge', from: { kind: 'user', id: d.kiripay_user_id }, to: { kind: 'fees' }, toKind: 'fees' },
  });
  if (!r.ok) return { charged: false, reason: r.code };
  const base = d.fee_paid_until && d.fee_paid_until > nowIso() ? d.fee_paid_until : nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE driver_fees SET status='paid', money_call_id=? WHERE driver_id=? AND period=?").bind(key, d.id, period),
    env.DB.prepare('UPDATE drivers SET fee_paid_until=? WHERE id=?').bind(addMonth(base), d.id),
  ]);
  return { charged: true, period, amountCents: s.monthly_fee_cents };
}

/** Cron, daily: charge drivers whose free period or last month has run out. */
export async function sweepFees(env: Env): Promise<number> {
  const now = nowIso();
  const { results } = await env.DB.prepare(`SELECT * FROM drivers WHERE status='approved'
    AND (free_until IS NULL OR free_until <= ?) AND (fee_paid_until IS NULL OR fee_paid_until <= ?) LIMIT 100`).bind(now, now).all<any>();
  let n = 0;
  for (const d of results ?? []) {
    const r = await chargeMonthlyFee(env, d);
    if (r.charged) n++;
  }
  return n;
}

/** SQL for "this driver may be offered work": inside the free period, paid up, or no monthly fee is set at all
 *  (the same rule as feeStatus().canGoOnline, so nobody can be online yet invisible). ?1 = now. */
export const feeOkSql = (monthlyFeeCents: number | null | undefined) => (monthlyFeeCents ? '(d.free_until > ?1 OR d.fee_paid_until > ?1)' : '1=1');
