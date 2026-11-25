# p2pgate — Handoff

อัปเดตล่าสุด: 2026-11-21
สถานะ: **v1.13.8 released** (code-quality release; SonarCloud 0 issues)
เจ้าของโปรเจกต์: incognitums

เอกสารนี้เขียนไว้ให้เปิด session ใหม่แล้วทำงานต่อได้ทันทีโดยไม่ต้องไล่ประวัติแชท

> ถ้าต้องการให้เอเจนตัวอื่น **คิด product ใหม่** บนฐานนี้ ให้ส่ง
> [`PRODUCT-HANDOFF.md`](PRODUCT-HANDOFF.md) แทน/เพิ่มจากเอกสารนี้

---

## 0. วิธีเริ่ม session ใหม่

วางข้อความนี้ใน session ใหม่:

```text
โปรเจกต์: D:\tunnel\p2pgate (p2pgate v1.13.6)
อ่าน docs/HANDOFF.md ก่อน แล้วสรุปสถานะปัจจุบันและรอคำสั่ง
```

จากนั้นสั่งงานได้เลย เช่น "ทำ soak test", "เพิ่ม multi-port", "ตรวจ repo ก่อนออก v1.7.0"

---

## 1. โปรเจกต์คืออะไร

P2P TCP tunnel สำหรับเข้าถึง SSH บนเครื่องที่อยู่หลัง CGNAT/ไฟร์วอลล์ โดยไม่ต้องเปิด
inbound port ทำงานบน HyperDHT (Noise) พร้อม SCRAM mutual auth

- **Node.js** ≥ 20 (ทดสอบบน Node 24)
- **dependency ภายนอกตัวเดียว:** `hyperdht` 6.36.0 — ห้ามเพิ่มถ้าไม่จำเป็นจริง ๆ
- ทำงานบน Termux/Android, Linux, macOS, Windows
- License: Apache-2.0
- ไม่ rewrite เป็น Go (ตัดสินใจแล้ว)

ลิงก์:

| รายการ | URL |
|---|---|
| Repo | https://github.com/incognitums/p2pgate |
| npm | https://www.npmjs.com/package/p2pgate |
| Release | https://github.com/incognitums/p2pgate/releases/tag/v1.13.6 |

**บัญชี npm:** `incognitums` = บัญชีหลัก (publish ทุกครั้ง), `dhammawatthumpra`
= สำรอง (ยังเป็น owner เพื่อกู้คืน/สลับได้ แต่ไม่ใช้ publish ตามปกติ)
— อย่าถอด owner ของบัญชีสำรอง เว้นแต่จะตั้งใจลดสิทธิ์

---

## 2. สถานะปัจจุบัน

| รายการ | ค่า |
|---|---|
| Version | `1.13.8` |
| npm `latest` | `1.13.8` (published 2026-11-26) |
| Git branch | `main` |
| Commit | `157c861 release: v1.13.8 (SonarCloud cleanup + release tooling)` |
| Tag | `v1.13.8` |
| GitHub Release | `v1.13.8` = Latest |
| Working tree | clean หลัง release |
| SonarCloud | 0 open issues (Security A, Reliability A, Maintainability A) |
| Tests | `npm test` → PASSED (รวม compression + fastpath peek checks) |
| src | 25 ไฟล์ (`src/mux.js`, `src/compress.js`), `src/self-test.js` ~2,620 บรรทัด |

### 2.1 Compression (opt-in, ต้องเปิดทั้งสองฝั่ง)

- โค้ด: `src/compress.js` + mux negotiation ใน `src/client.js` / `src/server.js` (opt-in ทั้งสองฝั่ง)
- เปิด: `p2pgate server --compress` และ `p2pgate connect --compress` (ต้อง mux; socks5 ได้ mux อยู่แล้ว)
- วัดจริงบน 4G: 64 MiB text 11.98s → 4.64s (**2.4×**), log 11.54s → 4.40s (**2.6×**); ผู้ใช้รู้สึก ~1.9× (รวม setup 2.2s)
- Soak 4 ชม. บน 4G: 240/240 รอบ, 0 failure, RSS ทั้งสองฝั่งราบ (`spike/soak/results.md`)
- **Bug fix (pre-existing)**: fast-path peek ทำข้อมูลหายหลัง newline แรก (~65 KB ต่อ 64 MiB) — แก้ใน `src/auth.js` + regression check
- ข้อจำกัด: Node 20 ได้ gzip, pipeline ฝั่งมือถือจำกัด ~14 MB/s, SSH ได้ ~1.0× (ใช้ `ssh -C`), `auto` ใช้ได้เฉพาะ mux
- รองรับทั้ง mux และ non-mux (challenge proof + fast-path peek line; peer เก่าจะไม่บีบอัด)
- `compress: "auto"` (สุ่ม 32 KiB/60 ms, ตัดสินครั้งเดียวต่อ process) + bomb guard (4 GiB / 1000×)
- รายละเอียด + gate ก่อนปล่อย: `docs/spikes/compress-mux.md`

