# p2pgate (v1.13)

**English** | [ไทย](README.th.md)

[![npm version](https://img.shields.io/npm/v/p2pgate.svg)](https://www.npmjs.com/package/p2pgate)
[![license](https://img.shields.io/npm/l/p2pgate.svg)](LICENSE)
[![Node.js](https://img.shields.io/node/v/p2pgate.svg)](package.json)
[![Socket](https://badge.socket.dev/npm/package/p2pgate?v=1.13.8)](https://socket.dev/npm/package/p2pgate)

A small peer-to-peer TCP tunnel for reaching SSH and other loopback services on
a device behind CGNAT or a firewall without exposing an inbound port. It
combines **mutual SCRAM**, **verification policy modes**, a **dual-source device
registry**, a **local control plane**, **multi-target routing**, and an optional
**SOCKS5 gateway**.

Works on Termux/Android, Linux, macOS, and Windows with Node.js 20 or newer.

> Version 1.13 lets **trusted devices use `--mux`** as well: the server advertises
> mux in `FASTPATH_READY` and waits at most 200 ms for the client's upgrade, so the
> fast path no longer falls back to one stream per connection.
> Version 1.12 added stream multiplexing (`--mux`, 128 channels per carrier);
> 1.11 ping/traffic counters; 1.10 UDP; 1.9 config validation and per-client SOCKS;
> 1.8 SOCKS5; 1.7 multi-target; 1.6 zero-setup.
>
> **Install:** `npm install -g p2pgate`
>
> Manual testing guide (Thai): [`TESTING.md`](TESTING.md)
>
> Running as a service (Termux / systemd / Windows): [`docs/SERVICE.md`](https://github.com/incognitums/p2pgate/blob/main/docs/SERVICE.md)

## Quick start (no setup)

On the Server, first run:

```sh
p2pgate server
```

It creates `~/.p2pgate/config.json`, generates a `masterSecret` and a
connection password, then starts. Copy the printed credentials.

On any Client:

```sh
p2pgate connect -s <masterSecret> -p <password>
# or interactive:
p2pgate connect
```

The client key is generated automatically. Open another terminal:

```sh
ssh -p 8022 localhost
```

Advanced configuration remains available through `p2pgate setup`.

---

## What p2pgate does

```text
[PC / Mac / phone]
ssh -p 8022 localhost
        │
        ▼
  p2pgate client  ──── HyperDHT (UDP + encrypted + hole punching) ────►  p2pgate server
  (binds 127.0.0.1 only)                                                (Termux on phone)
                                                                              │
                                                                              │ 1) registry/policy
                                                                              │ 2) fast-path or SCRAM
                                                                              │ 3) verify serverSig
                                                                              ▼
                                                                       127.0.0.1:8022
                                                                           sshd
```

- No inbound SSH port exposed to the internet
- Client listens only on `127.0.0.1`
- Server checks public keys from **two sources**: `config.json` and
  `trusted_devices`
- **hybrid:** `trusted` devices use the fast path; others use two-step
- **key-only:** public key only; no PIN prompt
- **two-step:** PIN/password required every time, even for trusted devices
- Client connects first and asks for a PIN only when the Server requires
  two-step
- Local control socket for `status`, `pin`, and `revoke` without restarting
- `p2pgate doctor` checks the installation and prints actionable diagnostics
- Trusted devices must have an expiry or an explicit `--permanent`
- Progressive lockout: 3 attempts/15 minutes, 6/6 hours, 10/permanent
- `p2pgate unlock` restores access immediately
- **JSONL audit log** for auth, control, and device events (never logs secrets)
- **Passphrase-protected client keys** (scrypt + AES-256-GCM)
- **`status --json` / `doctor --json`** for automation
- **Per-server control token** for the local control plane
- Exactly one external dependency: `hyperdht`

---

## 1) Verification modes

Configure in `config.json`:

```json
"verificationMode": "hybrid"
```

| Mode | Default | Behavior |
|---|---|---|
| `hybrid` | Yes | `trusted` devices use the fast path; `scram` devices use two-step |
| `key-only` | No | Public key only; no Session PIN and no PIN prompt |
| `two-step` | No | Public key plus PIN/password on every connection |

### hybrid

- A device registered as `trusted` in `trusted_devices` and not expired starts
  a session immediately after the public-key check
- Devices from `config.json`, or devices with the `scram` profile, require
  two-step verification
- If the Server runs without a terminal and has no Unattended Password,
  two-step devices are declined, but trusted devices can still use the fast path

### key-only

- Suitable for automation or a Server running in the background
- Every registered, non-expired key uses the fast path
- **No Session PIN is created** and no PIN is requested
- Protect the client key file carefully because there is no second factor

### two-step

- Requires both the public key and PIN/password on every connection
- The `trusted` profile in `trusted_devices` is not used as a fast path
- Best for environments that need the strictest policy

> A v1.2 config without `verificationMode` is treated as `hybrid`.
> A legacy config with `authPin.enabled: false` is treated as `key-only`.

### Authentication modes

`authMode` controls whether a client key must be registered before connecting:

| Mode | Behavior |
|---|---|
| `password` | Any client key is accepted if it provides the correct connection password. Registered trusted devices can still use fast-path. |
| `registry` | Client keys must exist in `allowedClientKeys` or `trusted_devices` before authentication. |

`p2pgate server` on a fresh machine creates `authMode: password`.
Advanced setups created by `p2pgate setup` use `registry`.

```json
"authMode": "password"
```

The connection password is stored only as a SCRAM verifier in
`authPin.unattended`. Rotate it with:

```sh
p2pgate password reset
```

> Password mode is convenient but weaker than a key whitelist. Use a long
> password, and register trusted devices for fast-path when possible.

---

## 2) Dual-source device registry

The Server merges devices from:

1. `allowedClientKeys` in `config.json` (implicit `scram` profile)
2. The `trusted_devices` file (default `~/.p2pgate/trusted_devices`)

Set the path in `config.json`:

```json
"trustedDevicesFile": "~/.p2pgate/trusted_devices"
```

### File format

```text
# Blank lines and lines starting with # are ignored
trusted <64-char-hex-public-key> primary-workstation
trusted,expires=2026-12-31T23:59:59Z <64-char-hex-public-key> contractor-laptop
scram <64-char-hex-public-key> shared-terminal
<64-char-hex-public-key> legacy-default-two-step-client
```

- A line without options uses the `scram` profile
- `trusted` means fast path under `hybrid` (and every key under `key-only`)
- `scram` means two-step
- `expires=` must be ISO-8601 with a timezone, for example `...Z`
- The label is the remaining text on the line

### Precedence

- Key only in `config.json` → `scram` profile
- Key only in `trusted_devices` → use the file's profile and expiry
- Key in both and the file entry is active → `trusted_devices` wins
- Key in the file but **expired** → declined, even if it is still in
  `config.json`

### File permissions (POSIX)

Before using the fast path, the Server verifies that `trusted_devices`:

- Is a regular file, not a symlink
- Is owned by the current user
- Has no group/other permissions (`chmod 600` or stricter)

If permissions are insecure:

- `hybrid`: `trusted` entries cannot use the fast path (two-step required)
- `key-only`: entries from the file are declined
- `two-step`: two-step is still required as usual

### Live reload

The Server watches the `mtimeMs` of `trusted_devices` and reloads it when the
file changes, without a restart. Prefer editing it through
`p2pgate devices add/remove`, which writes atomically.

---

## 3) Deferred client input

The Client **connects first** and waits for a status frame from the Server:

| Status | Meaning | Client behavior |
|---|---|---|
| `FASTPATH_READY` | Device uses the fast path | No PIN prompt; start sending data |
| `CHALLENGE_REQUIRED` | Two-step required | Read PIN/password, then run SCRAM |
| `DECLINED` | Unlisted, expired, or suspended | Show the reason and close the connection |

- The Client no longer asks for a PIN before connecting
- Fast-path and key-only sessions never prompt for a PIN
- `--pin-stdin` reads stdin **only when challenged** (it does not block the
  fast path)
- `P2PGATE_PIN` is removed from the process environment immediately after the
  Client reads it at startup

After `CHALLENGE_REQUIRED`, the Client sends `READY`. The Server then sends the
SCRAM challenge and starts the 10-second authentication timeout.

---

## 4) Session PIN and Unattended Password

### Session PIN

- 10 characters from the Base32 alphabet:
  `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`
- Displayed as `XXXXX-XXXXX` in an ASCII box on an interactive terminal
- Kept in memory only; never written to config, logs, or disk
- Rotated after 3 or 6 failed attempts (with a new salt each time)
- **key-only does not create a Session PIN**
- A headless Server does not display the PIN; use the fast path, key-only, or
  an Unattended Password

### Unattended Password

- At least 12 characters
- Case-sensitive
- Works with `hybrid`/`two-step` even when the Server has no terminal
- Only the SCRAM verifier is stored (`saltHex`, `storedKeyHex`, `serverKeyHex`)
- Configure it through `p2pgate setup`

```json
"authPin": {
  "enabled": true,
  "unattended": {
    "saltHex": "...",
    "storedKeyHex": "...",
    "serverKeyHex": "..."
  }
}
```

If not configured, the value is `"unattended": null`.

---

## 5) Client credential input

Priority order:

1. `--pin-stdin` — read one line from stdin when the Server requires two-step
2. `P2PGATE_PIN` — environment variable (removed from the process immediately)
3. Hidden prompt — default

> There is no `--pin` flag, so passwords do not appear in `ps` or shell history.
>
> Avoid inline `P2PGATE_PIN=... p2pgate client`; use a hidden prompt or
> `--pin-stdin` from a protected file.

Termux/Linux example:

```sh
install -m 600 /dev/null ~/.p2pgate/pin.txt
nano ~/.p2pgate/pin.txt
p2pgate client --pin-stdin < ~/.p2pgate/pin.txt
```

Windows PowerShell:

```powershell
Get-Content .\pin.txt | p2pgate client --pin-stdin
```

Environment variable example:

```sh
export P2PGATE_PIN='...'
p2pgate client
unset P2PGATE_PIN
```

### Client key passphrase

A client key can be protected with a passphrase. The seed is encrypted with
scrypt + AES-256-GCM; the public key remains readable for diagnostics.

```sh
p2pgate keygen --passphrase
```

For non-interactive creation or migration:

```sh
printf '%s\n' 'your-long-passphrase' | p2pgate keygen --config ~/.p2pgate/config.json --passphrase-stdin
```

When starting the Client:

```sh
p2pgate client --key-passphrase-stdin < ~/.p2pgate/key-passphrase.txt
```

or:

```sh
export P2PGATE_KEY_PASSPHRASE='...'
p2pgate client
unset P2PGATE_KEY_PASSPHRASE
```

- Minimum passphrase length is 12 characters.
- There is no `--passphrase` argument value.
- `--key-passphrase-stdin` cannot be combined with `--pin-stdin`.
- Existing plaintext keys remain compatible; `doctor` recommends adding a
  passphrase.
- To remove protection intentionally:

```sh
p2pgate keygen --unprotect
```

---

## 6) Progressive lockout and `unlock`

Failures are counted per public key within a 24-hour window:

| Failures | Result |
|---|---|
| 3 | Suspend for 15 minutes + rotate the Session PIN |
| 6 | Suspend for 6 hours + rotate the Session PIN |
| 10 | Permanent suspension |

- Invalid responses are delayed by 2.5–3.5 seconds
- Concurrent verification is limited to 1 per key and 3 in total
- State is stored in `~/.p2pgate/lockout-state.json` with mode `0600`
- Uses a lockfile, atomic rename, and mtime reload
- `p2pgate unlock` affects a running Server immediately

```sh
p2pgate unlock --list
p2pgate unlock <clientPublicKeyHex>
p2pgate unlock --all
```

---

## 7) Device management CLI

```sh
p2pgate devices list
p2pgate devices add <publicKeyHex> --mode trusted \
  --expires 2026-12-31T23:59:59Z --comment "contractor"
p2pgate devices add <publicKeyHex> --mode trusted --permanent
p2pgate devices add <publicKeyHex> --mode scram --comment "shared-terminal"
p2pgate devices remove <publicKeyHex>
```

- `list` shows the merged registry: source, profile, expiry, and label
- `add`/`remove` update `trusted_devices` atomically
- `--mode` defaults to `scram`; use `--mode trusted` for the fast path
- `--expires` must be ISO-8601 with a timezone
- **`--mode trusted` requires either `--expires` or `--permanent`**
  - If neither is supplied, the command is rejected
  - If both are supplied, the command is rejected
  - `--permanent` is valid only for trusted devices
- The command warns that trusted devices bypass the PIN prompt
- `remove` warns if the key is still in `config.json` `allowedClientKeys`
- Use `--config <path>` to select a config file

> CLI output is currently in Thai. The sample below is translated.

```text
- aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  Source: config.json (allowedClientKeys)
  Profile: scram
  Expires: -
  Label: -
  Status: active
  Fast-path: no
  Lockout: normal
  Failures in 24h: 0
```

---

## 8) Local control plane (`status` / `pin` / `revoke`)

Server v1.5 opens a **local control socket** so the owner can manage a running
Server without restarting it and without opening another TCP port.

### Socket location

| Platform | Location |
|---|---|
| Linux / macOS / Termux | `~/.p2pgate/control.sock` (mode `0600`, directory `0700`) |
| Windows | Named pipe `\\.\pipe\p2pgate-control-<hash>` |

- Same-user, same-machine access only
- The socket is removed on graceful shutdown
- A stale socket from a dead process is probed before removal
- If another live Server owns the socket, startup fails with `CONTROL_IN_USE`
- Every request requires a per-server **control token** stored at
  `~/.p2pgate/control.token` (mode `0600`); the token is never printed
- POSIX sockets are checked for owner and `0600` permissions
- On Windows, the token authenticates requests in addition to the default
  named-pipe DACL

### Commands

```sh
p2pgate status
p2pgate status --json
p2pgate pin
p2pgate revoke <clientPublicKeyHex>
```

#### `p2pgate status`

Shows non-secret operational state:

- Verification mode
- Whether a Session PIN is available (never the PIN itself)
- Current slot and listening slots
- Registered device count
- Active connections and connected keys
- Cumulative blocked count
- Uptime, trusted-devices file, and control socket path

Use `--json` for automation:

```sh
p2pgate status --json
```

The output is a single JSON object with `"ok": true` on success. On failure,
`"ok": false` and an `error` field are returned; the exit code is `1`.

#### `p2pgate pin`

Requests the current Session PIN from Server memory over the control socket:

```text
=== Current Session PIN ===
   ABCDE-FGHJK
   generation: 1
```

- The PIN is never written to disk or logs
- `key-only` returns `NO_SESSION_PIN`
- If the Server is not running, the command tells you to start
  `p2pgate server`

#### `p2pgate revoke <key>`

- Permanently suspends the key (`reason: manual`)
- Immediately closes active connections for that key
- Future connections are declined
- If the Server is not running, the command persists the revocation directly
  to the lockout state; it takes effect when the Server reads the state

Restore access with:

```sh
p2pgate unlock <clientPublicKeyHex>
```

> `revoke` operates at the p2pgate layer. SSH sessions piped through the tunnel
> are closed with the stream. Check sshd separately if you need an OS-level
> session kill.

---

## 9) `p2pgate doctor`

A read-only diagnostic command. Output is currently in Thai with
`✅` / `⚠️` / `❌`.

```sh
p2pgate doctor
p2pgate doctor --config /path/to/config.json
```

It checks:

1. Node.js version (must be >= 20)
2. Config file exists, parses, and validates
3. `verificationMode` and related fields
4. Permissions of config, client key, trusted_devices, and lockout state
   - On Windows it reports that POSIX permission checks are skipped
5. Device registry: count, expired entries, trusted entries without expiry,
   file permissions, empty registry
6. Target: Server checks whether `127.0.0.1:<targetPort>` is listening;
   Client checks whether the local port is available
7. Control plane: queries `status` if the Server is running (using the token)
8. Lockout state plus audit log permissions and size
9. Warning when a headless Server cannot expose a Session PIN
10. Client key presence, validity, and whether it is passphrase-protected

- Exit code `0` when there is no `❌`
- Exit code `1` when a critical check fails
- Never prints `masterSecret`, seeds, verifier values, or PINs

Use `--json` for automation:

```sh
p2pgate doctor --json
```

```json
{
  "ok": false,
  "exitCode": 1,
  "summary": { "critical": 1, "warnings": 2 },
  "checks": [
    { "level": "ok", "title": "...", "detail": "..." }
  ]
}
```

---

## 9.1) Audit log

The Server and CLI append security-relevant events to a local JSONL file:

```json
{"ts":"2026-11-15T10:00:00.000Z","event":"auth.success","source":"server","key":"<hex>","mode":"pin"}
```

Default configuration:

```json
"auditLog": {
  "enabled": true,
  "path": "~/.p2pgate/audit.log",
  "maxBytes": 5242880
}
```

- The file is created with mode `0600`; the parent directory uses `0700`.
- One previous file is kept as `audit.log.1` when `maxBytes` is exceeded.
- Events include `server.start`, `auth.success`, `auth.failure`,
  `auth.declined`, `auth.fastpath`, `control.revoke`, `session.pin.rotate`,
  `device.add`, `device.remove`, `device.revoke`, `device.unlock`, and
  `device.unlock_all`.
- The audit log never records a PIN, password, passphrase, master secret, seed,
  verifier, or control token.
- Audit failures are written to the Server log and do not block authentication.

Set `"auditLog": { "enabled": false }` to disable it.

---

## 9.2) Multi-target routing

Declare several loopback services on the Server and let each Client pick one by
name. No `ssh -L`, no `sshd` required for services that have no shell.

```json
"targets": {
  "ssh": { "host": "127.0.0.1", "port": 2222 },
  "web": { "host": "127.0.0.1", "port": 8080 },
  "db":  { "host": "127.0.0.1", "port": 5432, "allow": ["<clientKeyHex>"] }
},
"defaultTarget": "ssh"
```

```sh
p2pgate connect -s <secret> -p <password> --target web --port 8080
# 127.0.0.1:8080 on the client  ->  127.0.0.1:8080 on the server
```

Rules:

- clients send a target **name**, never `host:port`
- `host` must be `127.0.0.1` (p2pgate never forwards to a remote host)
- `allow` is optional; `"*"` means any authenticated client
- a config without `targets` behaves exactly like v1.6
- clients that omit `--target` use `defaultTarget`
- unknown/forbidden targets are rejected without contacting the service
- trusted (fast-path) devices can use `--target` from 1.13.3; a client with a newer
  version on an older server fails with `TARGET_UNSUPPORTED` instead of silently
  using the default target

---

## 9.3) SOCKS5 gateway (optional)

Server config:

```json
"socks": {
  "enabled": true,
  "allow": ["192.168.1.0/24:8080", "127.0.0.1:3000", "10.0.0.0/8:*"]
}
```

Client:

```sh
p2pgate connect -s <secret> -p <password> --socks5 1080
```

Then point a browser or app at `SOCKS5 127.0.0.1:1080`.

Rules:

- off by default; `socks.enabled` requires at least one allow entry
- entries are IPv4/CIDR plus port (`*` = any port)
- the client sends the destination; the server resolves it and checks **every**
  resolved IP against the allowlist, so a hostile DNS answer cannot escape it
- only TCP `CONNECT`; `UDP ASSOCIATE` and `BIND` are rejected
- IPv6 destinations are rejected in v1.8
- denied destinations return a SOCKS "not allowed" reply and log `SOCKS DENIED`
- `--socks5` cannot be combined with `--target`

Example for a home LAN:

```json
"socks": { "enabled": true, "allow": ["192.168.1.0/24:*"] }
```

Per-client policy (optional) — the list **replaces** the global one for that
client key:

```json
"socks": {
  "enabled": true,
  "allow": ["192.168.1.0/24:8080"],
  "perClient": {
    "<clientPublicKeyHex>": ["10.0.0.0/8:443"]
  }
}
```

> This turns the Server into a gateway for the destinations you list. Keep the
> allowlist tight — `0.0.0.0/0` would proxy the whole internet.

---

## 9.4) Rotating masterSecret

`masterSecret` derives the Server's DHT identity. Rotating it changes the
Server's public key, so every Client must be updated.

```sh
# Server
p2pgate master show            # fingerprint (--reveal prints the full value)
p2pgate master reset --yes     # backup + new value, then restart the server

# Each Client
p2pgate connect -s <new masterSecret> -p <password>
```

- `p2pgate master reset --dry-run` shows what would change without writing
- `--no-backup` skips the backup on purpose (incident response: do not keep a
  copy of the leaked secret on disk)
- the previous config is copied to `config.json.bak-<timestamp>` (mode `0600`)
- rotations are recorded in the audit log as `master.reset`
- the connection password and trusted device keys are **not** affected
- without `--yes` the command asks for confirmation; in a non-interactive shell
  `--yes` is required

---

## 9.5) Validating a config

```sh
p2pgate config validate        # exits 1 when the file is missing or invalid
p2pgate config show            # normalised config, secrets masked
p2pgate config show --json
```

`config validate` runs the same normaliser the daemon uses, so a config that
passes here will load at startup. `config show` prints what the daemon sees,
with `masterSecret`, the SCRAM verifier and the Telegram token masked.

Client-side commands (`ping`, `client`, `udp`, `config`, `doctor`, `master`,
`keygen`) use `config.json` when it exists, otherwise they fall back to
`client.json` automatically. `--config` always wins.

`p2pgate doctor` additionally:

- prints the `masterSecret` fingerprint and warns when the config has not
  changed in 180 days
- probes every `targets.<name>` on `127.0.0.1` and warns when a port is closed
- warns when a SOCKS allowlist entry is `0.0.0.0/0` (open proxy)

---

## 9.6) UDP targets

UDP is off unless you declare targets. Datagrams are framed inside the same
authenticated tunnel (`[len:uint16][payload]`, max 1200 bytes).

Server:

```json
"udpTargets": {
  "dns": { "host": "127.0.0.1", "port": 53 },
  "ntp": { "host": "127.0.0.1", "port": 123 }
}
```

Client:

```sh
p2pgate udp --target dns --listen 5353
# optional: "udpTarget": "dns", "udpListen": 5353 in client.json
```

Rules:

- the client sends a target **name**; `host` must be `127.0.0.1`
- one tunnel stream per client source endpoint, closed after 60 s idle
- replies only travel back through the originating stream (no reflector use)
- datagrams above 1200 bytes are dropped on both sides
- IPv4 only; UDP is not available through SOCKS5 in this release

---

## 9.7) Ping and traffic counters

```sh
p2pgate ping                 # 3 pings: current slot then the previous one
p2pgate ping --count 5 --json
```

```text
slot 498558  serverKey 1f0ea5c2…
   connect 170/1092/2013 ms   auth 24/31/38 ms   (2 attempts)
```

- `connect` is the DHT stream setup time; `auth` is the SCRAM handshake
- `--count N` repeats the handshake and reports min/avg/max
- works with trusted fast-path, key-only, and challenge modes
- nothing listens and no port stays open
- exit code `1` when no slot answers

`p2pgate status` now reports in-memory traffic counters:

```text
Traffic รวม: in 1.2 KiB / out 8.4 MiB
Stream ที่ใช้งาน: 2
  - ssh (tcp) peer=3d8f1df0… in 512 B out 8.4 MiB
```

`p2pgate status --watch` refreshes every second (Ctrl+C to stop). Counters reset
on restart and are never written to disk.

---

## 9.8) Host aliases

```sh
p2pgate connect -s <secret> -p <password> --save home-pi
p2pgate connect @home-pi
p2pgate hosts list
p2pgate hosts remove home-pi
p2pgate ping @home-pi
p2pgate ping --all
```

- stored in `~/.p2pgate/hosts.json` (mode `0600`)
- the file contains `masterSecret` values — keep it private
- `ping --all` prints one line per host with connect/auth timings or the error

## 9.9) Audit viewer

```sh
p2pgate audit --tail 20
p2pgate audit --failures --since 24h
p2pgate audit --json
```

- reads from the end of `audit.log` (no full-file load)
- `--failures` keeps failure/declined/revoke/lockout/timeout events
- secrets are already stripped by the audit writer

## 9.10) Self-stopping server

```sh
p2pgate server --ttl 30m     # stop 30 minutes after start
p2pgate server --idle 15m    # stop after 15 minutes without connections
p2pgate server --once        # stop after the first session ends
```

Shutdown stops accepting new connections and waits up to 60 s for active
sessions. Timers are in memory only.

---

## 9.11) Multiplexing (`--mux`)

```sh
p2pgate connect -s <secret> -p <password> --socks5 1080
p2pgate client --config client.json --mux
```

- `--socks5` uses mux by default since 1.13.1; plain tunnels stay opt-in
- `--no-mux` (or `"mux": false` in `client.json`) turns it off
- one authenticated carrier, up to **128 channels**
- each channel carries one target or one SOCKS destination
- 16 KiB frames, 256 KiB window per direction, 64 KiB queue cap
- carrier idle timeout 5 min; keepalive every 30 s
- channel errors keep their codes (`TARGET_UNKNOWN`, `SOCKS_DENIED`, `MUX_BUSY`)
  and fall back to a dedicated stream

**Trusted devices:** since 1.13.0 `--mux` also works on the fast path. The server
advertises mux in `FASTPATH_READY`, the client asks for the upgrade immediately, and
the server waits at most 200 ms for that line before forwarding bytes to the target.
Older servers simply do not advertise it and the client falls back quietly.

## 9.12) Compression (`--compress`, optional)

```sh
# server
p2pgate server --compress

# client (mux or a dedicated tunnel)
p2pgate connect -s <secret> -p <password> --compress
p2pgate connect -s <secret> -p <password> --compress --mux
```

- **off by default**; both ends must enable it
- `--no-compress` (or `"compress": false` in config) turns it off and wins over config
- zstd when the Node build has it (>= 22.15), gzip otherwise
- works on mux channels and non-mux tunnels, including trusted-device (fast path) sessions
- `"compress": "auto"` samples the first 32 KiB / 60 ms and stays off for incompressible
  data (mux only)
- decompression guard: 4 GiB output or 1000x expansion per channel
- measured on a 4G link: 64 MiB of text/logs **2.4-2.6x** faster; already-compressed
  files (jpg/mp4/zip) ~1.0x
- SSH payloads are encrypted by sshd, so this cannot help them — use `ssh -C`

Config form:

```json
"compress": { "enabled": true, "algorithms": ["zstd", "gzip"] }
```

---

## 10) Requirements

- Android phone + Termux + Termux:Boot (F-Droid), optional
- Node.js 20 or newer
- OpenSSH on the Server and `ssh` on the Client
- Internet access that allows outbound UDP

---

## 11) Install

### From npm (recommended)

Requires Node.js 20 or newer.

```sh
npm install -g p2pgate
p2pgate --version
```

### From source on Termux

```sh
pkg update && pkg upgrade -y
pkg install nodejs openssh nano procps -y
node -v
```

Copy the project to `~/p2pgate`, then:

```sh
cd ~/p2pgate
npm install --ignore-scripts --no-audit --no-fund
npm link --ignore-scripts
npm run check
npm run self-test
```

If a native prebuild is unavailable:

```sh
pkg install python build-essential -y
npm install --no-audit --no-fund
```

---

## 12) Harden SSH

```sh
passwd
sshd
```

Create an SSH key on the Client:

```sh
ssh-keygen -t ed25519
```

Add `id_ed25519.pub` to Termux:

```sh
mkdir -p ~/.ssh
nano ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

Disable password authentication:

```sh
nano $PREFIX/etc/ssh/sshd_config
```

```text
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
```

```sh
pkill sshd
sshd
ssh -p 8022 localhost
```

---

## 13) Server setup

```sh
cd ~/p2pgate
p2pgate setup
```

Choose `1) Server` and select a mode:

```text
1) hybrid (recommended)
2) key-only
3) two-step
```

- `hybrid`: trusted devices use the fast path; others use two-step
- `key-only`: no PIN prompt (and no unattended password prompt)
- `two-step`: PIN/password on every connection

Then:

1. Paste the Client public key
2. Configure an Unattended Password (except in key-only mode)
3. Save the config
4. Add trusted devices if needed:
   ```sh
   p2pgate devices add <key> --mode trusted --expires 2027-12-31T23:59:59Z --comment "laptop"
   ```
5. Start the Server:
   ```sh
   p2pgate server
   ```

In an interactive terminal with hybrid/two-step, the Session PIN is shown in a
box. In headless mode the PIN is not shown; use trusted fast-path or an
Unattended Password.

---

## 14) Client setup

```sh
cd p2pgate
npm install --ignore-scripts --no-audit --no-fund
npm link --ignore-scripts
p2pgate setup
```

Choose `2) Client`, paste the `masterSecret`, and set the local port.

Add the Client public key on the Server:

```sh
p2pgate setup
```

Or register it as a trusted device:

```sh
p2pgate devices add <key> --mode trusted --expires 2027-12-31T23:59:59Z --comment "my-pc"
```

Start the tunnel:

```sh
p2pgate client
```

- `FASTPATH_READY`: no PIN prompt
- `CHALLENGE_REQUIRED`: prompt for PIN/password in the Client terminal
- `DECLINED`: show the reason and close

Then open another terminal:

```sh
ssh -p 8022 localhost
```

---

## 15) Daily use

```sh
# Server
cd ~/p2pgate
p2pgate server

# Client
cd p2pgate
p2pgate client
ssh -p 8022 localhost
```

- Trusted devices under hybrid do not need a PIN
- `scram` devices need a PIN/password
- `key-only` never asks for a PIN
- `two-step` asks every time
- If the PIN rotates or the key is suspended, the Client reports it

---

## 16) Termux:Boot

```sh
mkdir -p ~/.termux/boot
cp ~/p2pgate/scripts/termux-boot.sh ~/.termux/boot/start-p2pgate.sh
chmod +x ~/.termux/boot/start-p2pgate.sh
```

- Set Termux battery usage to Unrestricted
- Open Termux:Boot at least once
- Reboot the device

Modes suitable for headless operation:

- `key-only` — no PIN
- `hybrid` + trusted devices — those devices use the fast path
- `hybrid`/`two-step` + Unattended Password

The Session PIN is never written to a file or log.

Log:

```sh
tail -f ~/.p2pgate/server.log
```

---

## 17) Telegram (optional)

1. Create a bot with `@BotFather`
2. Copy the Bot Token
3. Send one message to the bot
4. Read the Chat ID from `getUpdates`

Notifications are sent when:

- An unknown key attempts to connect (rate-limited to once per 60 seconds per
  key)
- 3 failed attempts → 15-minute suspension + PIN rotation
- 6 failed attempts → 6-hour suspension + PIN rotation
- 10 failed attempts → permanent suspension

Messages never contain the PIN or password.

---

## 18) Security

- **`masterSecret`** derives the hourly Server keys
- **`allowedClientKeys` + `trusted_devices`** form the registry
- **`hybrid`** gives the fast path only to trusted devices
- **`key-only`** has no PIN — protect the client key and registry carefully
- **`two-step`** is the strictest mode
- **Session PIN** lives in RAM only
- **Unattended Password** stores only a SCRAM verifier
- **SCRAM mutual authentication** verifies both the Client proof and the Server
  signature
- **No `--pin`** and `P2PGATE_PIN` is removed from the process environment
- **`trusted_devices`** must be owned by the user and `chmod 600`;
  insecure permissions disable the fast path
- **Progressive lockout:** 3/15m, 6/6h, 10/permanent
- **Control socket** is local-only (`0600` or a per-user named pipe)
  - Every request requires a per-server token stored at `0600`
  - POSIX sockets are checked for owner and `0600` permissions
  - The PIN is read from RAM and sent only over the socket
  - `revoke` closes active connections and persists a permanent suspension
  - There is no TCP listener for the control plane
  - Windows named pipes rely on the token plus the default DACL; a custom DACL
    is not set by Node core
- **Passphrase-protected client keys** use scrypt + AES-256-GCM; plaintext keys
  remain supported but `doctor` recommends protection
- **Audit log** is `0600`, appends JSONL, and never records secrets
- **Trusted devices** bypass the PIN, so they require an expiry or an explicit
  `--permanent`
- **Internal ports** bind to `127.0.0.1`
- **Config, key, lockout, trusted_devices, control token, and audit log files**
  use mode `0600`
- **doctor** never prints secrets and never modifies files

> p2pgate does not replace all SSH security.
> It lets you reach SSH without exposing an inbound port to the public internet.

---

## 19) Command reference

| Command | Purpose |
|---|---|
| `p2pgate setup` | Configure and select a verification mode |
| `p2pgate setup --easy` | Generate a password-auth config with minimal prompts |
| `p2pgate server` | Start the Server (auto-creates config on first run) |
| `p2pgate server --port <targetPort>` | Start the Server with a target-port override for this run only |
| `p2pgate connect` | Connect from a Client with masterSecret + password |
| `p2pgate connect -s <secret> -p <password>` | One-line client connect |
| `p2pgate connect --target <name>` | Connect to a named target declared on the Server |
| `p2pgate connect --socks5 <port>` | Start a local SOCKS5 gateway (server allowlist) |
| `p2pgate connect --socks5 <port>` | Start a local SOCKS5 gateway (mux on by default) |
| `p2pgate connect --socks5 <port> --no-mux` | SOCKS5 without multiplexing |
| `p2pgate master show [--reveal]` | Print the masterSecret fingerprint |
| `p2pgate master reset --yes` | Rotate masterSecret with a timestamped backup |
| `p2pgate config validate` | Validate a config file (exit 1 when invalid) |
| `p2pgate config show` | Print the normalised config with secrets masked |
| `p2pgate udp --target <name> --listen <port>` | Forward local UDP to a Server udpTarget |
| `p2pgate ping [--count <n>]` | Measure auth time and RTT, then exit |
| `p2pgate ping --all` | Ping every host in `hosts.json` |
| `p2pgate connect @alias` | Connect using a saved host alias |
| `p2pgate connect --save <alias>` | Save the current target as an alias |
| `p2pgate hosts list` | List saved host aliases |
| `p2pgate audit --tail 20` | Read the audit log as a short table |
| `p2pgate server --ttl 30m` | Stop the Server automatically after 30 minutes |
| `p2pgate status --watch` | Refresh status (traffic) every second |
| `p2pgate keygen` | Create/show the Client key |
| `p2pgate keygen --passphrase` | Protect an existing/new key with a passphrase |
| `p2pgate keygen --unprotect` | Remove passphrase protection (prompts) |
| `p2pgate server` | Start the Server |
| `p2pgate client` | Start the Client; ask for credentials only when required |
| `p2pgate client --pin-stdin` | Read a credential from stdin when challenged |
| `p2pgate client --key-passphrase-stdin` | Read the client-key passphrase from stdin |
| `p2pgate devices list` | Show the merged registry and lockout state |
| `p2pgate devices add <key> --mode trusted --expires ...` | Add a temporary trusted device |
| `p2pgate devices add <key> --mode trusted --permanent` | Add a permanent trusted device (explicit intent) |
| `p2pgate devices add <key> --mode scram` | Add a device that requires two-step |
| `p2pgate devices remove <key>` | Remove a device from trusted_devices |
| `p2pgate status` | Show Server status over the control socket |
| `p2pgate status --json` | Machine-readable Server status |
| `p2pgate pin` | Request the Session PIN from a running Server |
| `p2pgate revoke <key>` | Revoke a key and close active connections |
| `p2pgate password reset` | Rotate the connection password |
| `p2pgate doctor` | Diagnose the installation and suggest fixes |
| `p2pgate doctor --json` | Machine-readable diagnostics |
| `p2pgate unlock --list` | Show lockout/revocation state |
| `p2pgate unlock <key>` | Unlock one key |
| `p2pgate unlock --all` | Unlock all keys |
| `p2pgate help` | Show help |
| `npm run check` | Syntax check |
| `npm run self-test` | Test modes, registry, control, doctor, lockout, rotation |
| `npm test` | Run `check` + `self-test` |

Default files:

- Config: `~/.p2pgate/config.json`
- Client key: `~/.p2pgate/client-key.json`
- Trusted devices: `~/.p2pgate/trusted_devices`
- Lockout state: `~/.p2pgate/lockout-state.json`
- Control socket: `~/.p2pgate/control.sock` (Windows: named pipe)
- Control token: `~/.p2pgate/control.token`
- Audit log: `~/.p2pgate/audit.log`

---

## 20) Troubleshooting

### `STATUS_DECLINED`

- `unlisted`: key is not in the registry → `p2pgate devices list`
- `expired`: expired → update `--expires` or add it again
- `insecure_registry`: trusted_devices permissions are unsafe → `chmod 600`
- `interactive_unavailable`: headless Server with no terminal and no Unattended
  Password → use trusted fast-path, key-only, or set an Unattended Password
- `busy`: another verification is in progress → retry

### `p2pgate status` / `pin` does not work

- A Server must be running under the same user
- Check that `~/.p2pgate/control.sock` exists (Windows uses a named pipe)
- If the Server crashed and left a stale socket, start it again; the Server
  probes and removes an unowned socket
- `CONTROL_IN_USE` means another Server owns the socket; stop the old one first
- If you see `UNAUTHORIZED`, the token is stale or belongs to another Server;
  restart the Server to generate a new `~/.p2pgate/control.token`
- If the token file is missing, start the Server; the CLI cannot authenticate
  without it

### `revoke` does not stop a connection

- Run `p2pgate revoke <key>` against the running Server
- If the Server is not running, the command only persists state; it applies
  when the Server reads the state
- Check `p2pgate unlock --list` for
  "revoked by revoke command" status
- Restore with `p2pgate unlock <key>`

### `devices add --mode trusted` is rejected

Provide exactly one of:

```sh
p2pgate devices add <key> --mode trusted --expires 2027-12-31T23:59:59Z
p2pgate devices add <key> --mode trusted --permanent
```

If you use `--permanent`, review the list periodically with
`p2pgate devices list`.

### `doctor` shows ❌

Read the hint below the line, such as unsafe file permissions, an empty
registry, a missing Client key, or an invalid config. Fix it and rerun
`p2pgate doctor`. A `⚠️` warning does not change the exit code to 1.

### A trusted device does not use the fast path

- Check that `verificationMode` is `hybrid` or `key-only`
- Check that the file is `chmod 600` and owned by the current user
- Check that the entry is not expired
- Check that `config.json` is not overriding it (the file should win)
- Check that the Server reloaded the file (`devices list` / mtime)

### key-only does not ask for a PIN

This is expected for `key-only`. Use `hybrid` or `two-step` if you want a PIN.

### two-step asks for a PIN every time

This is expected. Even devices in `trusted_devices` do not use the fast path in
this mode.

### Client does not ask for a PIN

- No prompt is expected after `FASTPATH_READY` or in `key-only`
- To require a prompt, use `hybrid` with the `scram` profile, or `two-step`

### `PIN_REQUIRED`

The Client needs two-step but has no terminal, no `--pin-stdin`, and no
`P2PGATE_PIN`.

### Client key passphrase errors

- `KEY_PASSPHRASE_REQUIRED`: the key is encrypted and no terminal/passphrase
  source is available
  - use `--key-passphrase-stdin` or `P2PGATE_KEY_PASSPHRASE`
- `KEY_PASSPHRASE_INVALID`: the passphrase is wrong
- `KEY_PASSPHRASE_WEAK`: a new passphrase is shorter than 12 characters
- To add protection to an existing plaintext key:
  ```sh
  p2pgate keygen --passphrase
  ```

### `PIN_ROTATED_OR_INVALID`

- The PIN may have rotated after 3/6 failures or a Server restart
- Check the latest PIN on the Server console or use the Unattended Password

### `LOCKED_OUT`

```sh
p2pgate unlock --list
p2pgate unlock <clientPublicKeyHex>
p2pgate unlock --all
```

### `AUTH_CONFIG_UPGRADE_REQUIRED`

A v1.1 config was found. Run:

```sh
p2pgate setup
```

### Is a v1.2 config still supported?

Yes. Without `verificationMode` it is treated as `hybrid`. If
`authPin.enabled: false`, it is treated as `key-only`.

### `PEER_NOT_FOUND`

- Check that the Server is running
- Check that `masterSecret` matches
- Check the registry/public key
- Check UDP connectivity
- The Client automatically tries the previous hour's slot

### `EADDRINUSE`

```sh
p2pgate client --port 8023
ssh -p 8023 localhost
```

### SSH `Permission denied (publickey)`

- Check `~/.ssh/authorized_keys` and its permissions
- Check `PasswordAuthentication no` and restart sshd

---

## 21) Project structure

```text
p2pgate/
├── .github/
│   └── workflows/
│       └── ci.yml
├── .editorconfig
├── .gitattributes
├── .gitignore
├── .npmrc
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
├── LICENSE
├── NOTICE
├── README.md
├── README.th.md
├── TESTING.md
├── config.example.json
├── docs/
│   ├── HANDOFF.md
│   ├── README.md
│   ├── SERVICE.md
│   ├── releases/
│   │   ├── v1.4.0.md
│   │   ├── v1.4.1.md
│   │   ├── v1.5.0.md
│   │   ├── v1.6.0.md
│   │   ├── v1.6.1.md
│   │   ├── v1.6.2.md
│   │   ├── v1.6.3.md
│   │   ├── v1.6.4.md
│   │   ├── v1.7.0.md
│   │   ├── v1.8.0.md
│   │   ├── v1.8.1.md
│   │   ├── v1.8.2.md
│   │   ├── v1.8.3.md
│   │   ├── v1.8.4.md
│   │   ├── v1.9.0.md
│   │   ├── v1.9.1.md
│   │   ├── v1.10.0.md
│   │   ├── v1.11.0.md
│   │   ├── v1.11.1.md
│   │   ├── v1.11.2.md
│   │   ├── v1.11.3.md
│   │   ├── v1.11.4.md
│   │   ├── v1.12.0.md
│   │   ├── v1.12.1.md
│   │   ├── v1.13.0.md
│   │   ├── v1.13.1.md
│   │   ├── v1.13.2.md
│   │   ├── v1.13.3.md
│   │   ├── v1.13.4.md
│   │   └── v1.13.8.md
│   └── specs/
│       ├── phase2-v1.1.md
│       ├── phase3-v1.2.md
│       ├── phase4-v1.3.0.md
│       ├── phase5-v1.4.0.md
│       ├── phase6-v1.5.0.md
│       ├── phase7-v1.6.0.md
│       ├── phase8-targets.md
│       ├── phase9-socks5.md
│       ├── phase10-master.md
│       ├── phase11-v1.9.0.md
│       ├── phase12-udp.md
│       ├── phase13-ping-traffic.md
│       ├── phase14-mux.md
│       └── project-spec.md
├── package.json
├── package-lock.json
├── scripts/
│   ├── systemd/
│   │   ├── p2pgate-client.service
│   │   └── p2pgate-server.service
│   ├── termux/
│   │   └── service/
│   │       └── p2pgate/
│   │           ├── run
│   │           └── log/
│   │               └── run
│   ├── termux-boot.sh
│   └── windows/
│       └── install-task.ps1
└── src/
    ├── allowlist.js
    ├── audit-log.js
    ├── audit-view.js
    ├── auth-guard.js
    ├── auth.js
    ├── cli.js
    ├── client.js
    ├── config-loader.js
    ├── config-tools.js
    ├── control.js
    ├── crypto-utils.js
    ├── device-registry.js
    ├── doctor.js
    ├── hosts.js
    ├── i18n.js
    ├── keygen.js
    ├── master.js
    ├── mux.js
    ├── quickstart.js
    ├── self-test.js
    ├── server.js
    ├── setup-wizard.js
    ├── socks.js
    └── udp.js
```

### Development and CI

- Manual testing guide (Thai): [`TESTING.md`](TESTING.md)
- Version history: [`CHANGELOG.md`](CHANGELOG.md)
- Contribution guide: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Security policy: [`SECURITY.md`](SECURITY.md)
- The GitHub Actions workflow (`.github/workflows/ci.yml`) runs
  `npm ci --ignore-scripts`, `npm run check`, and `npm run self-test` on
  Ubuntu (Node 20/22/24), Windows (24), and macOS (24) when GitHub Actions
  is available for the account.
- Run the same checks locally before pushing:

```sh
npm test
```

---

## 22) Technical notes

- **Registry merge:** config keys = scram; file entries override; an expired
  file entry denies access
- **POSIX check:** symlink/owner/group-other permissions before the fast path
- **Live reload:** `mtimeMs` + atomic rename
- **Status frames v3:** `DECLINED`, `FASTPATH_READY`, `CHALLENGE_REQUIRED`,
  `READY`
- **Client READY:** sent after obtaining a credential so typing time is not
  counted against the 10-second timeout
- **Control protocol:** newline-delimited JSON, version `2`, max 4096 bytes,
  5-second timeout
- **Control commands:** `status`, `pin`, `revoke`
  - every request requires the per-server control token
  - `status` never returns the PIN
  - `pin` reads from memory only
  - `revoke` calls `AuthGuard.revoke(key, 'manual')` and closes active streams
- **Control socket:** POSIX `0600` with owner/permission verification, Windows
  named pipe, stale-socket probe before removal
- **Control token:** 32 random bytes, SHA-256 digest comparison with
  `timingSafeEqual`, file `0600`
- **Audit log:** serialized JSONL append, one rotated file, secret-field
  filtering, never blocks auth
- **Client key encryption:** scrypt (N=16384, r=8, p=1) + AES-256-GCM, 12-byte
  IV, 16-byte tag
- **JSON output:** `status --json` and `doctor --json` use stdout only
- **doctor:** read-only, exit 1 on `❌`, never prints secrets
- **Trusted expiry:** the CLI requires `--expires` or `--permanent`; existing
  file entries remain compatible
- **SCRAM:** mutual challenge/response with `serverSig` verification
- **Session PIN:** 10 Base32 characters, a new salt on every creation/rotation
- **Async scrypt:** `crypto.scrypt` (N=16384, r=8, p=1)
- **Lockout:** 24-hour failure window, lockfile, atomic rename, mtime reload
- **Concurrency:** 1 per key, 3 total
- **Invalid delay:** 2.5–3.5 seconds (the self-test uses shorter values)
- **No `P2PGATE_TEST_*` environment hooks**
- **Self-test:** uses `HyperDHT.bootstrapper` and injected clock/delay

---

## 22.1) Localization

```sh
P2PGATE_LANG=en p2pgate server
P2PGATE_LANG=th p2pgate setup
```

or:

```sh
p2pgate --lang th doctor
```

The language is selected from `P2PGATE_LANG`/`--lang`, then `LANG`/`LC_ALL`,
and falls back to English. Quickstart, setup, server, connect, and help output
are localized; some legacy command details remain bilingual/in progress.

---

## 23) License

p2pgate is licensed under the **Apache License 2.0**.

- [`LICENSE`](LICENSE)
- [`NOTICE`](NOTICE)

Copyright 2026 incognitums
