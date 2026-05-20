#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
CONFIG_FILE="${2:?usage: scripts/install-launchd.sh <base_dir> <machine-json>}"
OUT_PLIST="${3:-$HOME/Library/LaunchAgents/com.yuuki.bash-task-peer.plist}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
PEER_AGENT_HOME="${PEER_AGENT_HOME:-$HOME}"
PEER_AGENT_HERMES_HOME="${PEER_AGENT_HERMES_HOME:-$PEER_AGENT_HOME/.hermes}"
PEER_AGENT_HERMES_BIN="${PEER_AGENT_HERMES_BIN:-$(command -v hermes || true)}"

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
      <string>$NODE_BIN</string>
      <string>$BASE_DIR/core/peer-daemon.js</string>
      <string>$CONFIG_FILE</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$BASE_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$BASE_DIR/log/state/launchd.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$BASE_DIR/log/state/launchd.stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>MACHINE_CONFIG</key>
      <string>$CONFIG_FILE</string>
      <key>HOME</key>
      <string>$PEER_AGENT_HOME</string>
      <key>PEER_AGENT_HOME</key>
      <string>$PEER_AGENT_HOME</string>
      <key>PEER_AGENT_HERMES_HOME</key>
      <string>$PEER_AGENT_HERMES_HOME</string>
      <key>PEER_AGENT_HERMES_BIN</key>
      <string>$PEER_AGENT_HERMES_BIN</string>
    </dict>
  </dict>
</plist>
EOF

echo "Wrote $OUT_PLIST"
echo "Load with: launchctl bootstrap gui/$(id -u) $OUT_PLIST || launchctl bootout gui/$(id -u) $OUT_PLIST && launchctl bootstrap gui/$(id -u) $OUT_PLIST"