ตรวจสถานะเร็ว ๆ:

```powershell
cd D:\tunnel\p2pgate
git status --short
git log --oneline --decorate -3
npm test
npm view p2pgate version
```

### 2.0 Release process (กันพลาดซ้ำ)

- อ่าน [`RELEASING.md`](../RELEASING.md) — ลำดับตายตัว:
  **bump/docs → commit → `npm publish` (เจ้าของ) → `node scripts/release.js --after-publish`**
- `npm run release:check` ตรวจ badge เวอร์ชัน, release notes, CHANGELOG, และ CLI flag
  ที่ยังไม่ถูกเขียนใน README
- `node scripts/release.js` (preflight) ต้องมี working tree clean + checks ผ่าน
- `node scripts/release.js --after-publish` จะ **รอจน npm เสิร์ฟเวอร์ชันและ README ใหม่**
  ก่อนสร้าง tag/GitHub Release (แก้ปัญหาออก release ก่อน npm พร้อม)
- `prepublishOnly` รัน `npm test` + release check อัตโนมัติ

---

## 3. ประวัติรุ่น (สรุป)

### v1.13.5 (metadata)

- ย้าย repo → `github.com/incognitums/p2pgate` (author/repository/bugs/homepage,
  README, NOTICE, docs, systemd `Documentation=`)
- npm: `incognitums` เป็นบัญชีหลัก, `dhammawatthumpra` เป็น owner สำรอง
- ไม่มีการเปลี่ยนโค้ด

### v1.13.4 (tests + docs)

- fast-path matrix +6 checks (รวม **82**): mux+target+1 MiB, no-mux+target+eager,
  no-mux+binary, mux+parallel, socks+mux default, socks+no-mux, mux:false+target
- README Socket badge ใช้ `?v=<version>` และ `docs:check` บังคับให้ตรง version
  (กันภาพ badge ค้าง "in progress")

### v1.13.3 (fast-path target)

- แก้ `--target` ถูกเมินบน trusted device: server ประกาศ `"target": true` ใน
  `FASTPATH_READY`, client ส่งชื่อ target ใน peek window, server resolve แล้วตอบกลับ
- ไม่เพิ่ม round-trip (ใช้ peek 200 ms เดิม), client ส่งได้แค่ **ชื่อ** target
- server เก่า: client fail ด้วย `TARGET_UNSUPPORTED` แทนการใช้ default เงียบ ๆ
- self-test: 76 checks (เพิ่ม target จริง + unknown target)

### v1.13.2 (hotfix)

- **แก้ regression 1.13.0**: server peek แล้ว forward เฉพาะไบต์หลัง newline ทำให้
  บรรทัดแรกของ client หาย (SSH banner) → `ssh` ขึ้น `Bad packet length` / MAC error
- `peekControlLine()` คืน `raw` (ทุกไบต์ที่อ่าน) และ server ใช้ `raw` เมื่อไม่ใช่
  mux upgrade
- self-test: เขียน payload ทันทีหลัง connect (จำลอง SSH) — fail ก่อนแก้, ผ่านหลังแก้
- self-test: 73 checks

### v1.13.1 (default mux for socks)

- `--socks5` เปิด mux เป็นค่าเริ่มต้น (tunnel ปกติยัง opt-in), เพิ่ม `--no-mux`
  (ชนะ `--mux`/config) และ client config `"mux": false`
- logic อยู่ใน `resolveMuxEnabled()` (client) ทดสอบได้ด้วย unit test
- แก้ self-test harness `readExactly()` ที่ทิ้งไบต์ส่วนเกิน (reply+banner มา packet เดียว)
- self-test: 72 checks

### v1.13.0 (fast-path mux)

- mux ใช้ได้บน trusted device: `FASTPATH_READY` พก `mux` capability,
  client ขอ upgrade ทันที, server peek ≤200 ms / ≤512 B แล้วจึงเลือก mux หรือ forward
- `peekControlLine()` (auth) — ไม่ throw, คืน `{ line: null, leftover }` เมื่อ timeout
- config: `mux` (default true), `muxPeekMs` (0 = พฤติกรรม 1.12)
- log `FASTPATH mux=1|0`, audit `auth.fastpath` มี field `mux`
- ทดสอบข้ามเครื่อง (Windows → Termux 1.13.0): `fastpath=1`, โหลด 4 MiB SHA-256 ตรง
- self-test: 71 checks

### v1.12.1 (fix)

