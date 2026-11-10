/** Tiny client for the KiriGo API with the session from "Sign in with KiriPay". */

const KEY = (app: string) => `kirigo.${app}.token`;

export function captureToken(app: 'driver' | 'admin'): string | null {
  const m = /#token=([^&]+)/.exec(location.hash);
  if (m) {
    localStorage.setItem(KEY(app), decodeURIComponent(m[1]!));
    history.replaceState(null, '', location.pathname);
  }
  return localStorage.getItem(KEY(app));
}

export function setToken(app: 'driver' | 'admin', t: string | null) {
  if (t) localStorage.setItem(KEY(app), t);
  else localStorage.removeItem(KEY(app));
}

export class ApiError extends Error {
  constructor(public code: string, public status: number, public data: any) { super(code); }
}

export function client(app: 'driver' | 'admin', onSignedOut: () => void) {
  async function call<T = any>(path: string, opts: { method?: string; body?: unknown; raw?: Blob; headers?: Record<string, string> } = {}): Promise<T> {
    const token = localStorage.getItem(KEY(app));
    let res: Response;
    try {
      res = await fetch(path, {
        method: opts.method ?? (opts.body || opts.raw ? 'POST' : 'GET'),
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(opts.body ? { 'content-type': 'application/json' } : {}),
          ...(opts.raw ? { 'content-type': opts.raw.type || 'image/jpeg' } : {}),
          ...(opts.headers ?? {}),
        },
        body: opts.raw ?? (opts.body ? JSON.stringify(opts.body) : undefined),
      });
    } catch {
      throw new ApiError('OFFLINE', 0, null);
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { setToken(app, null); onSignedOut(); }
    if (!res.ok) throw new ApiError(data?.error ?? `HTTP_${res.status}`, res.status, data);
    return data as T;
  }
  return call;
}

export const money = (cents: number | null | undefined) => (cents == null ? '—' : `$${(cents / 100).toFixed(2)}`);

/** Plain-language messages for the error codes a driver or admin is likely to see. */
const MESSAGES: Record<string, string> = {
  OFFLINE: 'No internet connection. Try again when you have signal.',
  TWO_STEP_REQUIRED: 'Turn on two-step sign-in in KiriPay first (Settings → Security), then sign in again.',
  NOT_APPROVED_YET: 'Your application is still being checked.',
  MONTHLY_FEE_DUE: 'Your monthly KiriGo fee is due. Pay it to go online.',
  GO_OFFLINE_FIRST: 'Go offline before changing your prices.',
  OFFER_GONE: 'That job was taken or withdrawn.',
  OFFER_EXPIRED: 'Too late — that offer expired.',
  HANDOFF_CODE_WRONG: 'That code or QR is not right for this order.',
  TOO_MANY_TRIES: 'Too many wrong codes. Ask the customer to show the QR.',
  ADULT_REQUIRED: 'After 10 pm only an adult can receive an order.',
  OFFLINE_NEEDS_QR: 'Without signal you must scan the customer’s QR (the typed code needs internet).',
  NOT_AT_SHOP: 'You need to be at the shop to drop off a return.',
  WAIT_A_LITTLE_LONGER: 'Please wait a few minutes at the door before marking it not delivered.',
  SET_THESE_FIRST: 'Set the launch settings first.',
  SIGNUP_CLOSED: 'Driver sign-up is closed right now.',
  ID_CHECK_REQUIRED: 'Your ID needs to be approved in KiriPay first (Verify your account → Level 2).',
};
export const explain = (e: unknown) => {
  if (e instanceof ApiError) return MESSAGES[e.code] ?? e.code.replace(/_/g, ' ').toLowerCase();
  return String(e);
};

/** Read (not verify) the session's claims, to show the right screen. The server checks them properly. */
export function sessionClaims(app: 'driver' | 'admin'): Record<string, any> {
  try {
    const t = localStorage.getItem(`kirigo.${app}.token`) ?? '';
    return JSON.parse(atob(t.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return {}; }
}
