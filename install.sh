#!/usr/bin/env bash
# Official 1-Line Native macOS & Linux Installer for Antigravity Account Switcher.
# Zero-dependency installer: Downloads, deploys, and hot-reloads the switcher plugin.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/sohrabezzati/antigravity-account-switcher/master/install.sh | bash

set -e

echo ""
echo -e "\033[1;36m  🌌 Antigravity Account Switcher • Installer\033[0m"
echo -e "\033[0;90m  ──────────────────────────────────────────\033[0m"

PLUGINS_DIR="$HOME/.gemini/config/plugins"
TARGET_DIR="$PLUGINS_DIR/antigravity-account-switcher"
REPO_ZIP_URL="https://github.com/sohrabezzati/antigravity-account-switcher/archive/refs/heads/master.tar.gz"
TEMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t 'agy-switcher')"

# 1. Ensure target directory exists
mkdir -p "$PLUGINS_DIR"

echo -e "\033[1;33m  ⏳ Downloading latest release from GitHub...\033[0m"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$REPO_ZIP_URL" -o "$TEMP_DIR/archive.tar.gz"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TEMP_DIR/archive.tar.gz" "$REPO_ZIP_URL"
else
  echo -e "\033[1;31m  ❌ Error: Neither curl nor wget was found on this system.\033[0m"
  rm -rf "$TEMP_DIR"
  exit 1
fi

# 2. Extract archive
echo -e "\033[1;33m  📦 Extracting plugin files...\033[0m"
tar -xzf "$TEMP_DIR/archive.tar.gz" -C "$TEMP_DIR"

EXTRACTED_FOLDER="$(find "$TEMP_DIR" -maxdepth 1 -type d -name "antigravity-account-switcher-*" | head -n 1)"
if [ -z "$EXTRACTED_FOLDER" ] || [ ! -d "$EXTRACTED_FOLDER" ]; then
  echo -e "\033[1;31m  ❌ Extraction folder not found.\033[0m"
  rm -rf "$TEMP_DIR"
  exit 1
fi

# 3. Deploy to Antigravity Plugins directory
echo -e "\033[1;33m  ⚡ Installing to $TARGET_DIR...\033[0m"
mkdir -p "$TARGET_DIR"

# Preserve existing profiles or local vault if present
if [ -d "$TARGET_DIR/vault" ]; then
  cp -r "$TARGET_DIR/vault" "$TEMP_DIR/_backup_vault" 2>/dev/null || true
fi

cp -R "$EXTRACTED_FOLDER"/. "$TARGET_DIR"/

if [ -d "$TEMP_DIR/_backup_vault" ]; then
  cp -r "$TEMP_DIR/_backup_vault"/* "$TARGET_DIR/vault/" 2>/dev/null || true
fi

rm -rf "$TEMP_DIR"

# 4. Trigger Live Hot-Reload if Antigravity / Node is active
if command -v node >/dev/null 2>&1 && [ -f "$TARGET_DIR/scripts/install-plugin.js" ]; then
  node "$TARGET_DIR/scripts/install-plugin.js" >/dev/null 2>&1 || true
fi

echo -e "\033[0;90m  ──────────────────────────────────────────\033[0m"
echo -e "\033[1;32m  ✅ Antigravity Account Switcher installed successfully!\033[0m"
echo -e "\033[1;37m  💡 Open Antigravity or Antigravity IDE to use the switcher opposite Settings.\033[0m"
echo -e "\033[1;37m  💻 For terminal workflows, run: npx antigravity-account-switcher list\033[0m"
echo ""
