#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
name="$(jq -r .name "$root/package.json")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$root"
pnpm build
mkdir "$work/pack" "$work/app"
pnpm pack --pack-destination "$work/pack" >/dev/null
tgz="$(ls "$work"/pack/*.tgz)"

cd "$work/app"
echo '{"name":"pack-smoke-app","version":"0.0.0","private":true,"type":"module"}' > package.json
npm install --no-audit --no-fund --loglevel=error "$tgz"
node -e "import('$work/app/node_modules/$name/dist/config/load.js').then(m => { m.loadConfig({ env: {} }); console.log('pack-smoke ok'); })"
