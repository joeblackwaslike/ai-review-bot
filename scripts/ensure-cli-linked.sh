#!/usr/bin/env sh
# Keeps the globally npm-linked `ai-review` command current with this repo.
# `npm link` (run once, manually) creates a permanent symlink from the global
# bin to dist/cli.js -- it never needs to be redone. What goes stale is
# dist/cli.js itself, so this rebuilds it after any commit/merge/checkout.
# Runs detached and logs to a tmp file so it never blocks git.
set -eu
cd "$(git rev-parse --show-toplevel)"
(npm run build >/tmp/ai-review-bot-cli-rebuild.log 2>&1 &)
