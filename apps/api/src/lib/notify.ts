import { STATUS_LABEL } from '@kirigo/shared';
import type { Env } from '../env';
import type { OrderRow } from './orders';
import { nowIso } from './util';

/**
 * Tell everyone watching an order that something changed:
 *  - the live screens (customer, shop, driver) through the order's Durable Object
 *  - KiriPay (customer app notifications) and KiriPOS (shop Orders page) through signed, retried webhooks
 */
export async function notify(env: Env, o: Pick<OrderRow, 'id' | 'status' | 'shop_id' | 'customer_id' | 'driver_id' | 'source' | 'source_ref' | 'kind' | 'parent_order_id'>, event: string) {
  const msg = {
    type: 'order', event, orderId: o.id, parentOrderId: o.parent_order_id, kind: o.kind, status: o.status, label: STATUS_LABEL[o.status],
    shopId: o.shop_id, customerId: o.customer_id, driverId: o.driver_id, source: o.source, sourceRef: o.source_ref, at: nowIso(),
  };
  try {
    const stub = env.ORDER_TRACKER.get(env.ORDER_TRACKER.idFromName(o.parent_order_id ?? o.id));
    await stub.fetch('https://do/broadcast', { method: 'POST', body: JSON.stringify(msg) });
  } catch { /* live screens catch up on their next poll */ }
  const body = JSON.stringify(msg);
  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO webhooks_out (target, body_json, next_try_at) VALUES (?,?,?)').bind('kiripay', body, at),
    env.DB.prepare('INSERT INTO webhooks_out (target, body_json, next_try_at) VALUES (?,?,?)').bind('kiripos', body, at),
  ]);
}

/** Send queued webhooks (cron). Backs off 1, 2, 4 … minutes, gives up after a day. */
export async function flushWebhooks(env: Env): Promise<number> {
  const { results } = await env.DB.prepare('SELECT * FROM webhooks_out WHERE delivered_at IS NULL AND next_try_at <= ? AND attempts < 12 ORDER BY id LIMIT 50')
    .bind(nowIso()).all<{ id: number; target: 'kiripay' | 'kiripos'; body_json: string; attempts: number }>();
  let sent = 0;
  for (const w of results ?? []) {
    const url = w.target === 'kiripay' ? env.KIRIPAY_URL : env.KIRIPOS_URL;
    const key = w.target === 'kiripay' ? env.KIRIPAY_SERVICE_KEY : env.KIRIPOS_SERVICE_KEY;
    let ok = false;
    if (url && key && env.KIRIPAY_MODE !== 'mock') {
      try {
        const sig = await hmac(key, w.body_json);
        const res = await fetch(`${url.replace(/\/$/, '')}/api/kirigo/webhook`, {
          method: 'POST', body: w.body_json, signal: AbortSignal.timeout(8000),
          headers: { 'content-type': 'application/json', 'x-kirigo-signature': sig },
        });
        ok = res.ok;
      } catch { ok = false; }
    } else {
      ok = true; // nowhere to send yet (local dev): mark done so the queue doesn't grow
    }
    if (ok) {
      await env.DB.prepare('UPDATE webhooks_out SET delivered_at=?, attempts=attempts+1 WHERE id=?').bind(nowIso(), w.id).run();
      sent++;
    } else {
      const next = new Date(Date.now() + 60_000 * 2 ** w.attempts).toISOString();
      await env.DB.prepare('UPDATE webhooks_out SET attempts=attempts+1, next_try_at=? WHERE id=?').bind(next, w.id).run();
    }
  }
  return sent;
}

export async function hmac(secret: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