- แก้ **truncation ตอนปิด** ทั้ง mux และ dedicated stream (destroy ก่อน flush)
- mux half-close จริง: `CLOSE` = FIN, ปิด channel เมื่อทั้งสองฝั่งส่ง FIN
- client backpressure: `write()` → false + `drain`, pause/resume socket, queue cap 1 MiB
- server: pause target socket แทน RESET ทันที, RESET เฉพาะเกิน 1 MiB
- dedupe การสร้าง carrier (race ตอนเปิดหลาย connection พร้อมกัน)
- เพดาน server: 64 carriers / 512 channels (`MUX_BUSY`)
- `status --json`: `traffic.mux = {carriers, channels}` + `channels` ต่อ record
- self-test: 66 checks (backpressure, half-close, 1 MiB mux, parallel channels, status)

### v1.12.0 (mux)

- `--mux` (opt-in): carrier เดียว authenticate ครั้งเดียว, สูงสุด 128 channels
- framing ใหม่ `src/mux.js`: OPEN/OPEN_OK/OPEN_ERR/DATA/WINDOW/CLOSE/RESET/PING/PONG
- flow control ต่อ channel: frame 16 KiB, window 256 KiB, queue cap 64 KiB
- carrier idle 5 นาที, keepalive 30 วินาที
- ใช้ได้กับ `--socks5` และ target mode; channel error fallback ไป dedicated stream
- fastpath/trusted device ใช้ mux ไม่ได้ (`FASTPATH_READY` มาก่อน proof) → เตือน + fallback
- self-test: mux framing, carrier ผ่าน challenged session, fastpath fallback (60 checks)

### v1.11.4 (ops)

- `--save <alias>` + `connect @alias` + `ping @alias` + `ping --all` (hosts.json 0600)
- `p2pgate hosts list|remove`
- `p2pgate audit --tail/--failures/--since/--json`
- `p2pgate server --ttl/--idle/--once`
- self-test: 57 checks

### v1.11.3 (fix)

- ping วัด connect + authenticated handshake แทน ping frame
  → ใช้ได้กับ trusted fastpath/key-only/challenge
- ลบ server ping-frame handler ที่ไม่จำเป็น

### v1.11.2 (fix)

- คำสั่งฝั่ง client ใช้ fallback `client.json` เมื่อไม่มี `config.json`
  (`ping`, `client`, `udp`, `config`, `doctor`, `master`, `keygen`)
- `ping` แสดงคำใบ้เมื่อ Server เก่ากว่า 1.11 (`AUTH_PROTOCOL`)

### v1.11.1 (fix)

- self-test ใช้ client key ใน temp dir (ไม่แตะ `~/.p2pgate/client-key.json`)
- flush output แล้ว `process.exit()` → `npm test` ไม่ค้างเมื่อล้ม
- Termux: self-test จบใน ~17 วิ

### v1.11.0 (feature)

- `p2pgate ping` (auth time + RTT, no listener, exit 1 when unreachable)
- traffic counters ใน `status`: totalIn/totalOut + active streams (tcp/udp)
- `status --watch` รีเฟรชทุก 1 วินาที
- self-test: 54 checks

### v1.10.0 (feature)

- UDP forwarding: `udpTargets` ฝั่ง Server + `p2pgate udp --target` ฝั่ง client
- framing `[len:uint16][payload]`, cap 1200 ไบต์, session per endpoint, idle 60 วิ
- client ส่งได้เฉพาะชื่อ target; host ต้อง 127.0.0.1; ตอบกลับทาง stream เดิมเท่านั้น
- self-test: UDP echo + oversized drop (52 checks)

### v1.9.1 (docs + guard)

- README/README.th เปลี่ยนหัวเป็น v1.9 (ค้างจาก 1.9.0)
- เพิ่ม `scripts/check-docs.js` + `npm run docs:check` ต่อเข้า `npm test`
  → publish ด้วย docs ที่ไม่ตรง version ไม่ได้

### v1.9.0 (hardening)

- `p2pgate config validate|show` (ปิด secret) + JSON output
- doctor: fingerprint/อายุ secret, probe targets, เตือน SOCKS `0.0.0.0/0`
- `socks.perClient` override allowlist ต่อ key
- prompt: Enter ว่างถามซ้ำเงียบ ๆ
- tests 50 checks

### v1.8.4 (feature)

- `master reset --no-backup` สำหรับ incident (ไม่เก็บ secret เก่าบนดิสก์)
- `SECURITY.md` เพิ่มหัวข้อ Incident response (revoke → password → master → restart → clients)
- self-test: ยืนยันว่า `--no-backup` ไม่ทิ้งไฟล์ `.bak-*`

### v1.8.3 (feature)

- `p2pgate master show [--reveal]` และ `master reset [--yes] [--dry-run]`
- reset สำรอง config เป็น `config.json.bak-<timestamp>` (0600) และบันทึก audit
  `master.reset` (fingerprint เท่านั้น)
- ไม่กระทบ password/trusted keys/targets; client ใช้ค่าใหม่ทันที, server ต้องรีสตาร์ต

### v1.8.2 (fix)

