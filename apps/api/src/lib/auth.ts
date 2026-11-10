import type { Context, Next } from 'hono';
import { SignJWT, jwtVerify } from 'jose';
import type { AppEnv, Env } from '../env';
import { ApiError, safeEqual } from './util';

/**
 * Three ways in:
 *  1. KiriPay's server, on behalf of a signed-in member (customers): header x-kirigo-key = KIRIPAY_SERVICE_KEY,
 *     x-kirigo-user = the member's KiriPay id. KiriPay already checked who they are.
 *  2. KiriPOS's server, on behalf of a shop: x-kirigo-key = KIRIPOS_SERVICE_KEY; the shop id is in the URL.
 *  3. Drivers and admins: a KiriGo session (Bearer token) from "Sign in with KiriPay".
 */

export function requireKiriPay() {
  return async (c: Context<AppEnv>, next: Next) => {
    const key = c.req.header('x-kirigo-key') ?? '';
    const user = c.req.header('x-kirigo-user') ?? '';
    if (!c.env.KIRIPAY_SERVICE_KEY || !safeEqual(key, c.env.KIRIPAY_SERVICE_KEY)) throw new ApiError('UNAUTHENTICATED', 401);
    if (!/^[A-Za-z0-9_-]{3,80}$/.test(user)) throw new ApiError('NO_USER', 401);
    c.set('actor', { type: 'customer', id: user });
    // KiriPay passes the member's first name so a Trip buddy can see whose trip it is
    const name = (c.req.header('x-kirigo-name') ?? '').slice(0, 40).replace(/[\u0000-\u001f]/g, '').trim();
    if (name) {
      c.executionCtx.waitUntil(c.env.DB.prepare('INSERT INTO customers (id, first_name) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET first_name=excluded.first_name WHERE customers.first_name IS NOT excluded.first_name')
        .bind(user, name).run().catch(() => {}));
    }
    await next();
  };
}

export function requireKiriPos() {
  return async (c: Context<AppEnv>, next: Next) => {
    const key = c.req.header('x-kirigo-key') ?? '';
    if (!c.env.KIRIPOS_SERVICE_KEY || !safeEqual(key, c.env.KIRIPOS_SERVICE_KEY)) throw new ApiError('UNAUTHENTICATED', 401);
    const shopId = c.req.param('shopId') ?? '';
    c.set('actor', { type: 'shop', id: shopId });
    await next();
  };
}

export interface SessionClaims {
  sub: string;          // KiriPay user id
  name: string;
  mfa: boolean;         // two-step sign-in done in KiriPay
  adm: string | null;   // KiriPay admin role, if any
  drv: string | null;   // KiriGo driver id, if they have applied
  kyc: number;          // KiriPay ID-check level (2+ = ID approved)
}

const key = (env: Env) => new TextEncoder().encode(env.SESSION_SECRET);

export async function signSession(env: Env, c: SessionClaims, ttlSec = 12 * 3600): Promise<string> {
  return new SignJWT({ ...c } as any).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(`${ttlSec}s`).setAudience('kirigo').sign(key(env));
}

export async function readSession(env: Env, token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(env), { audience: 'kirigo' });
    return payload as unknown as SessionClaims;
  } catch {
    return null;
  }
}

async function session(c: Context<AppEnv>): Promise<SessionClaims> {
  const h = c.req.header('authorization') ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const s = token ? await readSession(c.env, token) : null;
  if (!s) throw new ApiError('UNAUTHENTICATED', 401);
  return s;
}

/** Any signed-in KiriPay member (used for driver sign-up before a driver row exists). */
export function requireMember() {
  return async (c: Context<AppEnv>, next: Next) => {
    const s = await session(c);
    c.set('actor', { type: 'driver', id: s.drv ?? '', userId: s.sub });
    (c as any).set('session', s);
    await next();
  };
}

/** A driver. Two-step sign-in is required because drivers receive payouts. */
export function requireDriver() {
  return async (c: Context<AppEnv>, next: Next) => {
    const s = await session(c);
    if (!s.mfa) throw new ApiError('TWO_STEP_REQUIRED', 403);
    const d = await c.env.DB.prepare('SELECT id, status FROM drivers WHERE kiripay_user_id=?').bind(s.sub).first<{ id: string; status: string }>();
    if (!d) throw new ApiError('NOT_A_DRIVER', 403);
    if (d.status === 'suspended' || d.status === 'rejected') throw new ApiError('DRIVER_SUSPENDED', 403);
    c.set('actor', { type: 'driver', id: d.id, userId: s.sub });
    await next();
  };
}

/** A KiriPay admin who signed in with two-step. */
export function requireAdmin() {
  return async (c: Context<AppEnv>, next: Next) => {
    const s = await session(c);
    if (!s.adm) throw new ApiError('FORBIDDEN', 403);
    if (!s.mfa) throw new ApiError('TWO_STEP_REQUIRED', 403);
    c.set('actor', { type: 'admin', id: s.sub, role: s.adm });
    await next();
  };
}
