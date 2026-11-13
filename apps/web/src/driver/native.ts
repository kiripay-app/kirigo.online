// Only used inside the KiriGo Driver Android app (the same page, wrapped). In a plain browser every function
// here does nothing, so the web driver app keeps working exactly as before.
//  - Phone alerts: registers this phone with Firebase and hands the token to KiriGo, so offers ring the phone
//    even when it's locked or the app is in the background.
//  - Background location: a small "KiriGo Driver is online" notification keeps location coming while the
//    driver uses other apps or the screen is off; positions are posted with the phone's own HTTP (the
//    WebView's requests get throttled in the background).
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';

export const isApp = Capacitor.isNativePlatform();
const BG = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');
const tokenKey = 'kirigo.driver.token';
let watcherId: string | null = null;
let lastSent = 0;

type Call = (path: string, opts?: { method?: string; body?: unknown }) => Promise<any>;

/** Builds from GitHub are numbered by run (2 and up) and carry KiriGo's sounds; the first test builds were all number 1. */
async function hasKiriGoSounds(): Promise<boolean> {
  try { const { App } = await import('@capacitor/app'); return Number((await App.getInfo()).build || 0) > 1; } catch { return false; }
}

/** Ask for alert permission, create the sound channels, and register this phone with KiriGo. */
export async function setupPush(call: Call, onTap: (data: Record<string, string>) => void, onReceive: (data: Record<string, string>) => void = onTap): Promise<'on' | 'off' | 'web'> {
  if (!isApp) return 'web';
  try {
    let p = await PushNotifications.checkPermissions();
    if (p.receive === 'prompt' || p.receive === 'prompt-with-rationale') p = await PushNotifications.requestPermissions();
    if (p.receive !== 'granted') return 'off';
    // Copies of the app built since KiriGo's own sounds were added (numbered builds, 2 and up) have the sound files in
    // res/raw and get channels that play them; older copies keep the old channels, so their alerts are never silent.
    const sounds = await hasKiriGoSounds();
    if (sounds) {
      await PushNotifications.createChannel({ id: 'kirigo_offers', name: 'Job offers', description: 'New delivery and ride offers (you have a minute to accept)', importance: 5, visibility: 1, vibration: true, lights: true, lightColor: '#F59F00', sound: 'kirigo_offer.ogg' });
      await PushNotifications.createChannel({ id: 'kirigo_jobs', name: 'Job updates', description: 'Parcel jobs, cancellations and other news', importance: 4, visibility: 1, vibration: true, sound: 'kirigo_job.ogg' });
      // the old silent-safe channels aren't used any more on this phone
      await PushNotifications.deleteChannel({ id: 'offers' }).catch(() => {});
      await PushNotifications.deleteChannel({ id: 'jobs' }).catch(() => {});
    } else {
      await PushNotifications.createChannel({ id: 'offers', name: 'Job offers', description: 'New delivery and ride offers (you have a minute to accept)', importance: 5, visibility: 1, vibration: true, lights: true, lightColor: '#F59F00' });
      await PushNotifications.createChannel({ id: 'jobs', name: 'Job updates', description: 'Parcel jobs, cancellations and other news', importance: 4, visibility: 1, vibration: true });
    }
    await PushNotifications.removeAllListeners();
    await PushNotifications.addListener('registration', (t) => { void call('/api/driver/push-token', { body: { token: t.value, platform: 'android', sounds } }).catch(() => {}); });
    await PushNotifications.addListener('registrationError', (e) => console.warn('push registration', e));
    await PushNotifications.addListener('pushNotificationActionPerformed', (a) => onTap((a.notification.data ?? {}) as Record<string, string>));
    // the app is open: Android shows no notification (see capacitor.config.json), the app rings with KiriGo's sound
    await PushNotifications.addListener('pushNotificationReceived', (n) => onReceive((n.data ?? {}) as Record<string, string>));
    await PushNotifications.register();
    return 'on';
  } catch (e) { console.warn('push', e); return 'off'; }
}

/** Keep sending location while online, even in the background. onPos also feeds the open screen. */
export async function startBackgroundLocation(onPos: (p: { lat: number; lng: number }) => void): Promise<boolean> {
  if (!isApp || watcherId) return !!watcherId;
  try {
    watcherId = await BG.addWatcher({
      backgroundTitle: 'KiriGo Driver is online',
      backgroundMessage: 'Sharing your location so customers can find you. Go offline in the app to stop.',
      requestPermissions: true, stale: false, distanceFilter: 15,
    }, (loc, err) => {
      if (err) {
        if (err.code === 'NOT_AUTHORIZED' && confirm('KiriGo Driver needs your location to find you jobs. Open settings to allow it?')) void BG.openSettings();
        return;
      }
      if (!loc) return;
      const p = { lat: loc.latitude, lng: loc.longitude };
      onPos(p);
      if (Date.now() - lastSent < 15_000) return;
      lastSent = Date.now();
      const token = localStorage.getItem(tokenKey);
      if (!token) return;
      void CapacitorHttp.post({ url: `${location.origin}/api/driver/position`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, data: p }).catch(() => {});
    });
    return true;
  } catch (e) { console.warn('background location', e); return false; }
}

export async function stopBackgroundLocation() {
  if (!watcherId) return;
  const id = watcherId; watcherId = null;
  await BG.removeWatcher({ id }).catch(() => {});
}

// ------------------------------------------------------------------ app updates (the APK on kirigo.online)

export type PublicApp = { available: boolean; version?: string; version_code?: number; size?: number; url?: string; notes?: string };

/** What's on kirigo.online for download, and (inside the app) whether it's newer than the installed one. */
export async function appUpdate(): Promise<{ app: PublicApp; newer: boolean } | null> {
  try {
    const app = (await (await fetch('/api/public/app')).json()) as PublicApp;
    if (!app.available) return { app, newer: false };
    if (!isApp) return { app, newer: false };
    const { App } = await import('@capacitor/app');
    const info = await App.getInfo();
    return { app, newer: (app.version_code ?? 0) > Number(info.build || 0) };
  } catch { return null; }
}

/**
 * Opens the APK download in Chrome (the app's own web view can't save files). Copies of the app from before
 * the Browser plugin was added can't do this: they get false back and show how to download it by hand.
 */
export async function openDownload(url: string): Promise<boolean> {
  if (!isApp) { location.href = url; return true; }
  if (!Capacitor.isPluginAvailable('Browser')) return false;
  const { Browser } = await import('@capacitor/browser');
  await Browser.open({ url: new URL(url, 'https://kirigo.online').toString() });
  return true;
}
