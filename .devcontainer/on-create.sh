#!/usr/bin/env bash
# One-time container setup: install Vite+ (`vp`), the repo's task runner.
set -euo pipefail

# The installer needs the whole VP_*_DIR group or none of it.
export VP_BIN_DIR="$HOME/.local/share/vite-plus/bin"
export VP_DATA_DIR="$HOME/.local/share/vite-plus"
export VP_CACHE_DIR="$HOME/.cache/vite-plus"
# Download to a file first: a failed curl inside $( ) would run an empty script and look like success.
installer=$(mktemp)
curl -fsSL https://vite.plus -o "$installer"
VP_NODE_MANAGER=no bash "$installer"
rm -f "$installer"

# Lifecycle shells don't source the profile the installer edits, so put vp on the default PATH.
test -x "$VP_BIN_DIR/vp"
sudo ln -sf "$VP_BIN_DIR/vp" /usr/local/bin/vp
