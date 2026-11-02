#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$root"
pnpm build
pnpm pack --pack-destination "$work" >/dev/null
tar -xzf "$work"/*.tgz -C "$work"

cd "$work"
ln -s "$root/node_modules" "$work/package/node_modules"
node -e "import('$work/package/dist/config/load.js').then(m => { m.loadConfig({ env: {} }); console.log('pack-smoke ok'); })"
