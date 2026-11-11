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

/** Ask for alert permission, create the sound channels, and register this phone with KiriGo. */
export async function setupPush(call: Call, onTap: (data: Record<string, string>) => void): Promise<'on' | 'off' | 'web'> {
  if (!isApp) return 'web';
  try {
    let p = await PushNotifications.checkPermissions();
    if (p.receive === 'prompt' || p.receive === 'prompt-with-rationale') p = await PushNotifications.requestPermissions();
    if (p.receive !== 'granted') return 'off';
    await PushNotifications.createChannel({ id: 'offers', name: 'Job offers', description: 'New delivery and ride offers (you have a minute to accept)', importance: 5, visibility: 1, vibration: true, lights: true, lightColor: '#F59F00' });
    await PushNotifications.createChannel({ id: 'jobs', name: 'Job updates', description: 'Parcel jobs, cancellations and other news', importance: 4, visibility: 1, vibration: true });
    await PushNotifications.removeAllListeners();
    await PushNotifications.addListener('registration', (t) => { void call('/api/driver/push-token', { body: { token: t.value, platform: 'android' } }).catch(() => {}); });
    await PushNotifications.addListener('registrationError', (e) => console.warn('push registration', e));
    await PushNotifications.addListener('pushNotificationActionPerformed', (a) => onTap((a.notification.data ?? {}) as Record<string, string>));
    await PushNotifications.addListener('pushNotificationReceived', (n) => onTap((n.data ?? {}) as Record<string, string>));
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
