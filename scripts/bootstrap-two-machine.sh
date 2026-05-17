#!/usr/bin/env bash
set -euo pipefail

# One-click bootstrap for bash-task-kit peer daemon on BOTH machines.
# Run this same script on machine A and machine B with different --self/--peer/--peer-url.

usage() {
  cat <<'EOF'
Usage:
  scripts/bootstrap-two-machine.sh \
    --ca-role <init|join> \
    --self <self-peer> \
    --peer <peer-peer> \
    --peer-url <https://peer-host:port> \
    [--ca-pin <sha256fp>] \
    [--base-dir <path>] \
    [--listen-host <0.0.0.0|127.0.0.1>] \
    [--listen-port <port>] \
    [--with-telegram]

Examples:
  scripts/bootstrap-two-machine.sh --ca-role init --self rice --peer kobune --peer-url https://65.49.217.229:8443
  scripts/bootstrap-two-machine.sh --ca-role join --ca-pin <sha256fp> --self kobune --peer rice --peer-url https://192.168.1.6:8443 --with-telegram

Notes:
- Run on BOTH machines once.
- --ca-role is required. join requires --ca-pin.
- Telegram is optional; when enabled, secrets are read from env and written to ~/.config/bash-task-kit/<self>/telegram.env
EOF
}

CA_ROLE=""
CA_PIN=""
SELF_ID=""
PEER_ID=""
PEER_URL=""
BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LISTEN_HOST=""
LISTEN_PORT="8443"
WITH_TELEGRAM="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ca-role) CA_ROLE="${2:-}"; shift 2 ;;
    --ca-pin) CA_PIN="${2:-}"; shift 2 ;;
    --self) SELF_ID="${2:-}"; shift 2 ;;
    --peer) PEER_ID="${2:-}"; shift 2 ;;
    --peer-url) PEER_URL="${2:-}"; shift 2 ;;
    --base-dir) BASE_DIR="${2:-}"; shift 2 ;;
    --listen-host) LISTEN_HOST="${2:-}"; shift 2 ;;
    --listen-port) LISTEN_PORT="${2:-}"; shift 2 ;;
    --with-telegram) WITH_TELEGRAM="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

[[ "$CA_ROLE" == "init" || "$CA_ROLE" == "join" ]] || { echo "--ca-role required: init|join" >&2; usage; exit 2; }
if [[ "$CA_ROLE" == "join" && -z "$CA_PIN" ]]; then
  echo "--ca-pin required when --ca-role=join" >&2
  usage
  exit 2
fi
[[ -n "$SELF_ID" ]] || { echo "--self required" >&2; exit 2; }
[[ -n "$PEER_ID" ]] || { echo "--peer required" >&2; exit 2; }
[[ -n "$PEER_URL" ]] || { echo "--peer-url required" >&2; exit 2; }

