#!/bin/bash
# Build "PCB Scope.app" (universal arm64 + x86_64) and a drag-to-Applications DMG into dist/.
#   macos/build.sh            → dist/PCB Scope.app, dist/PCB-Scope-<version>.dmg
#   VERSION=1.2.0 macos/build.sh
# Needs Xcode command-line tools (swiftc, lipo, codesign, hdiutil, iconutil).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${VERSION:-$(cat "$ROOT/VERSION")}"
BUILD="${BUILD:-$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)}"
DIST="$ROOT/dist"
APP="$DIST/PCB Scope.app"
TMP="$DIST/.build"

rm -rf "$APP" "$TMP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$TMP"

echo "• compiling (arm64 + x86_64)"
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos12.0" \
    -o "$TMP/PCBScope-$arch" "$ROOT/macos/main.swift" \
    -framework AppKit -framework WebKit -framework Network
done
lipo -create -output "$APP/Contents/MacOS/PCBScope" "$TMP/PCBScope-arm64" "$TMP/PCBScope-x86_64"

echo "• bundling"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" "$ROOT/macos/Info.plist" > "$APP/Contents/Info.plist"
if [ ! -f "$ROOT/macos/AppIcon.icns" ]; then
  python3 "$ROOT/macos/make_icon.py" "$TMP/AppIcon.iconset"
  iconutil -c icns "$TMP/AppIcon.iconset" -o "$ROOT/macos/AppIcon.icns"
fi
cp "$ROOT/macos/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp -R "$ROOT/web" "$APP/Contents/Resources/web"
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "• signing (ad-hoc)"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

echo "• disk image"
STAGE="$TMP/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
DMG="$DIST/PCB-Scope-$VERSION.dmg"
rm -f "$DMG"
hdiutil create -quiet -volname "PCB Scope $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO "$DMG"
rm -rf "$TMP"

echo "✓ $APP"
echo "✓ $DMG"
