import type { Actor, Env } from '../env';
import { ApiError, newId, nowIso, plusMs } from './util';

export type PhotoKind = 'pickup' | 'handoff' | 'problem' | 'return_receipt' | 'licence' | 'vehicle' | 'selfie';

const MAX_BYTES = 4 * 1024 * 1024;
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Proof photos expire (90 days by default) unless an order on them is in dispute; licence/vehicle photos are kept. */
const EXPIRES: Record<PhotoKind, boolean> = {
  pickup: true, handoff: true, problem: true, return_receipt: true, selfie: true, licence: false, vehicle: false,
};

/**
 * Store an in-app camera photo. The apps only offer the camera (no gallery), and stamp time + GPS;
 * the server records who uploaded it, when, and where they said they were.
 */
export async function savePhoto(env: Env, actor: Actor, req: Request, kind: PhotoKind, orderId: string | null, retentionDays: number): Promise<string> {
  const type = req.headers.get('content-type') ?? '';
  if (!OK_TYPES.includes(type)) throw new ApiError('PHOTO_TYPE', 422);
  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) throw new ApiError('PHOTO_SIZE', 422);
  const lat = Number(req.headers.get('x-photo-lat'));
  const lng = Number(req.headers.get('x-photo-lng'));
  const takenAt = Number(req.headers.get('x-photo-at'));
  const id = newId('ph');
  const r2Key = `${kind}/${orderId ?? 'none'}/${id}`;
  await env.PHOTOS.put(r2Key, buf, {
    httpMetadata: { contentType: type },
    customMetadata: { kind, order: orderId ?? '', by: `${actor.type}:${actor.id}`, lat: String(lat || ''), lng: String(lng || ''), at: String(takenAt || '') },
  });
  await env.DB.prepare(
    'INSERT INTO photos (id, order_id, kind, r2_key, taken_at, lat, lng, taken_by_type, taken_by, delete_after) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).bind(
    id, orderId, kind, r2Key,
    Number.isFinite(takenAt) && takenAt > 0 ? new Date(takenAt).toISOString() : nowIso(),
    Number.isFinite(lat) && lat !== 0 ? lat : null, Number.isFinite(lng) && lng !== 0 ? lng : null,
    actor.type, actor.id ?? 'system',
    EXPIRES[kind] ? plusMs(retentionDays * 86_400_000) : null,
  ).run();
  return id;
}

/** Check a photo exists, is the right kind, and belongs to this order (or none yet). */
export async function claimPhoto(env: Env, photoId: string, kind: PhotoKind, orderId: string | null, by: Actor) {
  const p = await env.DB.prepare('SELECT * FROM photos WHERE id=? AND deleted_at IS NULL').bind(photoId).first<any>();
  if (!p || p.kind !== kind || p.taken_by_type !== by.type || p.taken_by !== by.id) throw new ApiError('PHOTO_NOT_FOUND', 422);
  if (p.order_id && orderId && p.order_id !== orderId) throw new ApiError('PHOTO_NOT_FOUND', 422);
  if (!p.order_id && orderId) await env.DB.prepare('UPDATE photos SET order_id=? WHERE id=?').bind(orderId, photoId).run();
}

/** Who may see which photo: handoff → customer, driver, admin (not the shop); pickup → shop, driver, admin. */
export function canSeePhoto(kind: PhotoKind, viewer: Actor['type']): boolean {
  if (viewer === 'admin') return true;
  switch (kind) {
    case 'handoff': return viewer === 'customer' || viewer === 'driver';
    case 'pickup': return viewer === 'shop' || viewer === 'driver';
    case 'problem': return viewer === 'customer' || viewer === 'shop' || viewer === 'driver';
    case 'return_receipt': return viewer === 'shop' || viewer === 'customer' || viewer === 'driver';
    default: return false;
  }
}

/** Short-lived signed link to a private photo (10 minutes). */
export async function photoUrl(env: Env, photoId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const sig = await sign(env, `${photoId}.${exp}`);
  return `/p/${photoId}?e=${exp}&s=${sig}`;
}

export async function checkPhotoUrl(env: Env, photoId: string, exp: string, sig: string): Promise<boolean> {
  if (Number(exp) < Date.now() / 1000) return false;
  return (await sign(env, `${photoId}.${exp}`)) === sig;
}

async function sign(env: Env, msg: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET + ':photos'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