- แก้ save → load round-trip: `targets.*.allow: null` และ `socks.allow: []`
  (ตอน disabled) ถูก reject ทำให้ config ที่ระบบเขียนเองเปิดไม่ได้
- client config ไม่เขียน `targets`/`defaultTarget`/`socks` อีก
- self-test เพิ่ม config round-trip

### v1.8.1 (docs)

- แก้ project structure ใน README/README.th ให้ครบและเรียงตามรุ่น
  (releases v1.4.0→v1.8.1, specs phase8/phase9, scripts, src ใหม่)

### v1.8.0 (feature)

- SOCKS5 gateway: `connect --socks5 <port>` + `socks` allowlist ฝั่ง Server
- Server resolve hostname และตรวจทุก resolved IP กับ allowlist (กัน rebinding)
- รองรับ TCP CONNECT + IPv4 เท่านั้น; UDP/BIND/IPv6 ถูกปฏิเสธ
- log `SOCKS ALLOW` / `SOCKS DENIED`, success reply หลัง auth เท่านั้น

### v1.7.0 (feature)

- `targets` map: Server expose หลาย service (`ssh`, `web`, `db`)
- `connect --target <name>` / `client --target <name>`
- per-target `allow` list, `defaultTarget` สำหรับ client รุ่นเก่า
- Client log `TARGET <name> -> 127.0.0.1:<port>`; `status --json` มี `targets`
- client ส่งได้เฉพาะชื่อ target (กัน SSRF), host ต้องเป็น 127.0.0.1

### v1.6.4 (patch)

- `p2pgate server --port <targetPort>` / `--target-port <targetPort>`
  override พอร์ตปลายทางเฉพาะรอบที่รัน (ไม่บันทึก)
- error code `PORT_INVALID` แยกจาก config error
- `targets` (multi-port) อยู่ในแผน v1.7.0

### v1.6.3 (patch)

- ข้อความเริ่มของ `p2pgate client` บอกชัดว่า PIN/รหัสผ่านจะถูกถามเมื่อมี connection
- เพิ่ม log ก่อน prompt ว่าเซิร์ฟเวอร์ขอการยืนยันตัวตน
- lazy prompt คงเดิม (trusted/fast-path ไม่ถูกถาม)

### v1.6.2 (patch)

- ปรับข้อความ prompt เป็น `🔐 PIN (10 ตัว) หรือรหัสผ่าน (12 ตัวขึ้นไป):`
- ปรับข้อความแจ้ง credential ผิดรูปแบบให้เป็นกลาง (เลิกใช้คำว่า "รหัสผ่านสำรอง")
- ไม่กระทบ protocol/config/พฤติกรรม

### v1.6.1 (patch)

- client ส่ง `READY` ทันทีหลังได้ `CHALLENGE_REQUIRED` แล้วจึงถาม PIN/password
  → พิมพ์ช้าไม่ทำให้ stream ตายก่อนตอบ
- server รอ proof ด้วย `max(authTimeoutMs, preAuthTimeoutMs)`
- client retry slot เดิม 1 ครั้งเมื่อ stream ปิดกลาง handshake
- log `AUTH TIMEOUT ... stage=ready|proof`, ข้อความ `การเชื่อมต่อขาดระหว่างรอการยืนยันตัวตน (ลองใหม่ได้)`
- proof timeout ไม่ถูกนับเป็น auth failure (ไม่เพิ่ม lockout)
- `startClient({ credential })` รับฟังก์ชัน async ได้

### Zero-setup server

```sh
p2pgate server
```

ครั้งแรกจะ:

- สร้าง `~/.p2pgate/config.json`
- generate `masterSecret` (64 hex)
- generate connection password (24 ตัว Base32)
- เก็บเฉพาะ SCRAM verifier ใน `authPin.unattended`
- เริ่มทำงานทันที

ถ้าไม่ใช่ TTY (headless) จะเขียน `~/.p2pgate/quickstart.txt` สิทธิ์ `0600` แทนการพิมพ์

### Zero-setup client

```sh
p2pgate connect
p2pgate connect -s <masterSecret> -p <password>
```

- สร้าง `~/.p2pgate/client-key.json` อัตโนมัติ
- สร้าง `~/.p2pgate/client.json`
- เปิด listener `127.0.0.1:8022`
- เตือนเมื่อใช้ `-p` (shell history / process list)
- รองรับ `--password-stdin`, `--secret-stdin`, `P2PGATE_PASSWORD`, `P2PGATE_MASTER_SECRET`

### อื่น ๆ

- `authMode: password|registry`
- `p2pgate password reset`
- `p2pgate setup --easy`
- i18n: `P2PGATE_LANG=en|th`, `--lang`
- `p2pgate status` แสดง `โหมดยืนยันสิทธิ์`

---

## 4. ไฟล์สำคัญ

