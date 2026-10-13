#!/bin/sh
set -eu

mac=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$mac")
app="$root/dist/oh-my-usage.app"

# Universal so the Homebrew cask's single zip also runs on Intel Macs.
build() { swift build -c release --package-path "$mac" --arch arm64 --arch x86_64 "$@"; }
build
bin=$(build --show-bin-path)
version=$(plutil -extract version-name raw -o - "$root/src/metadata.json")

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin/OhMyUsage" "$app/Contents/MacOS/OhMyUsage"
cp "$root/src/model.js" "$app/Contents/Resources/model.js"
cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>OhMyUsage</string>
    <key>CFBundleIdentifier</key>
    <string>io.github.ymkthr.oh-my-usage</string>
    <key>CFBundleName</key>
    <string>oh-my-usage</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>$version</string>
    <key>CFBundleVersion</key>
    <string>$version</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
EOF

codesign --force -s - "$app"
echo "$app"
