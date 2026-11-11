# KiriGo Driver Android app

The Android app is the driver web app (kirigo.online/driver) in a wrapper that adds two things a browser can't do:

| | Browser | Android app |
| --- | --- | --- |
| New offers while the screen is off or another app is open | No | Yes: the phone rings (Firebase alert) |
| Location while in the background | Stops after a short while | Keeps going, with a "KiriGo Driver is online" notification |

Everything else (screens, sign-in with KiriPay, jobs) is the same page, so web deploys update the app too.
Only changes to `capacitor.config.json`, `src/driver/native.ts` or the plugins need a new APK.

## One-time setup

1. Firebase project **KiriGo**, Android app with package `online.kirigo.driver`.
2. `google-services.json` → `apps/web/android-config/google-services.json` (committed; it identifies the app, it is not a password).
3. The Firebase **service account key** → KiriGo secret, never in git:
   `cd apps/api && npx wrangler secret put FCM_SERVICE_ACCOUNT < key.json`, then delete `key.json`.

## Building

GitHub → Actions → **Build KiriGo Driver APK** → Run workflow. When it finishes, download
`kirigo-driver-debug-apk` from the run and install it on the phone (allow "install unknown apps").

## Alerts drivers get

| Event | Channel |
| --- | --- |
| New delivery or ride offer (expires with the offer, 60 s) | Job offers (loudest) |
| Sender chose your parcel offer | Job updates |
| New parcel job near you (only drivers online within 5 km) | Job updates |
| Rider cancelled at the photo check | Job updates |