| ไฟล์ | หน้าที่ |
|---|---|
| `src/cli.js` | entry point, arg parsing, `server` auto-init, `connect`, `password reset`, `--lang`, help |
| `src/quickstart.js` | สร้าง config/password/quickstart credentials |
| `src/config-loader.js` | normalize `authMode` (default = password ถ้าไม่มี keys), validation |
| `src/server.js` | DHT listener, auth flow, `authMode=password` (รับ unregistered key), fastpath |
| `src/client.js` | client auth flow, log `TUNNEL established slot=... serverKey=...` |
| `src/auth.js` | SCRAM primitives ฝั่ง protocol |
| `src/crypto-utils.js` | HKDF, slot derivation, SCRAM verifier, `SESSION_PIN_ALPHABET` |
| `src/auth-guard.js` | lockout, revocation, PIN generation |
| `src/device-registry.js` | `allowedClientKeys` + `trusted_devices`, `fastpathAllowed` |
| `src/audit-log.js` | JSONL audit + forbidden-field filter + rotation |
| `src/control.js` | local control socket (`status`, `pin`, `revoke`, `unlock`) |
| `src/doctor.js` | health checks (รองรับ password mode) |
| `src/keygen.js` | client key + passphrase protection |
| `src/setup-wizard.js` | advanced setup + `--easy` + i18n |
| `src/i18n.js` | `P2PGATE_LANG` / `--lang` / `t(th, en)` |
| `src/self-test.js` | 76 checks รวม password, targets, SOCKS5, UDP, ping, hosts, audit, mux, peek |
| `src/mux.js` | mux framing, `MuxCarrier`, `MuxChannel`, flow control, idle/keepalive |

Docs: `docs/specs/phase7-v1.6.0.md` (spec), `docs/releases/v1.6.3.md` (patch notes),
`docs/SERVICE.md` (service/Termux/systemd/Windows runbook),
`docs/releases/v1.6.0.md` (release notes),
`TESTING.md` (คู่มือทดสอบภาษาไทย), `README.md` / `README.th.md`

---

## 5. คำสั่งที่ใช้บ่อย

```powershell
# dev
npm test                 # check + 57 self-test checks
npm run check            # syntax check ทุกไฟล์
npm run self-test

# ใช้งาน
p2pgate server
p2pgate connect
p2pgate connect -s <secret> -p <password> --port 8022
p2pgate connect -s <secret> -p <password> --socks5 1080 --mux
ssh -p 8022 localhost

# จัดการ
p2pgate devices list
p2pgate devices add <key> --mode trusted --expires 2026-12-31T23:59:59Z --comment "my-pc"
p2pgate devices remove <key>
p2pgate password reset
p2pgate status --json
p2pgate doctor --json
p2pgate revoke <key>
p2pgate unlock --list
```

---

## 6. Invariants — ห้ามทำพัง

1. **Password ไม่ถูกส่งเป็น plaintext** ผ่าน network/DHT — ส่งเฉพาะ SCRAM proof
   และเก็บเฉพาะ verifier (`saltHex`, `storedKeyHex`, `serverKeyHex`)
2. **`serverKey` ใน client log คือ DHT public key** ของ slot (`TUNNEL established
   slot=498525 serverKey=...`) ไม่ใช่ `masterSecret` และไม่ใช่ SCRAM `serverKeyHex`
   ผู้ใช้ใช้ค่านี้ยืนยันว่า "ต่อถูกเครื่อง" — **ตกลงกันแล้วว่าไม่ต้องเปลี่ยนชื่อ log**
   ค่านี้เปลี่ยนทุกชั่วโมงตาม slot
3. **config เก่าไม่ถูกสลับโหมด**: ถ้าไม่มี `authMode` และมี `allowedClientKeys`
   → ถือเป็น `registry` (รักษาพฤติกรรม v1.5)
4. **`authMode=password` + `verificationMode=key-only` = config error** (ห้ามรวมกัน)
5. **registry ว่างเริ่มได้เฉพาะ password mode**; registry mode ยังต้องมี key
6. **`trusted_devices` ต้องสิทธิ์ 0600** ไม่งั้น `permissionsOk=false` → fastpath ปิด
7. **tunnel bind `127.0.0.1` เท่านั้น**
8. **audit log ต้อง drop** ฟิลด์ `pin|password|passphrase|secret|seed|verifier|
   storedKey|serverKey|token|privateKey|key`
9. **ไม่เพิ่ม dependency ภายนอก** นอกจาก `hyperdht`
10. **`p2pgate server` ต้องรันก่อน** `p2pgate connect` (ไม่ใช่บั๊ก)
11. **target ต้องเป็นชื่อจาก `targets` ของ Server เท่านั้น** — client ห้ามส่ง
    `host:port` และ `host` ต้องเป็น `127.0.0.1` (กัน SSRF)
