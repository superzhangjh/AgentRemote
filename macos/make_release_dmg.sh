#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(awk '$1 == "version:" { print $2; exit }' "$project_dir/pubspec.yaml")
app="$project_dir/build/macos/Build/Products/Release/Agent 遥控台.app"
output_dir="$project_dir/release/macos"
stage=$(mktemp -d "${TMPDIR:-/tmp}/agentremote-dmg.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM

if [ ! -d "$app" ]; then
  echo "error: Build the macOS Release app first." >&2
  exit 1
fi

mkdir -p "$output_dir"
/usr/bin/ditto "$app" "$stage/Agent 遥控台.app"
ln -s /Applications "$stage/Applications"
/usr/bin/hdiutil create -volname 'Agent 遥控台' -srcfolder "$stage" \
  -ov -format UDZO "$output_dir/AgentRemote-$version-macos-universal.dmg"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$app" \
  "$output_dir/AgentRemote-$version-macos-universal.zip"
