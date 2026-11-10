import { signHandoff, verifyHandoff } from '@kirigo/shared';
import type { Env } from '../env';
import { hmac } from './notify';
import { safeEqual } from './util';

const TOKEN_DAYS = 7;

/** The QR the customer shows at the door. Signed with the server's private key; the driver app checks it offline. */
export function handoffToken(env: Env, orderId: string): string {
  return signHandoff({ o: orderId, exp: Math.floor(Date.now() / 1000) + TOKEN_DAYS * 86400 }, env.HANDOFF_PRIVATE_KEY);
}

/** The 4-digit fallback code. Derived from the order id with a server secret, so nothing to store or leak. */
export async function handoffCode(env: Env, orderId: string): Promise<string> {
  const h = await hmac(env.SESSION_SECRET + ':handoff', orderId);
  return (parseInt(h.slice(0, 8), 16) % 10000).toString().padStart(4, '0');
}

export async function checkHandoff(env: Env, orderId: string, input: { token?: string; code?: string }): Promise<{ ok: true; via: 'qr' | 'code' } | { ok: false; reason: string }> {
  if (input.token) {
    const r = verifyHandoff(input.token, env.HANDOFF_PUBLIC_KEY, orderId);
    return r.ok ? { ok: true, via: 'qr' } : { ok: false, reason: r.reason };
  }
  if (input.code) {
    return safeEqual(input.code, await handoffCode(env, orderId)) ? { ok: true, via: 'code' } : { ok: false, reason: 'wrong_code' };
  }
  return { ok: false, reason: 'missing' };
}

/** Short ticket that lets a screen open the live-tracking socket for one order. */
export async function trackTicket(env: Env, orderId: string, who: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const body = `${orderId}.${who}.${exp}`;
  return `${body}.${(await hmac(env.SESSION_SECRET + ':track', body)).slice(0, 32)}`;
}

export async function readTicket(env: Env, ticket: string): Promise<{ orderId: string; who: string } | null> {
  const parts = ticket.split('.');
  if (parts.length !== 4) return null;
  const [orderId, who, exp, sig] = parts as [string, string, string, string];
  if (Number(exp) < Date.now() / 1000) return null;
  const good = (await hmac(env.SESSION_SECRET + ':track', `${orderId}.${who}.${exp}`)).slice(0, 32);
  return safeEqual(sig, good) ? { orderId, who } : null;
}