12. **SOCKS5 ปลายทางต้องผ่าน allowlist ฝั่ง Server** (IPv4/CIDR + port) และ
    server ต้องตรวจ **ทุก IP ที่ resolve ได้** ก่อนเชื่อมต่อ
13. **mux channel ต้องผ่านการตรวจเดียวกับ stream ปกติ** — `OPEN` ส่งได้แค่ชื่อ
    target หรือ SOCKS destination; ไม่มี `host:port` ดิบ และต้องถูกตรวจ allowlist
    ทุกครั้งที่เปิด channel (ไม่ใช่ตรวจครั้งเดียวตอน carrier)
14. **ห้ามปิด connection ด้วย `destroy()` ก่อน flush** — ทั้ง mux และ stream ปกติต้อง
    `end()`/ส่ง FIN แล้วรออีกฝั่งปิด; `destroy()` ใช้เฉพาะ error/abort เท่านั้น
    (1.11.x–1.12.0 ทำพลาดข้อนี้ → ไฟล์ใหญ่ขาดท้ายเงียบ ๆ)
15. **ทุกทิศทางต้องมี backpressure** — ถ้าเขียนไม่ทันให้หยุดอ่าน (pause) ไม่ใช่สะสม
    queue ไม่จำกัด และถ้าปล่อย `write()` คืน false ต้องมี `drain` ให้ปลด
16. **peek บน fast-path ต้องคืนไบต์เสมอ** — `peekControlLine` ห้าม throw และต้องคืน
    `leftover`/`raw` ทุกกรณี (timeout/ปิด/เกิน 512 B); เมื่อไม่ใช่ mux upgrade
    server ต้อง forward `raw` (รวมบรรทัดและ newline) — ห้ามใช้ `leftover` อย่างเดียว
    (เคสนี้ทำให้ SSH พังใน 1.13.0/1.13.1)
17. **`--target` บน fast path ต้องเป็นชื่อที่ server resolve เอง** — client ส่งได้
    เฉพาะไบต์ใน peek window; ถ้า server ไม่ประกาศ `target` capability ต้อง fail
    ชัดเจน (`TARGET_UNSUPPORTED`) ห้าม fallback ไป `defaultTarget` เงียบ ๆ

---

## 7. Config ที่ควรรู้

```json
{
  "mode": "server",
  "masterSecret": "<64 hex>",
  "authMode": "password",
  "verificationMode": "hybrid",
  "targetPort": 8022,
  "localPort": 8022,
  "allowedClientKeys": [],
  "trustedDevicesFile": "~/.p2pgate/trusted_devices",
  "authPin": {
    "enabled": true,
    "unattended": { "saltHex": "...", "storedKeyHex": "...", "serverKeyHex": "..." }
  },
  "auditLog": { "enabled": true, "path": "...", "maxBytes": 5242880 }
}
```

| ค่า | ความหมาย |
|---|---|
| `authMode: password` | รับ client key ที่ไม่รู้จักได้ถ้า password ถูก (default ของ zero-setup) |
| `authMode: registry` | ต้องอยู่ใน `allowedClientKeys`/`trusted_devices` |
| `verificationMode: hybrid` | trusted → fastpath, อื่น ๆ → challenge |
| `verificationMode: key-only` | เฉพาะ key, ไม่มี PIN |
| `verificationMode: two-step` | challenge ทุกครั้ง |

---

## 8. ข้อจำกัด / ยังไม่ได้ทดสอบ

| เรื่อง | สถานะ |
|---|---|
| GitHub Actions | **ปิด** เพราะบัญชีติด billing lock — ใช้ `npm test` local |
| Soak test 24 ชม. | บันทึกผลรอบแรกแล้ว (overnight ผ่าน, ยังไม่เก็บ reconnect/memory) ดู `docs/SOAK.md` |
| Multi-client พร้อมกัน | ยังไม่ stress |
| Wi-Fi ↔ 4G switching | ยังไม่ทดสอบ |
| NAT บางรูปแบบ | ยังไม่ครอบคลุม |
| mux บนอุปกรณ์จริง | ✅ 1.12.1 (Windows→Termux, 1 carrier/3 channels) และ 1.13.0 trusted device (`fastpath=1`) |
| mux โอนไฟล์ใหญ่ | ✅ 1.12.1: 8/32 MiB upload+echo, 16 MiB download, 8 channels × 4 MiB — SHA-256 ตรง |
| 1.13.0 บนอุปกรณ์จริง | ✅ Termux + Windows global 1.13.0; trusted device จริงได้ `MUX carrier established … fastpath=1` และ SSH banner ผ่าน |
| 1.13.1 บนอุปกรณ์จริง | ✅ npm ผ่าน validation, Termux/Windows 1.13.1, server หลักรีสตาร์ต, `ping` ผ่าน, `--mux` trusted ได้ `fastpath=1` |
| 1.13.2 (hotfix) | ✅ SSH จริงผ่าน tunnel แบบไม่ใช้ mux (`ssh … 'echo SSH_OK'` → exit 0) บน setup จริง Windows↔Termux |
| 1.13.3 (fast-path target) | ✅ done-test ข้ามเครื่อง: `--target mcp` ได้ MCP JSON (`server":"p2pmcp"`), `--target default` ได้ SSH banner |
| mux กับ trusted/fastpath | ✅ 1.13.0 — capability + peek 200 ms; client/server 1.12 ยังทำงานเดิม |
| TUN / subnet routing | ไม่รองรับ (Termux ทำไม่ได้ถ้าไม่ root) |
| i18n legacy commands | แปลไม่ครบ (setup/server/connect/help แปลแล้ว) |

