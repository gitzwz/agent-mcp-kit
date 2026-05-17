#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: scripts/generate-certs.sh --ca-role <init|join> [--ca-pin <sha256fp>] <base_dir> <machine_name> [machine_name ...]

Generate peer certificates for explicit machine names.
- init: create local CA if missing.
- join: NEVER create CA; local CA must already exist.

In join mode, --ca-pin is required and must match local CA fingerprint.
In init mode, --ca-pin is optional and validated if provided.
Peer ids are user-defined and must match the machine_name values in config.
EOF
}

CA_ROLE=""
CA_PIN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ca-role) CA_ROLE="${2:-}"; shift 2 ;;
    --ca-pin) CA_PIN="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
    *) break ;;
  esac
done

if [ "$#" -lt 2 ]; then
  usage
  exit 2
fi

[[ "$CA_ROLE" == "init" || "$CA_ROLE" == "join" ]] || { echo "--ca-role must be init or join" >&2; usage; exit 2; }
if [[ "$CA_ROLE" == "join" && -z "$CA_PIN" ]]; then
  echo "--ca-pin is required when --ca-role=join" >&2
  usage
  exit 2
fi

BASE_DIR="$1"
shift
CERT_ROOT="$BASE_DIR/certs"
CA_DIR="$CERT_ROOT/ca"
OPENSSL_BIN="${OPENSSL_BIN:-openssl}"

mkdir -p "$CA_DIR"

if [[ "$CA_ROLE" == "init" ]]; then
  if [ ! -f "$CA_DIR/ca.key" ]; then
    "$OPENSSL_BIN" genrsa -out "$CA_DIR/ca.key" 4096 >/dev/null 2>&1
  fi

  if [ ! -f "$CA_DIR/ca.crt" ]; then
    "$OPENSSL_BIN" req -x509 -new -nodes -key "$CA_DIR/ca.key" -sha256 -days 3650 \
      -out "$CA_DIR/ca.crt" -subj "/CN=bash-task-kit-ca" >/dev/null 2>&1
  fi
else
  [[ -f "$CA_DIR/ca.key" ]] || { echo "join mode: missing CA key: $CA_DIR/ca.key" >&2; exit 1; }
  [[ -f "$CA_DIR/ca.crt" ]] || { echo "join mode: missing CA cert: $CA_DIR/ca.crt" >&2; exit 1; }
fi

if [[ -n "$CA_PIN" ]]; then
  actual_pin="$($OPENSSL_BIN x509 -in "$CA_DIR/ca.crt" -noout -fingerprint -sha256 | sed 's/^.*=//' | tr -d ':' | tr '[:upper:]' '[:lower:]')"
  expected_pin="$(printf '%s' "$CA_PIN" | tr -d ':' | tr '[:upper:]' '[:lower:]')"
  [[ -n "$actual_pin" ]] || { echo "failed to read CA fingerprint" >&2; exit 1; }
  if [[ "$actual_pin" != "$expected_pin" ]]; then
    echo "CA pin mismatch: expected $expected_pin got $actual_pin" >&2
    exit 1
  fi
fi

gen_peer() {
  local machine_name="$1"
  if [[ ! "$machine_name" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "invalid machine name: $machine_name" >&2
    exit 2
  fi
  local dir="$CERT_ROOT/$machine_name"
  mkdir -p "$dir"
  cat > "$dir/openssl.cnf" <<EOF
[ req ]
default_bits       = 4096
prompt             = no
default_md         = sha256
distinguished_name = dn
req_extensions     = req_ext

[ dn ]
CN = $machine_name

[ req_ext ]
subjectAltName = @alt_names
extendedKeyUsage = serverAuth, clientAuth
keyUsage = digitalSignature, keyEncipherment

[ alt_names ]
DNS.1 = $machine_name
IP.1 = 127.0.0.1
EOF
  "$OPENSSL_BIN" genrsa -out "$dir/peer.key" 4096 >/dev/null 2>&1
  "$OPENSSL_BIN" req -new -key "$dir/peer.key" -out "$dir/peer.csr" -config "$dir/openssl.cnf" >/dev/null 2>&1
  "$OPENSSL_BIN" x509 -req -in "$dir/peer.csr" -CA "$CA_DIR/ca.crt" -CAkey "$CA_DIR/ca.key" -CAcreateserial \
    -out "$dir/peer.crt" -days 3650 -sha256 -extensions req_ext -extfile "$dir/openssl.cnf" >/dev/null 2>&1
}

for machine_name in "$@"; do
  gen_peer "$machine_name"
done

echo "Generated certs under: $CERT_ROOT"
