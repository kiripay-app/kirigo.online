# KiriGo Driver Android app

The Android app is the driver web app (kirigo.online/driver) in a wrapper that adds two things a browser can't do:

| | Browser | Android app |
| --- | --- | --- |
| New offers while the screen is off or another app is open | No | Yes: the phone rings (Firebase alert) |
| Location while in the background | Stops after a short while | Keeps going, with a "KiriGo Driver is online" notification |

Everything else (screens, sign-in with KiriPay, jobs) is the same page, so web deploys update the app too.
Only changes to `capacitor.config.json`, the icon/splash in `android-config/res/` or the plugins need a new APK.

## One-time setup

1. Firebase project **KiriGo**, Android app with package `online.kirigo.driver`.
2. `google-services.json` → `apps/web/android-config/google-services.json` (committed; it identifies the app, it is not a password).
3. The Firebase **service account key** → KiriGo secret, never in git:
   `cd apps/api && npx wrangler secret put FCM_SERVICE_ACCOUNT < key.json`, then delete `key.json`.

## Building and publishing

Every push to `main` that touches the app builds it (or GitHub → Actions → **Build KiriGo Driver APK** → Run workflow).
The APK is in the run's **Artifacts** as `kirigo-driver-apk`. Builds are numbered 1.0.<run>.

With the secrets below, the build is **signed** (each one installs over the last) and **published on kirigo.online**:
the homepage and the driver sign-in page get a download button, and drivers' apps show "A new version … is ready".
Without them you get a test build only: not published, and each must be uninstalled before installing the next.

### Signing key (once; keep it forever)

Android only accepts an update signed with the same key as the installed app. Lose the key and every driver has to
uninstall and reinstall, so keep a backup (USB stick and password manager), never in a project folder.

```
keytool -genkeypair -v -keystore ~/kirigo-driver.jks -alias kirigo -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 ~/kirigo-driver.jks > ~/kirigo-driver.jks.b64
```

GitHub → the repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
| --- | --- |
| `KIRIGO_KEYSTORE_BASE64` | the contents of `~/kirigo-driver.jks.b64` (then delete that .b64 file) |
| `KIRIGO_KEYSTORE_PASSWORD` | the keystore password you chose |
| `KIRIGO_KEY_ALIAS` | `kirigo` |
| `KIRIGO_KEY_PASSWORD` | the key password (the same one, if keytool didn't ask separately) |

The first signed build can't install over a test build: uninstall the old app once, then install.

### Publishing from GitHub (Cloudflare token)

Cloudflare dashboard (the account that owns KiriGo) → My Profile → API Tokens → Create Token → Custom token,
permission **Account · Workers R2 Storage · Edit**, for that account only. Then two more GitHub secrets:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID (dashboard → Workers & Pages, right-hand side) |

### Publishing by hand instead

Download a **signed** build's `kirigo-driver-apk` from Actions, unzip it, then:
`cd apps/api && scripts/publish-apk.sh ~/Downloads/kirigo-driver.apk 1.0.<run> <run>` (run = the build number).

## Alerts drivers get

| Event | Channel |
| --- | --- |
| New delivery or ride offer (expires with the offer, 60 s) | Job offers (loudest) |
| Sender chose your parcel offer | Job updates |
| New parcel job near you (only drivers online within 5 km) | Job updates |
| Rider cancelled at the photo check | Job updates |
