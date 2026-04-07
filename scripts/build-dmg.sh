#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/build-dmg.sh <version>
# Example: ./scripts/build-dmg.sh 1.0.7

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
    echo "Usage: $0 <version>" >&2
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$REPO_ROOT/.build"
RELEASE_DIR="$BUILD_DIR/release"
STAGING_DIR="$BUILD_DIR/dmg-staging"
APP_DIR="$STAGING_DIR/CodeIsland.app"
CONTENTS_DIR="$APP_DIR/Contents"
OUTPUT_DMG="$BUILD_DIR/CodeIsland.dmg"

echo "==> Building CodeIsland ${VERSION}"

# Build
cd "$REPO_ROOT"
swift build -c release

echo "==> Assembling .app bundle"

# Clean and recreate staging
rm -rf "$STAGING_DIR"
mkdir -p "$CONTENTS_DIR/MacOS"
mkdir -p "$CONTENTS_DIR/Resources"

# Copy binaries
cp "$RELEASE_DIR/CodeIsland" "$CONTENTS_DIR/MacOS/CodeIsland"
cp "$RELEASE_DIR/codeisland-bridge" "$CONTENTS_DIR/MacOS/codeisland-bridge"

# Copy resource bundle (SPM copies Resources/ next to the executable)
if [[ -d "$RELEASE_DIR/CodeIsland_CodeIsland.bundle" ]]; then
    cp -R "$RELEASE_DIR/CodeIsland_CodeIsland.bundle" "$CONTENTS_DIR/Resources/"
elif [[ -d "$RELEASE_DIR/Resources" ]]; then
    cp -R "$RELEASE_DIR/Resources" "$CONTENTS_DIR/Resources/"
fi

# Copy app icon if present
ICNS_SRC="$REPO_ROOT/Sources/CodeIsland/Resources/AppIcon.icns"
if [[ -f "$ICNS_SRC" ]]; then
    cp "$ICNS_SRC" "$CONTENTS_DIR/Resources/AppIcon.icns"
fi

# Write Info.plist
cat > "$CONTENTS_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.codeisland</string>
    <key>CFBundleName</key>
    <string>CodeIsland</string>
    <key>CFBundleExecutable</key>
    <string>CodeIsland</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
</dict>
</plist>
PLIST

echo "==> App bundle assembled at $APP_DIR"

# ---------------------------------------------------------------------------
# Code signing (uncomment when you have an Apple Developer account)
# ---------------------------------------------------------------------------
# TEAM_ID="YOUR_TEAM_ID"
# SIGNING_IDENTITY="Developer ID Application: Your Name (${TEAM_ID})"
#
# codesign --deep --force --options runtime \
#     --entitlements "$REPO_ROOT/CodeIsland.entitlements" \
#     --sign "$SIGNING_IDENTITY" \
#     "$APP_DIR"
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Notarization (uncomment after signing)
# ---------------------------------------------------------------------------
# BUNDLE_ID="com.codeisland"
# APPLE_ID="your@apple.id"
# APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"  # app-specific password
#
# xcrun notarytool submit "$OUTPUT_DMG" \
#     --apple-id "$APPLE_ID" \
#     --password "$APP_PASSWORD" \
#     --team-id "$TEAM_ID" \
#     --wait
#
# xcrun stapler staple "$OUTPUT_DMG"
# ---------------------------------------------------------------------------

echo "==> Creating DMG"

# Remove previous DMG if exists
rm -f "$OUTPUT_DMG"

create-dmg \
    --volname "CodeIsland ${VERSION}" \
    --window-pos 200 120 \
    --window-size 600 400 \
    --icon-size 100 \
    --icon "CodeIsland.app" 175 190 \
    --hide-extension "CodeIsland.app" \
    --app-drop-link 425 190 \
    "$OUTPUT_DMG" \
    "$STAGING_DIR/"

echo "==> Done: $OUTPUT_DMG"
