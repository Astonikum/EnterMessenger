#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "macOS packaging requires macOS" >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
target_name="${1:-}"

if [ -n "$target_name" ]; then
  bundle_dir="$project_dir/src-tauri/target/$target_name/release/bundle/macos"
  case "$target_name" in
    aarch64-apple-darwin) architecture="arm64" ;;
    x86_64-apple-darwin) architecture="x86_64" ;;
    *) architecture="$(uname -m)" ;;
  esac
else
  bundle_dir="$project_dir/src-tauri/target/release/bundle/macos"
  architecture="$(uname -m)"
fi

app_path="$bundle_dir/Enter Messenger.app"
test -d "$app_path" || {
  echo "missing Tauri app bundle: $app_path" >&2
  exit 1
}

node "$script_dir/check-macos-bundle.mjs" "$app_path"

version=$(cd "$project_dir" && node -p "require('./package.json').version")
output_path="$bundle_dir/Enter-Messenger_${version}_${architecture}.pkg"
scripts_path="$project_dir/src-tauri/macos/scripts"
test -x "$scripts_path/postinstall" || {
  echo "postinstall script must be executable: $scripts_path/postinstall" >&2
  exit 1
}

rm -f "$output_path"
pkgbuild \
  --identifier "com.enter.messenger.pkg" \
  --version "$version" \
  --component "$app_path" \
  --install-location /Applications \
  --scripts "$scripts_path" \
  "$output_path"

echo "macOS installer: $output_path"
