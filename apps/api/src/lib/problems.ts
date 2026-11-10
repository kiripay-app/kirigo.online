import type { ProblemChoice, ProblemReason } from '@kirigo/shared';
import { roadDistance } from '@kirigo/shared';
import type { Actor, Env } from '../env';
import { road } from './matching';
import { notify } from './notify';
import {
  eventStmt, getOrder, holdOrder, settleAccept, settleRefund, shopAtFault, transition, type OrderRow,
} from './orders';
import { claimPhoto } from './photos';
import { loadSettings } from './settings';
import { ApiError, newId, nowIso, plusMs } from './util';

const SYSTEM: Actor = { type: 'system', id: null };

/** A return (customer → shop) or correction (shop → customer) trip, paid from the parent's hold by the shop. */
export async function createChild(env: Env, p: OrderRow, kind: 'return' | 'correction'): Promise<OrderRow> {
  const shop = await env.DB.prepare('SELECT pickup_lat, pickup_lng FROM shops WHERE id=?').bind(p.shop_id).first<{ pickup_lat: number; pickup_lng: number }>();
  if (!shop) throw new ApiError('SHOP_NOT_FOUND', 404);
  const customerPin = { lat: p.drop_lat, lng: p.drop_lng };
  const shopPin = { lat: shop.pickup_lat, lng: shop.pickup_lng };
  const [from, to] = kind === 'return' ? [customerPin, shopPin] : [shopPin, customerPin];
  const seq = await env.DB.prepare('SELECT COUNT(*) AS n FROM orders WHERE parent_order_id=?').bind(p.id).first<{ n: number }>();
  const id = newId('ord');
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO orders (id, kind, parent_order_id, source, source_ref, shop_id, customer_id, pickup_lat, pickup_lng, drop_lat, drop_lng,
      landmark, size, distance_m, goods_cents, delivery_cents, status, share_phone) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,'PAID_HELD',?)`)
      .bind(id, kind, p.id, p.source, `${p.source_ref}#${kind}${(seq?.n ?? 0) + 1}`, p.shop_id, p.customer_id, from.lat, from.lng, to.lat, to.lng,
        p.landmark, p.size, roadDistance(from, to, road(env)), p.share_phone),
    eventStmt(env.DB, id, SYSTEM, 'created', { kind, parent: p.id }),
    eventStmt(env.DB, p.id, SYSTEM, `child:${kind}`, { childId: id }),
  ]);
  const child = await getOrder(env.DB, id);
  await notify(env, child, 'need_driver');
  return child;
}

export async function reportProblem(
  env: Env, o: OrderRow, actor: Actor,
  b: { reason: ProblemReason; choice: ProblemChoice; note: string; photoId: string },
) {
  if (o.status !== 'HANDED_OVER') throw new ApiError('NOT_DELIVERED_YET', 409);
  if (o.kind !== 'delivery' && o.kind !== 'correction') throw new ApiError('NOT_A_DELIVERY', 409);
  if (b.choice === 'swap') throw new ApiError('SWAP_NOT_YET_AVAILABLE', 422);
  await claimPhoto(env, b.photoId, 'problem', o.id, actor);
  const s = await loadSettings(env.DB);
  const p = await holdOrder(env, o);
  let choice: ProblemChoice = b.choice;

  if (o.kind === 'correction') {
    // the correction is wrong too
    const failed = p.failed_corrections + 1;
    await env.DB.prepare('UPDATE orders SET failed_corrections=? WHERE id=?').bind(failed, p.id).run();
    if (failed >= s.max_failed_corrections) choice = 'return'; // automatic full refund once it comes back
    await transition(env, o, 'PROBLEM_REPORTED', actor, { set: { problem_at: nowIso(), problem_reason: b.reason, problem_choice: choice }, data: { photoId: b.photoId } });
    await env.DB.prepare('UPDATE orders SET problem_choice=?, problem_note=? WHERE id=?').bind(choice, b.note, p.id).run();
    if (choice === 'keep') {
      await settleAccept(env, await getOrder(env.DB, p.id), actor, { shopAtFault: true });
      return { parentId: p.id };
    }
    const child = await createChild(env, await getOrder(env.DB, p.id), 'return');
    return { parentId: p.id, returnOrderId: child.id };
  }

  await transition(env, o, 'PROBLEM_REPORTED', actor, {
    set: { problem_at: nowIso(), problem_reason: b.reason, problem_choice: choice, problem_note: b.note },
    data: { photoId: b.photoId, choice },
  });
  await notify(env, o, 'problem:fault_check'); // KiriPOS shows Agree / Dispute (24 h)
  if (choice === 'keep') return { parentId: o.id };
  const child = await createChild(env, await getOrder(env.DB, o.id), 'return');
  return { parentId: o.id, returnOrderId: child.id };
}

