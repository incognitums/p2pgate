#!/data/data/com.termux/files/usr/bin/bash
# Mux soak: isolated p2pgate server + HTTP target for an unattended run.
# Leaves three processes: target-http, p2pgate server, RSS sampler.
#
#   bash mux-termux.sh [sizeMB] [targetPort] [soakDir] [clientPublicKeyHex]
#
# Without a client key the server is zero-setup password mode. With a key it is
# registry + key-only, so the client takes the trusted fast path (the 1.13 mux
# path this run is meant to exercise).
set -u

MB="${1:-8}"
TARGET_PORT="${2:-18081}"
D="${3:-$HOME/.p2pgate-soak}"
CLIENT_KEY="${4:-}"
STATE="$D/state"
SRC_HTTP="$(cd "$(dirname "$0")" && pwd)/target-http.js"

mkdir -p "$D" "$STATE"

if [[ ! -f "$D/big.bin" || "$(wc -c < "$D/big.bin")" -ne $((MB * 1024 * 1024)) ]]; then
  echo "creating $MB MiB test file..."
  head -c $((MB * 1024 * 1024)) /dev/urandom > "$D/big.bin"
fi

SHA="$(sha256sum "$D/big.bin" | awk '{print $1}')"
BYTES="$(wc -c < "$D/big.bin" | tr -d ' ')"

# --- HTTP target (idempotent) -------------------------------------------
if ! pgrep -f "target-http.js $D/big.bin" > /dev/null 2>&1; then
  setsid nohup node "$SRC_HTTP" "$D/big.bin" "$TARGET_PORT" \
    > "$D/target.log" 2>&1 < /dev/null &
  sleep 2
fi
TARGET_PID="$(pgrep -f "target-http.js $D/big.bin" | head -n 1)"

# --- server config -------------------------------------------------------
if [[ -n "$CLIENT_KEY" ]]; then
  SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  cat > "$D/server.json" <<JSON
{
  "mode": "server",
  "masterSecret": "$SECRET",
  "authMode": "registry",
  "targetHost": "127.0.0.1",
  "targetPort": $TARGET_PORT,
  "localPort": 8022,
  "clientKeyPath": "$D/server-key.json",
  "allowedClientKeys": ["$CLIENT_KEY"],
  "verificationMode": "key-only",
  "trustedDevicesFile": "$D/trusted_devices",
  "auditLog": { "enabled": false },
  "customBootstrap": [],
  "authPin": { "enabled": false, "unattended": null },
  "telegramAlert": { "enabled": false, "botToken": "", "chatId": "" },
  "mux": true,
  "muxPeekMs": 200
}
JSON
  MODE="trusted"
else
  MODE="password"
fi

if ! pgrep -f "$D/server.json" > /dev/null 2>&1; then
  HOME="$STATE" setsid nohup p2pgate server \
    --config "$D/server.json" --target-port "$TARGET_PORT" \
    > "$D/server.log" 2>&1 < /dev/null &
  sleep 10
fi
SERVER_PID="$(pgrep -f "$D/server.json" | head -n 1)"

if [[ -z "${SERVER_PID:-}" ]]; then
  echo "ERROR: p2pgate server did not start; see $D/server.log"
  exit 1
fi

# --- credentials ---------------------------------------------------------
if [[ "$MODE" = "password" ]]; then
  SECRET="$(grep -m1 '^masterSecret:' "$STATE/.p2pgate/quickstart.txt" | awk '{print $2}')"
  PASSWORD="$(grep -m1 '^password:' "$STATE/.p2pgate/quickstart.txt" | awk '{print $2}')"
else
  PASSWORD=""
fi

cat > "$D/creds.txt" <<CREDS
MODE=$MODE
SECRET=$SECRET
PASSWORD=$PASSWORD
SHA=$SHA
BYTES=$BYTES
MB=$MB
PORT=$TARGET_PORT
CREDS
chmod 600 "$D/creds.txt"

# --- RSS sampler ---------------------------------------------------------
if ! pgrep -f "soak-rss $D" > /dev/null 2>&1; then
  setsid nohup bash -c '
    D="$1"
    while true; do
      pid="$(pgrep -f "$D/server.json" | head -n 1)"
      if [[ -n "$pid" && -r "/proc/$pid/status" ]]; then
        rss="$(awk "/VmRSS/{print \$2}" "/proc/$pid/status")"
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ),$pid,${rss:-0}" >> "$D/server-rss.csv"
      else
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ),missing,0" >> "$D/server-rss.csv"
      fi
      sleep 300
    done
  ' soak-rss "$D" > /dev/null 2>&1 < /dev/null &
  sleep 1
fi

echo "=== soak ready ($MODE) ==="
echo "dir:      $D"
echo "server:   pid $SERVER_PID (log $D/server.log)"
echo "target:   pid ${TARGET_PID:-?} on 127.0.0.1:$TARGET_PORT"
echo "file:     $MB MiB, sha256 $SHA"
if [[ "$MODE" = "trusted" ]]; then
  echo "auth:     registry + key-only (fast path)"
else
  echo "auth:     password (challenged)"
fi
echo
echo "creds file: $D/creds.txt"
