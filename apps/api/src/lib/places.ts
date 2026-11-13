// Places: a member's saved spots (Home, Work, …) and shared landmarks pinned by KiriGo admins.
// Picking one fills in the pin, the side of the road and the note for the driver in one tap.
import type { Env } from '../env';
import { ApiError, newId } from './util';

const MAX_SAVED = 20;

interface PlaceRow { id: string; owner_id: string | null; kind: string; label: string; lat: number; lng: number; side: string | null; note: string }
const view = (p: PlaceRow) => ({ id: p.id, kind: p.kind, label: p.label, lat: p.lat, lng: p.lng, side: p.side, note: p.note });

export async function listPlaces(env: Env, ownerId: string) {
  const { results } = await env.DB.prepare(`SELECT * FROM places WHERE active=1 AND (owner_id=? OR owner_id IS NULL)
    ORDER BY owner_id IS NULL, CASE kind WHEN 'home' THEN 0 WHEN 'work' THEN 1 ELSE 2 END, label`).bind(ownerId).all<PlaceRow>();
  const rows = results ?? [];
  return { saved: rows.filter((p) => p.owner_id).map(view), landmarks: rows.filter((p) => !p.owner_id).map(view) };
}

/** Save a place. Home and Work are one each: saving again moves them. */
export async function savePlace(env: Env, ownerId: string, b: { kind: 'home' | 'work' | 'other'; label: string; lat: number; lng: number; side: string | null; note: string }) {
  if (b.kind !== 'other') {
    const old = await env.DB.prepare('SELECT id FROM places WHERE owner_id=? AND kind=? AND active=1').bind(ownerId, b.kind).first<{ id: string }>();
    if (old) {
      await env.DB.prepare('UPDATE places SET label=?, lat=?, lng=?, side=?, note=? WHERE id=?').bind(b.label, b.lat, b.lng, b.side, b.note, old.id).run();
      return old.id;
    }
  }
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM places WHERE owner_id=? AND active=1').bind(ownerId).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_SAVED) throw new ApiError('TOO_MANY_PLACES', 422, { max: MAX_SAVED });
  const id = newId('pl');
  await env.DB.prepare('INSERT INTO places (id, owner_id, kind, label, lat, lng, side, note) VALUES (?,?,?,?,?,?,?,?)')
    .bind(id, ownerId, b.kind, b.label, b.lat, b.lng, b.side, b.note).run();
  return id;
}

export async function deletePlace(env: Env, ownerId: string | null, id: string) {
  const r = ownerId
    ? await env.DB.prepare('UPDATE places SET active=0 WHERE id=? AND owner_id=?').bind(id, ownerId).run()
    : await env.DB.prepare('UPDATE places SET active=0 WHERE id=? AND owner_id IS NULL').bind(id).run();
  if (!r.meta.changes) throw new ApiError('PLACE_NOT_FOUND', 404);
}

export async function addLandmark(env: Env, b: { label: string; lat: number; lng: number; side: string | null; note: string }) {
  const id = newId('lm');
  await env.DB.prepare("INSERT INTO places (id, owner_id, kind, label, lat, lng, side, note) VALUES (?,NULL,'landmark',?,?,?,?,?)")
    .bind(id, b.label, b.lat, b.lng, b.side, b.note).run();
  return id;
}