/** Shop answers the fault check. No answer in 24 h counts as Agree (cron). */
export async function shopFault(env: Env, p: OrderRow, actor: Actor, response: 'agree' | 'dispute', note: string) {
  if (p.status !== 'PROBLEM_REPORTED') throw new ApiError('NO_PROBLEM_OPEN', 409);
  if (p.shop_fault) throw new ApiError('ALREADY_ANSWERED', 409);
  await env.DB.batch([
    env.DB.prepare('UPDATE orders SET shop_fault=? WHERE id=? AND shop_fault IS NULL').bind(response, p.id),
    eventStmt(env.DB, p.id, actor, `fault:${response}`, { note }),
    ...(response === 'dispute'
      ? [env.DB.prepare('INSERT INTO disputes (id, order_id, reason, due_at) VALUES (?,?,?,?) ON CONFLICT(order_id) DO NOTHING')
          .bind(newId('dsp'), p.id, p.problem_reason ?? 'unknown', plusMs(3 * 86_400_000))]
      : []),
  ]);
  await continueProblem(env, p.id);
}

/** The returned item reached the shop (shop confirmed with a photo, or 24 h passed after the driver's drop). */
export async function returnReceived(env: Env, child: OrderRow, actor: Actor) {
  if (child.kind !== 'return') throw new ApiError('NOT_A_RETURN', 409);
  if (child.status !== 'HANDED_OVER') throw new ApiError('NOT_DROPPED_YET', 409);
  await transition(env, child, 'ACCEPTED', actor, { set: { accepted_at: nowIso(), closed_at: nowIso() }, data: { received: true } });
  await env.DB.prepare('UPDATE orders SET return_received_at=? WHERE id=?').bind(nowIso(), child.parent_order_id).run();
  await continueProblem(env, child.parent_order_id!);
}

/**
 * Move a problem on as far as it can go with what is known: fault answered/ruled? item back at the shop?
 * Called after every relevant change (fault answer, ruling, return received).
 */
export async function continueProblem(env: Env, parentId: string) {
  const p = await getOrder(env.DB, parentId);
  if (p.status !== 'PROBLEM_REPORTED') return;
  const fault = await shopAtFault(env, p);
  if (fault === 'pending') return; // waiting for the shop's answer or an admin ruling

  // keeping the item: settled when the customer takes a discount, by an admin ruling, or by the cron job
  // 24 h after the report (with no discount) — so the shop has time to offer one.
  if (p.problem_choice === 'keep') return;

  if (!p.return_received_at) return; // item not back yet

  if (p.problem_choice === 'correction' && fault === true) {
    const open = await env.DB.prepare("SELECT id FROM orders WHERE parent_order_id=? AND kind='correction' AND status NOT IN ('ACCEPTED','PROBLEM_REPORTED','CANCELLED','REFUNDED','NOT_DELIVERED')").bind(p.id).first();
    const lastCorrectionFailed = await env.DB.prepare("SELECT id FROM orders WHERE parent_order_id=? AND kind='correction' ORDER BY created_at DESC LIMIT 1").bind(p.id).first<{ id: string }>();
    const lastReturn = await env.DB.prepare("SELECT accepted_at FROM orders WHERE parent_order_id=? AND kind='return' ORDER BY created_at DESC LIMIT 1").bind(p.id).first<{ accepted_at: string }>();
    const lastCorr = lastCorrectionFailed ? await getOrder(env.DB, lastCorrectionFailed.id) : null;
    // a new correction is only due if the latest return came back after the latest correction
    if (!open && (!lastCorr || (lastReturn?.accepted_at ?? '') > lastCorr.created_at)) await createChild(env, p, 'correction');
    return;
  }
  await settleRefund(env, p, SYSTEM, { shopAtFault: fault === true });
}

/** A correction trip was accepted by the customer: the shop is paid what is left after its costs. */
export async function correctionAccepted(env: Env, child: OrderRow, actor: Actor) {
  await transition(env, child, 'ACCEPTED', actor, { set: { accepted_at: nowIso(), closed_at: nowIso() } });
  const p = await getOrder(env.DB, child.parent_order_id!);
  await settleAccept(env, p, actor, { shopAtFault: true });
}

/** Shop offers a discount so the customer keeps the item. */
export async function offerDiscount(env: Env, p: OrderRow, actor: Actor, cents: number) {
  if (p.status !== 'PROBLEM_REPORTED' || p.problem_choice !== 'keep') throw new ApiError('NOT_KEEPING', 409);
  if (!Number.isInteger(cents) || cents <= 0 || cents > p.goods_cents) throw new ApiError('INVALID_AMOUNT', 422);
  await env.DB.batch([
    env.DB.prepare('UPDATE orders SET discount_offer_cents=? WHERE id=?').bind(cents, p.id),
    eventStmt(env.DB, p.id, actor, 'discount:offered', { cents }),
  ]);
  await notify(env, p, 'discount:offered');
}

export async function answerDiscount(env: Env, p: OrderRow, actor: Actor, accept: boolean) {
  if (p.discount_offer_cents == null) throw new ApiError('NO_OFFER', 409);
  await env.DB.batch([
    env.DB.prepare('UPDATE orders SET discount_cents=?, discount_offer_cents=? WHERE id=?').bind(accept ? p.discount_offer_cents : 0, accept ? p.discount_offer_cents : null, p.id),
    eventStmt(env.DB, p.id, actor, accept ? 'discount:accepted' : 'discount:declined', { cents: p.discount_offer_cents }),
  ]);
  const fresh = await getOrder(env.DB, p.id);
  // keeping it is the customer's choice; accepting a discount settles it straight away
  if (accept) await settleAccept(env, fresh, actor, { shopAtFault: false });
}
