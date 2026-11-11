import type { Env } from '../env';
import { handoffCode } from './handoff';
import { loadSettings } from './settings';
import { nowIso } from './util';

// Texts for people who are NOT on KiriPay. Today: the recipient of a KiriGo Send parcel, who has no app to see the
// driver or their handoff code. KiriPay members never get these: they see everything in the KiriPay app.
//
// KiriGo has no Twilio account of its own. It asks KiriPay to send a fixed TEMPLATE with a few short values
// (POST KIRIPAY_URL/api/internal/sms, x-sms-key = KIRIPAY_SMS_KEY); KiriPay writes the text, applies the
// Kiribati-only and per-number limits, and logs it. Each <order>:<template> is sent at most once.

const EVENTS: Record<string, 'send_on_the_way' | 'send_arrived'> = {
  'status:PICKED_UP': 'send_on_the_way',
  'status:ARRIVED': 'send_arrived',
};
const MAX_AGE_MS = 2 * 3600_000;   // a text this late ("driver on the way") is no use: give up instead

/** Called from notify() on every order change. Queues a text only for a Send parcel going to a non-member. */
export async function queueRecipientSms(env: Env, orderId: string, sendJobId: string | null | undefined, event: string) {
  const template = EVENTS[event];
  if (!template || !sendJobId) return;
  const s = await loadSettings(env.DB);
  if (!s.send_sms_recipients) return;
  const row = await env.DB.prepare(`SELECT o.return_trip, o.driver_id, o.customer_id, j.recipient_name, j.recipient_phone, j.recipient_user_id, j.item,
      d.first_name AS driver_name, d.driver_code, c.first_name AS sender_name
    FROM orders o JOIN send_jobs j ON j.id = o.send_job_id LEFT JOIN drivers d ON d.id = o.driver_id LEFT JOIN customers c ON c.id = o.customer_id
    WHERE o.id = ?`).bind(orderId).first<any>();
  // members see it in the app; a return trip goes back to the sender (a member); no number, nothing to do
  if (!row || row.recipient_user_id || row.return_trip || !row.recipient_phone || !row.driver_name || !row.driver_code) return;
  const values = {
    recipientName: row.recipient_name, senderName: row.sender_name || 'Someone', item: row.item,
    driverName: row.driver_name, driverCode: row.driver_code, code: await handoffCode(env, orderId),
  };
  await env.DB.prepare('INSERT INTO sms_out (ref, order_id, template, to_phone, values_json, next_try_at) VALUES (?,?,?,?,?,?) ON CONFLICT(ref) DO NOTHING')
    .bind(`${orderId}:${template}`, orderId, template, row.recipient_phone, JSON.stringify(values), nowIso()).run();
}

/** Send queued texts (cron, every minute). Retries 1, 2, 4 … minutes; gives up on a permanent "no" or when too late. */
export async function flushSms(env: Env): Promise<number> {
  const { results } = await env.DB.prepare('SELECT * FROM sms_out WHERE sent_at IS NULL AND gave_up_reason IS NULL AND next_try_at <= ? ORDER BY id LIMIT 20')
    .bind(nowIso()).all<{ id: number; ref: string; template: string; to_phone: string; values_json: string; attempts: number; created_at: string }>();
  let sent = 0;
  for (const m of results ?? []) {
    if (Date.parse(m.created_at) < Date.now() - MAX_AGE_MS) {
      await env.DB.prepare('UPDATE sms_out SET gave_up_reason=? WHERE id=?').bind('TOO_LATE', m.id).run();
      continue;
    }
    let status = 0, error = '';
    if (env.KIRIPAY_MODE === 'mock' || !env.KIRIPAY_URL || !env.KIRIPAY_SMS_KEY) {
      if (env.APP_ENV === 'development' || env.KIRIPAY_MODE === 'mock') { console.log(`[sms:mock] ${m.template} to ${m.to_phone} ${m.values_json}`); status = 200; }
      else { status = 503; error = 'SMS_NOT_SET_UP'; }
    } else {
      try {
        const res = await fetch(`${env.KIRIPAY_URL.replace(/\/$/, '')}/api/internal/sms`, {
          method: 'POST', signal: AbortSignal.timeout(10_000),
          headers: { 'content-type': 'application/json', 'x-sms-key': env.KIRIPAY_SMS_KEY },
          body: JSON.stringify({ template: m.template, to: m.to_phone, values: JSON.parse(m.values_json), ref: m.ref }),
        });
        status = res.status;
        error = res.ok ? '' : ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP_${res.status}`;
      } catch { status = 0; error = 'KIRIPAY_UNREACHABLE'; }
    }
    if (status >= 200 && status < 300) {
      await env.DB.prepare('UPDATE sms_out SET sent_at=?, attempts=attempts+1 WHERE id=?').bind(nowIso(), m.id).run();
      sent++;
    } else if (status >= 400 && status < 500) {
      // bad number, not a Kiribati number, number limit, bad values: retrying won't help
      await env.DB.prepare('UPDATE sms_out SET gave_up_reason=?, attempts=attempts+1 WHERE id=?').bind(error || `HTTP_${status}`, m.id).run();
    } else {
      const next = new Date(Date.now() + 60_000 * 2 ** Math.min(m.attempts, 6)).toISOString();
      await env.DB.prepare('UPDATE sms_out SET attempts=attempts+1, next_try_at=? WHERE id=?').bind(next, m.id).run();
    }
  }
  return sent;
}
