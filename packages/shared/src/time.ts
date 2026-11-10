/** Kiribati (Tarawa) is UTC+12 all year, no daylight saving. */
export const KI_OFFSET_MS = 12 * 3600 * 1000;

/** Minutes past midnight in Kiribati for a UTC instant. */
export function kiMinutesOfDay(at: Date | number): number {
  const d = new Date((typeof at === 'number' ? at : at.getTime()) + KI_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function hhmm(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad time ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** True if `at` is inside [start, end) Kiribati time; handles windows that cross midnight (22:00–06:00). */
export function inKiWindow(at: Date | number, start: string, end: string): boolean {
  const t = kiMinutesOfDay(at), s = hhmm(start), e = hhmm(end);
  return s <= e ? t >= s && t < e : t >= s || t < e;
}

/** After the adults-only time (default 22:00) and before 06:00, only adults may accept a package. */
export function adultsOnly(at: Date | number, after: string, until = '06:00'): boolean {
  return inKiWindow(at, after, until);
}

/** dd/mm/yyyy in Kiribati time. */
export function kiDate(at: Date | number | string): string {
  const ms = typeof at === 'string' ? Date.parse(at) : typeof at === 'number' ? at : at.getTime();
  const d = new Date(ms + KI_OFFSET_MS);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

export function kiDateTime(at: Date | number | string): string {
  const ms = typeof at === 'string' ? Date.parse(at) : typeof at === 'number' ? at : at.getTime();
  const d = new Date(ms + KI_OFFSET_MS);
  return `${kiDate(ms)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export const hoursAgo = (h: number, now = Date.now()) => new Date(now - h * 3600_000).toISOString();
export const minutesFromNow = (m: number, now = Date.now()) => new Date(now + m * 60_000).toISOString();
