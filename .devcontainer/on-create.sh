#!/usr/bin/env bash
# One-time container setup: install Vite+ (`vp`), the repo's task runner.
set -euo pipefail

export VP_BIN_DIR="$HOME/.local/share/vite-plus/bin"
# Download to a file first: a failed curl inside $( ) would run an empty script and look like success.
installer=$(mktemp)
curl -fsSL https://vite.plus -o "$installer"
VP_NODE_MANAGER=no bash "$installer"
rm -f "$installer"

# Lifecycle shells don't source the profile the installer edits, so put vp on the default PATH.
test -x "$VP_BIN_DIR/vp"
sudo ln -sf "$VP_BIN_DIR/vp" /usr/local/bin/vp
