import type { Context } from 'hono';
import type { ZodTypeAny, output } from 'zod';

export const nowIso = () => new Date().toISOString();
export const plusMs = (ms: number, from = Date.now()) => new Date(from + ms).toISOString();
export const H = 3600_000;
export const MIN = 60_000;

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export class ApiError extends Error {
  constructor(public code: string, public status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 502 | 503 = 400, public extra: Record<string, unknown> = {}) {
    super(code);
  }
}

export async function body<S extends ZodTypeAny>(c: Context, schema: S): Promise<output<S>> {
  const raw = await c.req.json().catch(() => null);
  const r = schema.safeParse(raw ?? {});
  if (!r.success) throw new ApiError('INVALID_INPUT', 422, { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}

export async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string compare for secrets. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Simple sliding-window limiter in D1. Returns false when over the limit. */
export async function takeAttempt(db: D1Database, key: string, max: number, windowMs: number): Promise<boolean> {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = await db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE k=? AND at>=?').bind(key, since).first<{ n: number }>();
  if ((row?.n ?? 0) >= max) return false;
  await db.prepare('INSERT INTO attempts (k, at) VALUES (?, ?)').bind(key, nowIso()).run();
  return true;
}
