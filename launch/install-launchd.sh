#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
CONFIG_FILE="${2:?usage: scripts/install-launchd.sh <base_dir> <machine-json>}"
OUT_PLIST="${3:-$HOME/Library/LaunchAgents/com.yuuki.bash-task-peer.plist}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
PEER_AGENT_HOME="${PEER_AGENT_HOME:-$HOME}"
PEER_AGENT_HERMES_HOME="${PEER_AGENT_HERMES_HOME:-$PEER_AGENT_HOME/.hermes}"
PEER_AGENT_HERMES_BIN="${PEER_AGENT_HERMES_BIN:-$(command -v hermes || true)}"
PEER_AGENT_CHAT_HOOK="${PEER_AGENT_CHAT_HOOK:-}"
# Empty hook = mailbox-only mode; when enabled, the hook can route to Hermes/Telegram.
PEER_AGENT_EXEC_MODE="${PEER_AGENT_EXEC_MODE:-hermes}"
PEER_AGENT_PROFILE_MAP="${PEER_AGENT_PROFILE_MAP:-}"

xml_escape() {
  python3 -c 'import html,sys; print(html.escape(sys.argv[1], quote=False))' "$1"
}

NODE_BIN_XML="$(xml_escape "$NODE_BIN")"
BASE_DIR_XML="$(xml_escape "$BASE_DIR")"
CONFIG_FILE_XML="$(xml_escape "$CONFIG_FILE")"
PEER_AGENT_HOME_XML="$(xml_escape "$PEER_AGENT_HOME")"
PEER_AGENT_HERMES_HOME_XML="$(xml_escape "$PEER_AGENT_HERMES_HOME")"
PEER_AGENT_HERMES_BIN_XML="$(xml_escape "$PEER_AGENT_HERMES_BIN")"
PEER_AGENT_CHAT_HOOK_XML="$(xml_escape "$PEER_AGENT_CHAT_HOOK")"
PEER_AGENT_EXEC_MODE_XML="$(xml_escape "$PEER_AGENT_EXEC_MODE")"
PEER_AGENT_PROFILE_MAP_XML="$(xml_escape "$PEER_AGENT_PROFILE_MAP")"

[ -n "$NODE_BIN" ] || { echo "node not found" >&2; exit 1; }
mkdir -p "$(dirname "$OUT_PLIST")"

cat > "$OUT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.yuuki.bash-task-peer</string>
    <key>ProgramArguments</key>
    <array>
      <string>$NODE_BIN_XML</string>
      <string>$BASE_DIR_XML/core/peer-daemon.js</string>
      <string>$CONFIG_FILE_XML</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$BASE_DIR_XML</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$BASE_DIR_XML/log/state/launchd.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$BASE_DIR_XML/log/state/launchd.stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>MACHINE_CONFIG</key>
      <string>$CONFIG_FILE_XML</string>
      <key>HOME</key>
      <string>$PEER_AGENT_HOME_XML</string>
      <key>PEER_AGENT_HOME</key>
      <string>$PEER_AGENT_HOME_XML</string>
      <key>PEER_AGENT_CHAT_HOOK</key>
      <string>$PEER_AGENT_CHAT_HOOK_XML</string>
      <key>PEER_AGENT_EXEC_MODE</key>
      <string>$PEER_AGENT_EXEC_MODE_XML</string>
      <key>PEER_AGENT_HERMES_HOME</key>
      <string>$PEER_AGENT_HERMES_HOME_XML</string>
      <key>PEER_AGENT_HERMES_BIN</key>
      <string>$PEER_AGENT_HERMES_BIN_XML</string>
      <key>PEER_AGENT_PROFILE_MAP</key>
      <string>$PEER_AGENT_PROFILE_MAP_XML</string>
    </dict>
  </dict>
</plist>
EOF

echo "Wrote $OUT_PLIST"
echo "Load with: launchctl bootstrap gui/$(id -u) $OUT_PLIST || launchctl bootout gui/$(id -u) $OUT_PLIST && launchctl bootstrap gui/$(id -u) $OUT_PLIST"
