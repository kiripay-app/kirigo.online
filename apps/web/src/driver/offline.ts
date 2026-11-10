import { verifyHandoff } from '@kirigo/shared';

/**
 * Handoffs done with no signal. The customer's QR is checked on the phone with KiriGo's public key, the
 * photo and details are saved here, and everything is sent the moment the phone is back online.
 * The driver is paid when it syncs.
 */
const QUEUE = 'kirigo.driver.pending';
const PUBKEY = 'kirigo.driver.handoffKey';

export interface PendingHandoff {
  orderId: string; token: string; at: number; lat: number; lng: number;
  photo: string; // data URL
  receivedBySomeoneElse: boolean; receiverName: string; receiverIsChild: boolean; adultConfirmed: boolean; faceRefused: boolean;
}

export async function refreshKey() {
  try {
    const r = await fetch('/api/handoff-key');
    if (r.ok) localStorage.setItem(PUBKEY, (await r.json()).publicKey);
  } catch { /* keep the saved one */ }
}

export function checkQrOffline(token: string, orderId: string) {
  const key = localStorage.getItem(PUBKEY);
  if (!key) return { ok: false as const, reason: 'no_key' };
  return verifyHandoff(token, key, orderId);
}

export const pending = (): PendingHandoff[] => JSON.parse(localStorage.getItem(QUEUE) ?? '[]');
export function addPending(h: PendingHandoff) {
  localStorage.setItem(QUEUE, JSON.stringify([...pending().filter((p) => p.orderId !== h.orderId), h]));
}
function removePending(ids: string[]) {
  localStorage.setItem(QUEUE, JSON.stringify(pending().filter((p) => !ids.includes(p.orderId))));
}

export const toDataUrl = (b: Blob) => new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(b); });
const fromDataUrl = async (u: string) => (await fetch(u)).blob();

/** Send everything saved offline. Returns how many went through. */
export async function syncPending(call: (p: string, o?: any) => Promise<any>): Promise<number> {
  const list = pending();
  if (!list.length) return 0;
  const handoffs = [];
  for (const h of list) {
    const photo = await call(`/api/driver/photos?kind=handoff&order=${h.orderId}`, {
      raw: await fromDataUrl(h.photo), headers: { 'x-photo-lat': String(h.lat), 'x-photo-lng': String(h.lng), 'x-photo-at': String(h.at) },
    });
    const { photo: _p, ...rest } = h;
    handoffs.push({ ...rest, photoId: photo.photoId });
  }
  const r = await call('/api/driver/sync', { body: { handoffs } });
  const done = (r.results as { orderId: string; ok: boolean }[]).filter((x) => x.ok).map((x) => x.orderId);
  removePending(done);
  return done.length;
}
