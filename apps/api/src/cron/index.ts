import type { Actor, Env } from '../env';
import { sweepFees } from '../lib/fees';
import { expireOffers } from '../lib/matching';
import { retryMoney } from '../lib/money';
import { flushWebhooks, notify } from '../lib/notify';
import { cancelOrder, getOrder, settleAccept, shopAtFault, type OrderRow } from '../lib/orders';
import { continueProblem, returnReceived, shopFault } from '../lib/problems';
import { unblindOld } from '../lib/ratings';
import { overtimeCheck } from '../lib/rides';
import { loadSettings } from '../lib/settings';

const SYSTEM: Actor = { type: 'system', id: null };
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

async function each(env: Env, sql: string, binds: unknown[], f: (o: OrderRow) => Promise<unknown>): Promise<number> {
  const { results } = await env.DB.prepare(sql).bind(...binds).all<OrderRow>();
  let n = 0;
  for (const o of results ?? []) {
    try { await f(o); n++; } catch (e) { console.error(`cron step failed for ${o.id}`, e); }
  }
  return n;
}

/** Every minute. Each job is independent: one failing doesn't stop the others. */
export async function runCron(env: Env, at: Date) {
  const s = await loadSettings(env.DB);
  const jobs: [string, () => Promise<unknown>][] = [
    ['offers', () => expireOffers(env)],
    ['money retries', () => retryMoney(env)],
    ['webhooks', () => flushWebhooks(env)],

    // 24 h after handoff with no problem: the shop is paid (customer reminded 4 h before)
    ['reminders', () => each(env, `SELECT * FROM orders o WHERE status='HANDED_OVER' AND service='delivery' AND kind IN ('delivery','correction') AND handed_over_at < ?
        AND NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_id=o.id AND e.type='reminder:confirm') LIMIT 50`, [ago(s.auto_release_h - 4)], async (o) => {
      await env.DB.prepare('INSERT INTO order_events (order_id, actor_type, type) VALUES (?,?,?)').bind(o.id, 'system', 'reminder:confirm').run();
      await notify(env, o, 'reminder:confirm');
    })],
    ['auto-release', () => each(env, `SELECT * FROM orders WHERE status='HANDED_OVER' AND service='delivery' AND kind IN ('delivery','correction') AND handed_over_at < ? LIMIT 50`, [ago(s.auto_release_h)], async (o) => {
      if (o.kind === 'correction') {
        const { correctionAccepted } = await import('../lib/problems');
        await correctionAccepted(env, o, SYSTEM);
      } else {
        await settleAccept(env, o, SYSTEM, { shopAtFault: false });
      }
    })],

    // shop didn't answer the fault check in 24 h: counts as Agree
    ['fault timeout', () => each(env, `SELECT * FROM orders WHERE status='PROBLEM_REPORTED' AND parent_order_id IS NULL AND shop_fault IS NULL AND problem_at < ? LIMIT 50`,
      [ago(s.shop_fault_response_h)], (o) => shopFault(env, o, SYSTEM, 'agree', 'no answer within the time limit'))],

    // keeping the item: settled 24 h after the report if no discount was taken and nothing is disputed
    ['keep', () => each(env, `SELECT * FROM orders WHERE status='PROBLEM_REPORTED' AND parent_order_id IS NULL AND problem_choice='keep' AND problem_at < ? LIMIT 50`,
      [ago(s.shop_fault_response_h)], async (o) => {
        if ((await shopAtFault(env, o)) === 'pending' && o.shop_fault === 'dispute') return;
        await settleAccept(env, o, SYSTEM, { shopAtFault: false });
      })],

    // return not collected from the customer in 48 h: the problem is closed and the shop is paid
    ['return not handed over', () => each(env, `SELECT * FROM orders WHERE kind='return' AND status IN ('PAID_HELD','DRIVER_ASSIGNED','AT_SHOP') AND created_at < ? LIMIT 50`,
      [ago(s.return_handover_h)], async (child) => {
        await env.DB.prepare("UPDATE offers SET result='withdrawn' WHERE order_id=? AND result IS NULL").bind(child.id).run();
        await cancelOrder(env, child, SYSTEM, 'return_not_handed_over');
        const p = await getOrder(env.DB, child.parent_order_id!);
        if (p.status === 'PROBLEM_REPORTED') await settleAccept(env, p, SYSTEM, { shopAtFault: false });
      })],

    // shop didn't confirm a dropped return in 24 h: the driver's photo + GPS at the shop stand as proof
    ['return receipt', () => each(env, `SELECT * FROM orders WHERE kind='return' AND status='HANDED_OVER' AND handed_over_at < ? LIMIT 50`,
      [ago(s.return_receipt_h)], (child) => returnReceived(env, child, SYSTEM))],

    // problems waiting on nothing any more (e.g. a ruling arrived while the cron was mid-run)
    ['problems', () => each(env, `SELECT * FROM orders WHERE status='PROBLEM_REPORTED' AND parent_order_id IS NULL AND return_received_at IS NOT NULL LIMIT 50`, [],
      (o) => continueProblem(env, o.id))],

    ['ratings', () => unblindOld(env, s.rating_blind_h)],
    ['ride overtime', () => overtimeCheck(env)],
  ];

  // once a day at 00:30 Kiribati (12:30 UTC)
  if (at.getUTCHours() === 12 && at.getUTCMinutes() === 30) {
    jobs.push(
      ['driver fees', () => sweepFees(env)],
      ['photo expiry', () => expirePhotos(env)],
      ['gps expiry', () => env.DB.prepare('DELETE FROM order_routes WHERE created_at < ?').bind(new Date(Date.now() - s.retention_gps_months * 30 * 86_400_000).toISOString()).run()],
      ['housekeeping', () => env.DB.batch([
        env.DB.prepare('DELETE FROM attempts WHERE at < ?').bind(ago(48)),
        env.DB.prepare('DELETE FROM auth_states WHERE created_at < ?').bind(ago(1)),
        env.DB.prepare('DELETE FROM webhooks_out WHERE delivered_at IS NOT NULL AND delivered_at < ?').bind(ago(24 * 30)),
      ])],
    );
  }

  const results = await Promise.allSettled(jobs.map(([, f]) => f()));
  results.forEach((r, i) => { if (r.status === 'rejected') console.error(`cron job failed: ${jobs[i]![0]}`, r.reason); });
}

/** Proof photos past 90 days are deleted, unless their order has an open dispute. */
async function expirePhotos(env: Env) {
  const { results } = await env.DB.prepare(`SELECT p.id, p.r2_key FROM photos p WHERE p.deleted_at IS NULL AND p.delete_after < ?
    AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.order_id = p.order_id AND d.ruled_at IS NULL) LIMIT 500`).bind(new Date().toISOString()).all<{ id: string; r2_key: string }>();
  for (const p of results ?? []) {
    await env.PHOTOS.delete(p.r2_key);
    await env.DB.prepare('UPDATE photos SET deleted_at=? WHERE id=?').bind(new Date().toISOString(), p.id).run();
  }
  return results?.length ?? 0;
}
