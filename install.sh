#!/bin/sh
# Register the native-messaging host for the Claude Browser Bridge.
# Usage:  ./install.sh <EXTENSION_ID>
# Get <EXTENSION_ID> from brave://extensions after loading ./extension unpacked.
set -e

EXT_ID="$1"
if [ -z "$EXT_ID" ]; then
  echo "usage: ./install.sh <EXTENSION_ID>  (from brave://extensions)"; exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
if [ -z "$NODE" ]; then echo "node not found in PATH"; exit 1; fi

# 1) wrapper the browser launches (absolute paths — the browser's PATH is minimal)
WRAP="$DIR/host/native-host"
cat > "$WRAP" <<EOF
#!/bin/sh
exec "$NODE" "$DIR/host/bridge.mjs" --native-host
EOF
chmod +x "$WRAP"

# 2) native-messaging manifest, installed for every Chromium browser found
MANIFEST_JSON=$(cat <<EOF
{
  "name": "com.claude.browserbridge",
  "description": "Claude Browser Bridge native host",
  "path": "$WRAP",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
)

# Detected by structure, not by name — every Chromium fork (Chrome, Brave, Arc, Aside, …)
# reads manifests ONLY from its own user-data dir. A qualifying dir has run at least once
# (Local State), owns a real profile (Default / "Profile N"), and has the native-messaging
# surface (NativeMessagingHosts, created by Chromium on first run). Electron apps and
# Firefox fail these checks. Mirrors isUserDataDir() in host/setup.mjs.
CONFIG_ROOT="$HOME/Library/Application Support"
[ "$(uname)" = "Linux" ] && CONFIG_ROOT="$HOME/.config"

FOUND=0
for base in "$CONFIG_ROOT"/*/ "$CONFIG_ROOT"/*/*/ ; do
  base="${base%/}"
  [ -f "$base/Local State" ] || continue
  [ -d "$base/NativeMessagingHosts" ] || continue
  if [ ! -d "$base/Default" ]; then
    ls -d "$base"/Profile\ * >/dev/null 2>&1 || continue
  fi
  printf '%s\n' "$MANIFEST_JSON" > "$base/NativeMessagingHosts/com.claude.browserbridge.json"
  echo "installed manifest -> $base/NativeMessagingHosts/com.claude.browserbridge.json"
  FOUND=$((FOUND+1))
done
if [ "$FOUND" -eq 0 ]; then echo "no Chromium-family browser found"; exit 1; fi

echo
echo "Done. Now register the MCP server with Claude Code:"
echo "  claude mcp add claude-browser -- \"$NODE\" \"$DIR/host/bridge.mjs\""
echo
echo "Then fully quit & reopen your browser so it picks up the native host."
