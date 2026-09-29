#!/bin/sh
set -eu

if [ "${CONFIGURATION:-}" = Debug ]; then
  exit 0
fi

source_dir="$PROJECT_DIR/../cloudcli"
bundle_dir="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/cloudcli"

for item in package.json package-lock.json dist dist-server public server; do
  if [ ! -e "$source_dir/$item" ]; then
    echo "error: CloudCLI is missing $item; run npm run build in $source_dir" >&2
    exit 1
  fi
done

rm -rf "$bundle_dir"
mkdir -p "$bundle_dir"
for item in package.json package-lock.json dist dist-server public server src shared scripts index.html tsconfig.json LICENSE README.md; do
  if [ -e "$source_dir/$item" ]; then
    /usr/bin/ditto "$source_dir/$item" "$bundle_dir/$item"
  fi
done

# Production installs must not run the repository's Husky prepare hook.
node - "$bundle_dir/package.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
delete pkg.scripts.prepare;
delete pkg.scripts.prepublishOnly;
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
NODE