[[ "$SELF_ID" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid --self" >&2; exit 2; }
[[ "$PEER_ID" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid --peer" >&2; exit 2; }
[[ "$PEER_URL" =~ ^https:// ]] || { echo "--peer-url must start with https://" >&2; exit 2; }

if [[ "$SELF_ID" == "local-peer" || "$SELF_ID" == "remote-peer" || "$PEER_ID" == "local-peer" || "$PEER_ID" == "remote-peer" ]]; then
  echo "legacy machine names local-peer/remote-peer are forbidden" >&2
  exit 2
fi

command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 not found" >&2; exit 1; }
command -v hermes >/dev/null || { echo "hermes not found" >&2; exit 1; }

if [[ -z "$LISTEN_HOST" ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    LISTEN_HOST="127.0.0.1"
  else
    LISTEN_HOST="0.0.0.0"
  fi
fi

TOPOLOGY="$BASE_DIR/config/topology.example.yaml"
CFG_OUT="$BASE_DIR/config/machine.$SELF_ID.json"
STATE_DIR="$BASE_DIR/log/state"
JOB_DIR="$BASE_DIR/log/jobs"
WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME/.hermes/work}"
mkdir -p "$STATE_DIR" "$JOB_DIR" "$WORKSPACE_DIR"

echo "[1/8] Generate/reuse CA + peer certs"
if [[ -n "$CA_PIN" ]]; then
  "$BASE_DIR/scripts/generate-certs.sh" --ca-role "$CA_ROLE" --ca-pin "$CA_PIN" "$BASE_DIR" "$SELF_ID" "$PEER_ID"
else
  "$BASE_DIR/scripts/generate-certs.sh" --ca-role "$CA_ROLE" "$BASE_DIR" "$SELF_ID" "$PEER_ID"
fi

echo "[2/8] Backup existing config if present"
if [[ -f "$CFG_OUT" ]]; then
  cp "$CFG_OUT" "$CFG_OUT.bak.$(date +%Y%m%d-%H%M%S)"
fi

echo "[3/8] Render base config from topology"
node "$BASE_DIR/core/render-machine-config.js" --topology "$TOPOLOGY" --self "$SELF_ID" --out "$CFG_OUT"

echo "[4/8] Patch peer URL/listen fields and strict names"
python3 - "$CFG_OUT" "$SELF_ID" "$PEER_ID" "$PEER_URL" "$LISTEN_HOST" "$LISTEN_PORT" "$WORKSPACE_DIR" <<'PY'
import json, sys
p,self_id,machine_name,peer_url,listen_host,listen_port,workspace_dir = sys.argv[1:]
d = json.load(open(p))
d['machine_name'] = self_id
d['listen_host'] = listen_host
d['listen_port'] = int(listen_port)
machines = d.setdefault('machines', {})
machines[machine_name] = machines.get(machine_name, {})
machines[machine_name]['url'] = peer_url
machines[machine_name]['server_name'] = machine_name
if self_id in machines:
    machines[self_id]['server_name'] = self_id
allowed = set(d.get('allowed_machine_names', []))
allowed.add(self_id)
allowed.add(machine_name)
d['allowed_machine_names'] = sorted(allowed)
d['workspace_dir'] = workspace_dir
d['job_dir'] = './log/jobs'
# enforce tls paths for self id
d.setdefault('tls', {})
d['tls']['ca_cert'] = './log/certs/ca/ca.crt'
d['tls']['cert'] = f'./log/certs/{self_id}/peer.crt'
d['tls']['key'] = f'./log/certs/{self_id}/peer.key'
json.dump(d, open(p,'w'), indent=2, ensure_ascii=False)
open(p,'a').write('\n')
PY

echo "[5/8] Optional Telegram env file"
if [[ "$WITH_TELEGRAM" == "1" ]]; then
  SEC_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/bash-task-kit/$SELF_ID"
  mkdir -p "$SEC_DIR"
  chmod 700 "$SEC_DIR"
  SEC_FILE="$SEC_DIR/telegram.env"
  : > "$SEC_FILE"
  chmod 600 "$SEC_FILE"
  # write only if env exists; no inline secrets in repo config
  for v in RICE_TG_BOT_TOKEN RICE_TG_CHAT_ID KOBUNE_TG_BOT_TOKEN KOBUNE_TG_CHAT_ID REZE_TG_BOT_TOKEN REZE_TG_CHAT_ID; do
    val="${!v:-}"
    if [[ -n "$val" ]]; then
      printf '%s=%s\n' "$v" "$val" >> "$SEC_FILE"
    fi
  done
  echo "wrote secret env file: $SEC_FILE"
fi

echo "[6/8] Install/reload daemon service"
if [[ "$(uname -s)" == "Darwin" ]]; then
  "$BASE_DIR/launch/install-launchd.sh" "$BASE_DIR" "$CFG_OUT"
  PLIST="${3:-$HOME/Library/LaunchAgents/com.yuuki.bash-task-peer.plist}"
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
else
  UNIT_PATH="/etc/systemd/system/bash-task-peer.service"
  sudo tee "$UNIT_PATH" >/dev/null <<EOF
[Unit]
Description=Bash Task Peer Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$BASE_DIR
ExecStart=$(command -v node) $BASE_DIR/core/peer-daemon.js $CFG_OUT
Restart=always
RestartSec=2
User=$(id -un)
Environment=MACHINE_CONFIG=$CFG_OUT

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now bash-task-peer.service
fi

echo "[7/8] Register MCP wrapper"
hermes mcp remove bash-task-peer >/dev/null 2>&1 || true
printf 'Y\n' | hermes mcp add bash-task-peer --command node --args "$BASE_DIR/core/mcp-server.js" "$CFG_OUT" >/dev/null

echo "[8/8] Local acceptance checks"
node --check "$BASE_DIR/core/peer-lib.js"
node --check "$BASE_DIR/core/peer-daemon.js"
node --check "$BASE_DIR/core/mcp-server.js"
python3 -m py_compile "$BASE_DIR/scripts/agent-dispatch-hook.py"
hermes mcp test bash-task-peer || true

echo
echo "Bootstrap complete on this machine: $SELF_ID"
echo "Now run the SAME script on the other machine with swapped --self/--peer and its --peer-url."
echo "After both sides finish, run bidirectional acceptance (remote_submit_job / remote_job_output)."