---

## 9. งานถัดไปที่เป็นไปได้

เรียงตามความคุ้ม:

1. **Publish v1.13.3** — `npm publish` (OTP), GitHub Release, อัปเกรด Termux/Windows,
   ทดสอบ `--target` ข้ามเครื่องบน trusted device (mcp 8787 vs sshd 8022)
2. **Network switching** — ปิด/เปิด Wi-Fi, สลับ 4G, ดูว่า reconnect เองได้
   (สำคัญขึ้นเมื่อ mux เป็น default เพราะ carrier ตาย = ทุก channel ตายพร้อมกัน)
3. **Soak mux 24 ชม. + multi-client** — ต่อยอดจาก 4 ชม. (§1.5–1.6)
3. **เปิด `--mux` เป็น default ของ `--socks5`** — หลัง soak mux ผ่าน (1.12.x)
4. **เปิด CI** — แก้ billing หรือย้ายไป CI อื่น (workflow มีอยู่แต่ disable)
5. **SOCKS5 ส่วนขยาย** — IPv6 destinations, UDP ASSOCIATE
6. **แปล legacy CLI/doctor ให้ครบ en/th**
7. **เตรียม core สำหรับ p2phub** — `p2pgate enroll`, `p2pgate agent`,
   client config `serverPublicKey`, `connect --name` (ดูข้อ 10)

---

## 10. ความสัมพันธ์กับ `p2phub` (โปรเจกต์แยก)

มีโปรเจกต์ใหม่แยกออกไปแล้ว:

- Path: `D:\tunnel\p2phub` (git repo แยก, commit initial scaffold แล้ว)
- Spec: `D:\tunnel\p2phub\docs\spec.md`
- npm name: `p2phub` (ยังว่างบน npm ณ 2026-11-15)
- แนวคิด: optional control plane — inventory, directory, policy, enrollment,
  secret custody (ไม่ proxy data, hub คุยผ่าน DHT เอง)

สิ่งที่ **p2phub ต้องรอจาก core** (ทำเมื่อเริ่ม v1.7):

| ของที่ต้องเพิ่มใน p2pgate | ใช้ทำอะไร |
|---|---|
| `p2pgate enroll --hub --token` | ลงทะเบียนเครื่องกับ hub |
| `p2pgate agent --interval` | heartbeat จาก `status --json` |
| client config `serverPublicKey` | ต่อได้โดยไม่ต้องถือ `masterSecret` |
| `p2pgate connect --name` | resolve ชื่อผ่าน hub |
| `targets` | ให้ route enforcement ต่อพอร์ตได้ |

**อย่าเริ่มแก้อะไรใน p2pgate เพื่อ p2phub จนกว่าจะเริ่ม v1.7 อย่างเป็นทางการ**

---

## 11. Release checklist (รุ่นถัดไป)

```powershell
cd D:\tunnel\p2pgate

# 1. ตรวจ
npm test
npm run docs:check
git status --short

# 2. เลขรุ่น + docs
npm version <version> --no-git-tag-version --ignore-scripts
# แก้ CHANGELOG.md, README.md, README.th.md, docs/releases/v<version>.md,
# docs/specs/phaseX-*.md, TESTING.md (จำนวน checks), docs/HANDOFF.md

# 3. commit + tag + push
git add -A
git commit -m "feat(release): v<version> <summary>"
git tag -a v<version> -m "p2pgate v<version>"
git push origin main
git push origin v<version>

# 4. npm (ต้องมี OTP จากเจ้าของบัญชี)
npm publish

# 5. GitHub Release
gh release create v<version> --draft --title "p2pgate v<version>" --notes-file docs/releases/v<version>.md
gh release edit v<version> --draft=false --latest --notes-file docs/releases/v<version>.md

# 6. ตรวจ
npm view p2pgate version
npx --yes p2pgate@<version> --version
```

หลัง publish ต้องทดสอบบน Termux ด้วย (ติดตั้งจริง + `npm test` ใน
`npm root -g/p2pgate`)

---

## 12. สภาพแวดล้อมที่ใช้ทดสอบ

**Windows (เครื่องหลัก)**

