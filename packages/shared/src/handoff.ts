import { ed25519 } from '@noble/curves/ed25519';

/**
 * Handoff tokens. The customer's KiriPay app shows a QR holding a token signed by the KiriGo server.
 * The driver app carries the server's PUBLIC key, so it can check the token with no internet.
 * The server checks it again when the handoff syncs.
 *
 * The typed 4-digit code is only accepted ONLINE (server-side, rate limited): four digits could be
 * brute-forced on the driver's own phone, the signed QR cannot.
 */
export interface HandoffPayload {
  /** order id */
  o: string;
  /** expiry, unix seconds */
  exp: number;
}

const te = new TextEncoder();
const td = new TextDecoder();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export function generateKeyPair(): { privateKey: string; publicKey: string } {
  const priv = ed25519.utils.randomPrivateKey();
  return { privateKey: b64url(priv), publicKey: b64url(ed25519.getPublicKey(priv)) };
}

export function signHandoff(payload: HandoffPayload, privateKeyB64: string): string {
  const body = b64url(te.encode(JSON.stringify(payload)));
  const sig = ed25519.sign(te.encode(body), fromB64url(privateKeyB64));
  return `kg1.${body}.${b64url(sig)}`;
}

export type HandoffCheck =
  | { ok: true; payload: HandoffPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_order' };

export function verifyHandoff(token: string, publicKeyB64: string, expectOrderId: string, nowSec = Math.floor(Date.now() / 1000)): HandoffCheck {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'kg1') return { ok: false, reason: 'malformed' };
  const [, body, sig] = parts as [string, string, string];
  let good = false;
  try {
    good = ed25519.verify(fromB64url(sig), te.encode(body), fromB64url(publicKeyB64));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!good) return { ok: false, reason: 'bad_signature' };
  let payload: HandoffPayload;
  try {
    payload = JSON.parse(td.decode(fromB64url(body)));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (payload.o !== expectOrderId) return { ok: false, reason: 'wrong_order' };
  if (payload.exp < nowSec) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

/** A 4-digit code for typing when the QR can't be scanned. Online check only. */
export function newHandoffCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 10000;
  return n.toString().padStart(4, '0');
}
