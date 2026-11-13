import { Hono } from 'hono';
import type { AppEnv, Env } from '../env';

/**
 * The KiriGo Driver Android app, downloaded from kirigo.online. The APK and a small description of it live in R2
 * (the kirigo-photos bucket, under app/ — photos are only ever served by their own ids, so these can't be reached that way):
 *   app/kirigo-driver.apk    the signed release APK
 *   app/kirigo-driver.json   { version, version_code, size, sha256, uploaded_at, notes }
 * They're put there by the Android build on GitHub (when its Cloudflare secrets are set) or by apps/api/scripts/publish-apk.sh.
 *
 *  GET /download/kirigo-driver.apk   the file itself (a dropped download on a slow connection can carry on where it stopped)
 *  GET /api/public/app               what's available: the website's download buttons and the in-app "new version" notice use it
 */
export const APK = 'app/kirigo-driver.apk';
export const INFO = 'app/kirigo-driver.json';
type Info = { version: string; version_code: number; size: number; sha256: string; uploaded_at: string; notes?: string };

async function appInfo(env: Env): Promise<Info | null> {
  const obj = await env.PHOTOS.get(INFO);
  if (!obj) return null;
  try { return (await obj.json()) as Info; } catch { return null; }
}

export const appdl = new Hono<AppEnv>();

appdl.get('/api/public/app', async (c) => {
  const info = await appInfo(c.env);
  const available = !!info && !!(await c.env.PHOTOS.head(APK));
  return c.json(available ? { available, ...info, url: '/download/kirigo-driver.apk' } : { available: false }, 200, { 'cache-control': 'public, max-age=60' });
});

appdl.on(['GET', 'HEAD'], '/download/kirigo-driver.apk', async (c) => {
  const head = await c.env.PHOTOS.head(APK);
  if (!head) return c.text("The KiriGo Driver app isn't available for download yet.", 404);
  const info = await appInfo(c.env);
  const headers = new Headers({
    'content-type': 'application/vnd.android.package-archive',
    'content-disposition': `attachment; filename="KiriGo-Driver-${(info?.version ?? 'app').replace(/[^\w.-]/g, '')}.apk"`,
    'cache-control': 'no-cache',
    'accept-ranges': 'bytes',
    etag: head.httpEtag,
  });
  if (c.req.method === 'HEAD') { headers.set('content-length', String(head.size)); return new Response(null, { headers }); }
  const m = /^bytes=(\d+)-(\d*)$/.exec(c.req.header('range') ?? '');
  if (m) {
    const start = Number(m[1]), end = m[2] ? Math.min(Number(m[2]), head.size - 1) : head.size - 1;
    if (start >= head.size || end < start) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${head.size}` } });
    const part = await c.env.PHOTOS.get(APK, { range: { offset: start, length: end - start + 1 } });
    if (!part) return c.text('not found', 404);
    headers.set('content-range', `bytes ${start}-${end}/${head.size}`); headers.set('content-length', String(end - start + 1));
    return new Response(part.body, { status: 206, headers });
  }
  const obj = await c.env.PHOTOS.get(APK);
  if (!obj) return c.text('not found', 404);
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { headers });
});
