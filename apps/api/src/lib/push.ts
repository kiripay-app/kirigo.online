// Phone alerts through Firebase Cloud Messaging (HTTP v1), for drivers using the KiriGo Driver Android app.
// The Firebase service-account key lives in the FCM_SERVICE_ACCOUNT secret; without it nothing is sent and
// everything else carries on (the open app still gets offers over its live connection).
import type { Env } from '../env';

interface ServiceAccount { project_id: string; client_email: string; private_key: string; token_uri?: string }
let cached: { token: string; exp: number; email: string } | null = null;

const b64url = (b: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = ''; for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function account(env: Env): ServiceAccount | null {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  try { const a = JSON.parse(env.FCM_SERVICE_ACCOUNT); return a.project_id && a.client_email && a.private_key ? a : null; } catch { return null; }
}

/** A short-lived Google access token, made by signing a JWT with the service account's key (kept ~50 minutes). */
export async function accessToken(env: Env, fetcher: typeof fetch = fetch): Promise<string | null> {
  const a = account(env);
  if (!a) return null;
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.email === a.client_email && cached.exp > now + 60) return cached.token;
  const tokenUri = a.token_uri ?? 'https://oauth2.googleapis.com/token';
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: a.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: tokenUri, iat: now, exp: now + 3600 }));
  const pem = a.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claims}`));
  const res = await fetcher(tokenUri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${head}.${claims}.${b64url(sig)}` });
  if (!res.ok) { console.error('fcm token', res.status, await res.text().catch(() => '')); return null; }
  const j = await res.json<{ access_token: string; expires_in: number }>();
  cached = { token: j.access_token, exp: now + Math.min(j.expires_in ?? 3600, 3000), email: a.client_email };
  return cached.token;
}

export interface Alert { title: string; body: string; channel: 'offers' | 'jobs'; data: Record<string, string>; ttlS: number }

/** What a driver's phone says for each message the server sends them; null = no phone alert for this one. */
export function alertFor(msg: any): Alert | null {
  switch (msg?.type) {
    case 'offer': return { title: msg.kind === 'ride' ? 'New ride request' : 'New delivery job', body: 'Open KiriGo Driver to accept. It goes to another driver in a minute.', channel: 'offers', data: { type: 'offer', orderId: String(msg.orderId ?? '') }, ttlS: 60 };
    case 'send_won': return { title: 'You got the parcel job', body: 'The sender chose your offer. Open KiriGo Driver for the pickup.', channel: 'jobs', data: { type: 'send_won', orderId: String(msg.orderId ?? '') }, ttlS: 3600 };
    case 'send_job': return { title: 'New parcel to deliver', body: 'Someone is asking for prices. Open Parcels to make an offer.', channel: 'jobs', data: { type: 'send_job', jobId: String(msg.jobId ?? '') }, ttlS: 1800 };
    case 'ride_cancelled': return { title: 'Ride cancelled', body: msg.ridesPaused ? 'The rider cancelled at the photo check. Your rides are paused until KiriGo checks.' : 'The rider cancelled at the photo check.', channel: 'jobs', data: { type: 'ride_cancelled', orderId: String(msg.orderId ?? '') }, ttlS: 3600 };
    default: return null;
  }
}

/** Sends to every phone the driver has registered. Never throws: a failed alert must not fail the job itself. */
export async function sendToDriver(env: Env, driverId: string, alert: Alert, fetcher: typeof fetch = fetch): Promise<number> {
  try {
    const a = account(env);
    if (!a) return 0;
    const { results } = await env.DB.prepare('SELECT token FROM push_tokens WHERE driver_id=?').bind(driverId).all<{ token: string }>();
    if (!results?.length) return 0;
    const at = await accessToken(env, fetcher);
    if (!at) return 0;
    let sent = 0;
    for (const { token } of results) {
      const res = await fetcher(`https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`, {
        method: 'POST', headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: {
          token, data: alert.data,
          notification: { title: alert.title, body: alert.body },
          android: { priority: 'HIGH', ttl: `${alert.ttlS}s`, notification: { channel_id: alert.channel, sound: 'default', default_vibrate_timings: true, notification_priority: 'PRIORITY_MAX', visibility: 'PUBLIC' } },
        } }),
      });
      if (res.ok) { sent++; continue; }
      const text = await res.text().catch(() => '');
      if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT.*registration/i.test(text)) await env.DB.prepare('DELETE FROM push_tokens WHERE token=?').bind(token).run();
      else console.error('fcm send', res.status, text.slice(0, 300));
    }
    return sent;
  } catch (e) { console.error('fcm', e); return 0; }
}

// ------------------------------------------------------------------ admin check ("Send test alert")

export type KeyState = 'missing' | 'invalid' | 'rejected' | 'ok';

/** Is the Firebase key there, readable, and accepted by Google? (Asks Google for a token; cached ~50 minutes.) */
export async function keyState(env: Env, fetcher: typeof fetch = fetch): Promise<{ state: KeyState; projectId: string | null }> {
  if (!env.FCM_SERVICE_ACCOUNT) return { state: 'missing', projectId: null };
  const a = account(env);
  if (!a) return { state: 'invalid', projectId: null };
  try { return { state: (await accessToken(env, fetcher)) ? 'ok' : 'rejected', projectId: a.project_id }; }
  catch { return { state: 'rejected', projectId: a.project_id }; }
}

export interface PhoneResult { phone: string; ok: boolean; removed?: boolean; error?: string }

/**
 * Rings every phone a driver registered, with a test message on the "Job offers" channel, and says what happened
 * to each one. Phones Firebase no longer knows (app uninstalled) are removed, as with real alerts.
 */
export async function testDriver(env: Env, driverId: string, fetcher: typeof fetch = fetch): Promise<{ key: KeyState; phones: PhoneResult[] }> {
  const k = await keyState(env, fetcher);
  if (k.state !== 'ok') return { key: k.state, phones: [] };
  const a = account(env)!;
  const at = (await accessToken(env, fetcher))!;
  const { results } = await env.DB.prepare('SELECT token FROM push_tokens WHERE driver_id=? ORDER BY last_seen_at DESC').bind(driverId).all<{ token: string }>();
  const phones: PhoneResult[] = [];
  for (const [i, { token }] of (results ?? []).entries()) {
    const phone = `Phone ${i + 1} (…${token.slice(-6)})`;
    try {
      const res = await fetcher(`https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`, {
        method: 'POST', headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: {
          token, data: { type: 'test' },
          notification: { title: 'KiriGo test alert', body: 'Phone alerts are working. Nothing to do.' },
          android: { priority: 'HIGH', ttl: '300s', notification: { channel_id: 'offers', sound: 'default', default_vibrate_timings: true, notification_priority: 'PRIORITY_MAX', visibility: 'PUBLIC' } },
        } }),
      });
      if (res.ok) { phones.push({ phone, ok: true }); continue; }
      const text = await res.text().catch(() => '');
      if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT.*registration/i.test(text)) {
        await env.DB.prepare('DELETE FROM push_tokens WHERE token=?').bind(token).run();
        phones.push({ phone, ok: false, removed: true, error: 'The app is no longer on this phone (removed from the list).' });
      } else {
        const m = /"message"\s*:\s*"([^"]{0,160})/.exec(text);
        phones.push({ phone, ok: false, error: `Firebase answered ${res.status}${m ? `: ${m[1]}` : ''}` });
      }
    } catch (e) { phones.push({ phone, ok: false, error: `Couldn't reach Firebase (${String((e as Error)?.message ?? e).slice(0, 80)})` }); }
  }
  return { key: 'ok', phones };
}
