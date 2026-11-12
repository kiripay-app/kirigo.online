import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../env';
import { signSession } from '../lib/auth';
import { ApiError, newId, nowIso } from '../lib/util';

/**
 * "Sign in with KiriPay" for drivers and admins.
 *   1. /auth/start?app=driver  → KiriPay /kirigo/authorize (the member signs in there, with two-step)
 *   2. KiriPay sends them back to /auth/callback?code=…&state=…
 *   3. KiriGo swaps the one-time code for who they are (server to server) and issues its own session.
 * KiriGo never sees a KiriPay password.
 */
export const auth = new Hono<AppEnv>();

const APPS = ['driver', 'admin'] as const;

auth.get('/start', async (c) => {
  const app = (c.req.query('app') ?? 'driver') as (typeof APPS)[number];
  if (!APPS.includes(app)) throw new ApiError('BAD_APP', 422);
  const state = newId('st');
  await c.env.DB.prepare('INSERT INTO auth_states (state, return_to, created_at) VALUES (?,?,?)').bind(state, app, nowIso()).run();
  const origin = new URL(c.req.url).origin;
  // the sign-in must finish in the same browser/app that started it: a link someone else started can't sign you into their account
  setCookie(c, 'kg_state', state, { httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'Lax', path: '/auth', maxAge: 600 });
  const base = (c.env.KIRIPAY_URL ?? 'https://kiripay.online').replace(/\/$/, '');
  const u = new URL(`${base}/kirigo/authorize`);
  u.searchParams.set('state', state);
  u.searchParams.set('redirect_uri', `${origin}/auth/callback`);
  return c.redirect(u.toString(), 302);
});

auth.get('/callback', async (c) => {
  const code = c.req.query('code') ?? '';
  const state = c.req.query('state') ?? '';
  if (!state || getCookie(c, 'kg_state') !== state) throw new ApiError('SIGN_IN_EXPIRED', 401);
  deleteCookie(c, 'kg_state', { path: '/auth' });
  const st = await c.env.DB.prepare('SELECT * FROM auth_states WHERE state=?').bind(state).first<{ return_to: string; created_at: string }>();
  if (!st || Date.parse(st.created_at) < Date.now() - 10 * 60_000) throw new ApiError('SIGN_IN_EXPIRED', 401);
  await c.env.DB.prepare('DELETE FROM auth_states WHERE state=?').bind(state).run();
  const base = (c.env.KIRIPAY_URL ?? 'https://kiripay.online').replace(/\/$/, '');
  const res = await fetch(`${base}/api/internal/kirigo/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-kirigo-key': c.env.KIRIPAY_ESCROW_KEY ?? '' },
    body: JSON.stringify({ code }), signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new ApiError('SIGN_IN_FAILED', 401);
  const who = await res.json() as { userId: string; firstName: string; mfa: boolean; adminRole: string | null; kycTier?: number };
  const drv = await c.env.DB.prepare('SELECT id FROM drivers WHERE kiripay_user_id=?').bind(who.userId).first<{ id: string }>();
  // admin sessions are short (4 hours) because they can't be revoked early; the driver app keeps 12 hours
  const ttl = st.return_to === 'admin' ? 4 * 3600 : 12 * 3600;
  const token = await signSession(c.env, { sub: who.userId, name: who.firstName, mfa: !!who.mfa, adm: st.return_to === 'admin' ? who.adminRole : null, drv: drv?.id ?? null, kyc: Number(who.kycTier ?? 1) }, ttl);
  // the token goes in the fragment so it never reaches a server log
  return c.redirect(`/${st.return_to}/#token=${encodeURIComponent(token)}`, 302);
});

/** Development only (KIRIPAY_MODE=mock): sign in as anyone. */
auth.get('/dev', async (c) => {
  if (c.env.KIRIPAY_MODE !== 'mock' || c.env.APP_ENV === 'production') throw new ApiError('NOT_FOUND', 404);
  const user = c.req.query('user') ?? 'u_dev';
  const drv = await c.env.DB.prepare('SELECT id FROM drivers WHERE kiripay_user_id=?').bind(user).first<{ id: string }>();
  const token = await signSession(c.env, { sub: user, name: c.req.query('name') ?? 'Dev', mfa: true, adm: c.req.query('admin') ? 'super' : null, drv: drv?.id ?? null, kyc: Number(c.req.query('kyc') ?? 2) });
  return c.json({ token });
});