```text
D:\tunnel\p2pgate
Node v24.15.0
npm 11.17.0
client config: C:\Users\csuti\.p2pgate\client.json
```

**Termux (Redmi 14C)**

```text
ssh: watthumpra@100.76.100.90 -p 8022   (ผ่าน Tailscale)
key: %USERPROFILE%\.ssh\id_ed25519
known_hosts: $env:TEMP\p2pgate_known_hosts
node 24 (v24.22.3), p2pgate 1.12.0 ติดตั้งแบบ global
server รันด้วย `setsid nohup p2pgate server > ~/p2pgate-server.log 2>&1` (headless, ไม่มี TTY)
→ ไม่มี Session PIN; ใช้ password mode / trusted device
```

คำสั่งตรวจ Termux:

```powershell
ssh -p 8022 -o BatchMode=yes -o StrictHostKeyChecking=no `
  -o UserKnownHostsFile="$env:TEMP\p2pgate_known_hosts" `
  -i "$env:USERPROFILE\.ssh\id_ed25519" `
  watthumpra@100.76.100.90 'p2pgate --version; p2pgate status'
```

---

## 13. Gotchas ที่เคยเจอ

| อาการ | สาเหตุ/วิธีแก้ |
|---|---|
| `PEER_NOT_FOUND` | `p2pgate server` ไม่ได้รัน / secret ไม่ตรง / เวลาเครื่องต่างกัน > 1 ชม. / UDP ถูกบล็อก |
| `authentication failed: ไม่ได้รับข้อความท้าทาย...` แล้วรอบถัดไปต่อได้ | stream ตายระหว่างพิมพ์ (server restart หรือเกิน 120 วิ) — v1.6.1 retry ให้เองและ log `auth stream closed ... retrying once` |
| headless/service แล้ว client ถูกปฏิเสธ `interactive_unavailable` | ไม่มี TTY จึงไม่มี Session PIN — ใช้ `verificationMode: key-only`, trusted fastpath, หรือ `authMode: password` (ดู `docs/SERVICE.md`) |
| `ssh: Connection closed by 127.0.0.1` | tunnel ต่อ Server ไม่ได้ (มักเป็นข้อบน) |
| client ค้างโดยไม่ถาม password | ใช้ `p2pgate client` (advanced) ซึ่งไม่บังคับ credential — ต้องมี `-p` หรือ prompt ถ้าใช้ `connect` |
| trusted ไม่ fastpath | ยังไม่ `devices add --mode trusted`, หมดอายุ, หรือไฟล์สิทธิ์ไม่ใช่ 0600 |
| `-p` เตือนทุกครั้ง | ตั้งใจ — ใช้ prompt/`--password-stdin`/`P2PGATE_PASSWORD` แทน |
| `MUX unavailable (fast-path ...)` แม้ใส่ `--mux` | device เป็น trusted/fastpath — ใช้ key แบบ `scram` หรือ password mode |
| SOCKS ผ่าน mux ขึ้น `SOCKS_DENIED` | ปลายทางไม่อยู่ใน `socks.allow` ฝั่ง Server (mux ตรวจทุก channel) |
| headless server หา password ไม่เจอ | ดู `~/.p2pgate/quickstart.txt` (0600) แล้วลบหลังคัดลอก |
| Windows ไม่เตือนสิทธิ์ไฟล์ | Windows ไม่ตรวจ POSIX perms (พฤติกรรมที่รู้อยู่) |
| npm page แสดง README อังกฤษ | `readmeFilename` ใน metadata เป็น `README.th.md` แต่หน้าเว็บแสดง EN — ไม่ต้องแก้ |

---

## 14. สไตล์การทำงานที่ผู้ใช้ต้องการ

- ตอบเป็นภาษาไทย, ศัพท์เทคนิคเป็นอังกฤษได้
- ต้องการคำตอบที่ตรวจสอบได้จริง ไม่เดา — ทดสอบจริงก่อนบอกว่าเสร็จ
- dependency ภายนอกต้องน้อยที่สุด (ตอนนี้มี `hyperdht` ตัวเดียว)
- ไม่ rewrite เป็นภาษาใหม่
- ชอบทดสอบบนอุปกรณ์จริง (Termux) ไม่ใช่แค่ mock
- งาน release ต้องอัปเดต docs/CHANGELOG/release notes ให้ครบ
- ก่อน publish npm ต้องขอ OTP จากผู้ใช้

---

## 15. Checklist ก่อนเริ่มงานใน session ใหม่

```powershell
cd D:\tunnel\p2pgate
git status --short          # ต้องรู้ว่ามีไฟล์ค้างไหม
git log --oneline -3
npm test                    # ต้องได้ 60 checks (หรือมากกว่า)
npm view p2pgate version    # ต้องเป็น 1.6.1
```

ถ้าทุกอย่างตรงกับเอกสารนี้ แปลว่า handoff ครบ — เริ่มงานต่อได้เลย
