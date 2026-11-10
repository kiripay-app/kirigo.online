import { DEFAULT_SETTINGS, REQUIRED_BEFORE_LAUNCH, type Settings } from '@kirigo/shared';

let cache: { at: number; value: Settings } | null = null;

export async function loadSettings(db: D1Database): Promise<Settings> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const { results } = await db.prepare('SELECT key, value_json FROM settings').all<{ key: string; value_json: string }>();
  const s: Settings = { ...DEFAULT_SETTINGS };
  for (const r of results ?? []) {
    if (r.key in s) {
      try { (s as any)[r.key] = JSON.parse(r.value_json); } catch { /* keep default */ }
    }
  }
  cache = { at: Date.now(), value: s };
  return s;
}

export function clearSettingsCache() { cache = null; }

export async function saveSettings(db: D1Database, patch: Partial<Settings>, by: string): Promise<Settings> {
  const stmts = Object.entries(patch)
    .filter(([k]) => k in DEFAULT_SETTINGS)
    .map(([k, v]) => db.prepare(
      'INSERT INTO settings (key, value_json, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at',
    ).bind(k, JSON.stringify(v), by, new Date().toISOString()));
  if (stmts.length) await db.batch(stmts);
  clearSettingsCache();
  return loadSettings(db);
}

/** Settings that are still blank and block go-live. */
export function missingForLaunch(s: Settings): string[] {
  return REQUIRED_BEFORE_LAUNCH.filter((k) => s[k] == null);
}
