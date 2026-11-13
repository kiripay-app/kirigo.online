#!/usr/bin/env bash
# Puts a signed KiriGo Driver APK on kirigo.online/download/kirigo-driver.apk (the GitHub build does this by itself
# when its Cloudflare secrets are set — see docs/driver-app.md).
#   scripts/publish-apk.sh path/to/kirigo-driver.apk 1.0.12 12            version name, then build number
#   NOTES="Louder offer alerts" scripts/publish-apk.sh …                   adds a line of "what's new"
# The build number must be the one the APK was built with (the GitHub run number), or the app's update notice is wrong.
set -euo pipefail
cd "$(dirname "$0")/.."
APK="${1:-}"; VERSION="${2:-}"; CODE="${3:-}"
[ -f "$APK" ] && [ -n "$VERSION" ] && [[ "$CODE" =~ ^[0-9]+$ ]] || { echo "Usage: scripts/publish-apk.sh path/to/kirigo-driver.apk 1.0.<run> <run>"; exit 1; }
INFO=$(mktemp)
APK="$APK" VERSION="$VERSION" CODE="$CODE" NOTES="${NOTES:-}" node -e '
  const fs = require("fs"), crypto = require("crypto"), b = fs.readFileSync(process.env.APK);
  if (b.subarray(0, 2).toString() !== "PK") { console.error("That file is not an APK."); process.exit(1); }
  console.log(JSON.stringify({ version: process.env.VERSION, version_code: +process.env.CODE, size: b.length,
    sha256: crypto.createHash("sha256").update(b).digest("hex"), uploaded_at: new Date().toISOString(), notes: process.env.NOTES || "" }));
' > "$INFO"
echo "Publishing KiriGo Driver $VERSION (build $CODE), $(( $(stat -c%s "$APK") / 1024 / 1024 )) MB…"
npx wrangler r2 object put "kirigo-photos/app/kirigo-driver.apk" --file "$APK" --content-type "application/vnd.android.package-archive" --remote
npx wrangler r2 object put "kirigo-photos/app/kirigo-driver.json" --file "$INFO" --content-type "application/json" --remote
rm -f "$INFO"
echo "Done — https://kirigo.online/download/kirigo-driver.apk"
