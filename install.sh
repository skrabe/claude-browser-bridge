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

for base in \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser" \
  "$HOME/Library/Application Support/Google/Chrome" ; do
  if [ -d "$base" ]; then
    mkdir -p "$base/NativeMessagingHosts"
    printf '%s\n' "$MANIFEST_JSON" > "$base/NativeMessagingHosts/com.claude.browserbridge.json"
    echo "installed manifest -> $base/NativeMessagingHosts/com.claude.browserbridge.json"
  fi
done

echo
echo "Done. Now register the MCP server with Claude Code:"
echo "  claude mcp add claude-browser -- \"$NODE\" \"$DIR/host/bridge.mjs\""
echo
echo "Then fully quit & reopen your browser so it picks up the native host."
