# Changelog

รูปแบบอ้างอิง [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
และใช้ [Semantic Versioning](https://semver.org/)

## [Unreleased]

- รอผลทดสอบ long-running และการสลับเครือข่าย

## [1.13.8] - 2026-11-25

### Fixed

- `.sort()` ไม่มี comparator ใน `hosts list`, `config-tools` และ `status` — เปลี่ยนเป็น
  `localeCompare` / numeric comparator (เดิมเรียงตาม code unit)
- ลบ option `all` ที่ประกาศซ้ำใน `src/cli.js`
- `src/device-registry.js` เลิกใช้ regex trailing newline (ตัดความเสี่ยง backtracking)
- regex ใน `scripts/check-release.js` กระชับขึ้น (ไม่มี super-linear backtracking)
- `src/mux.js` ใช้ `Math.trunc` แทน `| 0`
- `scripts/soak/mux-termux.sh` ใช้ `[[ ... ]]` แทน `[ ... ]`
- commit `spike/mux/Cargo.lock` เพื่อ reproducibility

### Changed

- เพิ่ม `// NOSONAR` พร้อมเหตุผลในจุดที่เป็น false positive (path จาก operator,
  test credential, sample string) — SonarCloud: 35 issues → **0**
- เพิ่ม release tooling: `scripts/check-release.js`, `scripts/release.js`,
  `RELEASING.md`, npm scripts `release:check` / `release:preflight` / `release:after`
- `prepublishOnly` รัน `npm test` + release check

## [1.13.7] - 2026-11-21

### Changed

- README (EN/TH): เพิ่มหัวข้อ **9.12 Compression (`--compress`)** — วิธีเปิด,
  config, ข้อจำกัด (SSH ใช้ `ssh -C`, `auto` mux-only), ผลวัดบน 4G
- `config.example.json`: เพิ่มตัวอย่าง `compress` (ปิดเป็นค่าเริ่มต้น)

## [1.13.6] - 2026-11-21

### Fixed

- **fast-path (trusted device) ทำข้อมูลหายหลัง newline แรก** — `peekControlLine()`
  คืน `raw` เป็นแค่บรรทัดแรก แต่ branch ที่ไม่ upgrade ส่ง `peek.raw` ต่อเป็น payload
  ทำให้ไบต์หลัง newline แรกในหน้าต่าง peek หายไป (วัดได้ 65,518 ไบต์จาก 64 MiB)
  แก้ให้ `raw` = ทุกไบต์ที่อ่าน + เพิ่ม regression check ใน self-test

### Added

- **compression แบบ opt-in** (`--compress`, `compress: true | "auto"` ใน config)
  - mux channel และ non-mux (challenge proof + fast-path peek line)
  - zstd (Node ≥ 22.15) หรือ gzip, bomb guard (4 GiB / 1000×)
  - ปิดเป็นค่าเริ่มต้น; ต้องเปิดทั้ง server และ client
  - ข้อจำกัด: SSH ได้ ~1.0× (ใช้ `ssh -C`), `auto` ใช้ได้เฉพาะ mux
  - รายละเอียด: `docs/spikes/compress-mux.md`

## [1.13.5] - 2026-11-19

### Changed

- **ย้าย repository ไป `github.com/incognitums/p2pgate`** (เปลี่ยน GitHub username)
  - `package.json`: `author`, `repository.url`, `bugs.url`, `homepage`
  - README (EN/TH), `docs/HANDOFF.md`, `docs/PRODUCT-HANDOFF.md`,
    `docs/README.md` (ลิงก์ p2phub), systemd unit `Documentation=`
  - `NOTICE` และบรรทัด copyright ใน README
- ไม่มีการเปลี่ยนโค้ดหรือพฤติกรรมใด ๆ — รีลีสนี้เพื่อให้ metadata บน npm ชี้ repo ใหม่

## [1.13.4] - 2026-11-18

### Changed

- **fast-path matrix ในชุดทดสอบ** (82 checks, จาก 76): mux+target+1 MiB,
  no-mux+target+eager line, no-mux+binary ใน peek, mux+parallel channels,
  socks+mux default, socks+no-mux, และ server `mux:false` + `--target`
  เหตุผล: บั๊ก 1.13.2 และ 1.13.3 อยู่ในเส้นทาง fast path ทั้งคู่ จึงล็อกทุก
  combination ที่ผู้ใช้เลือกได้
- README: Socket badge ใช้ `?v=<version>` เป็น cache-buster และ `docs:check`
  บังคับให้ query ตรงกับ version — กันภาพ badge ค้างเป็น "in progress"
  หลังอัปเดตแล้ว

## [1.13.3] - 2026-11-17

### Fixed

- **`--target` ถูกเมินบน fast path (trusted device)** — target ถูกส่งเฉพาะใน SCRAM
  proof ซึ่ง fast path ไม่ได้ทำ ⇒ server forward ไป `defaultTarget` เสมอ
  อาการ: `--target mcp` แต่ได้ SSH (port 8022) แทน
- server ประกาศ capability `"target": true` ใน `FASTPATH_READY`; client ส่ง
  `{"v":3,"target":"<name>"}` ภายใน peek window (200 ms เท่าเดิม) แล้ว server
  respond ด้วย target ที่ resolve แล้ว
- target ยังเป็น **ชื่อ** เท่านั้น และ server เป็นคน map เอง (ไม่เพิ่มสิทธิ์)
- ถ้า server เก่าไม่ประกาศ capability: client **fail ชัดเจน** (`TARGET_UNSUPPORTED`)
  แทนการเงียบ ๆ ไป default
- server ที่ตั้ง `muxPeekMs: 0` จะไม่รองรับทั้ง mux และ target บน fast path (ตามดีไซน์)

### Tests

- `npm test` → **76 checks** (เพิ่ม: fast-path `--target` ไปถึง target จริง, และ
  unknown target ถูกปฏิเสธ)

## [1.13.2] - 2026-11-17

### Fixed

- **ข้อมูลแรกของ client หายบน fast path (regression ตั้งแต่ 1.13.0)** — server
  peek 200 ms แล้ว forward เฉพาะไบต์ *หลัง* newline ทำให้บรรทัดแรกที่ client ส่ง
  มาหายไป อาการที่เจอ: `ssh` ขึ้น
  `Bad packet length …` / `message authentication code incorrect`
  เพราะ SSH banner (`SSH-2.0-…\r\n`) ถูกกินไป
- `peekControlLine()` คืน `raw` (ไบต์ทั้งหมดที่อ่าน รวมบรรทัดและ newline) และ server
  ใช้ `raw` เมื่อไม่ใช่ mux upgrade → ข้อมูลทุกไบต์ถึง target
- self-test เพิ่มเคส "เขียน payload ทันทีหลัง connect" (จำลอง SSH banner) ซึ่งfail
  ก่อนแก้และผ่านหลังแก้

### Notes

- กระทบเฉพาะ client ที่ **ไม่ใช้ mux** บน trusted device; ถ้าใช้ `--mux`
  เส้นทาง upgrade จะไม่ผ่าน peek จึงไม่โดน
- แนะนำอัปเกรดจาก 1.13.0/1.13.1 เป็น 1.13.2

## [1.13.1] - 2026-11-17

### Changed

- **`--socks5` เปิด mux เป็นค่าเริ่มต้น** — `p2pgate connect --socks5 <port>` และ
  `p2pgate client --socks5` ใช้ carrier เดียวโดยไม่ต้องใส่ `--mux` (โหมด tunnel ปกติ
  ยังเป็น opt-in เหมือนเดิม) เพราะหน้าเว็บหนึ่งหน้าอาจเปิด 20–40 connection
- เพิ่ม `--no-mux` (ชนะ `--mux` และ config) และ client config `"mux": false`
  สำหรับผู้ที่ต้องการปิด
- help/README อัปเดต: ตาราง flag และคำอธิบาย default ต่อโหมด

### Fixed

- self-test harness: `readExactly()` เคยทิ้งไบต์ส่วนเกินเมื่อ reply กับข้อมูลแรก
  มาใน packet เดียว (เจอตอน socks+mux ที่ reply 10 ไบต์กับ banner 20 ไบต์ coalesce)
  — ตอนนี้เก็บส่วนเกินไว้ต่อ socket และใช้ต่อใน read ถัดไป

### Tests

- `npm test` → **72 checks** (เพิ่มการตรวจ default ของ mux ต่อโหมด + `--no-mux`)
- ทดสอบจริงผ่าน SOCKS5 (Termux, 1 MiB × 10 พร้อมกัน):
  - default (mux): **10/10 สำเร็จ**, carrier เดียว
  - `--no-mux`: **3/10** — อีก 7 ถูกปฏิเสธ `busy` เพราะแต่ละ connection ต้อง
    authenticate เองและ auth guard จำกัด 1 ครั้งต่อ key
  ⇒ default mux ไม่ได้แค่เร็วขึ้น แต่แก้ปัญหา connection หลุดตอนเปิดพร้อมกัน

## [1.13.0] - 2026-11-17

### Added

- **mux บน fast-path (trusted device)** — server ประกาศ `mux` capability ใน
  `FASTPATH_READY`, client ขอ upgrade ทันที, server รอไม่เกิน `muxPeekMs` (200 ms)
  แล้วจึงเลือก mux หรือ forward ไบต์ตามเดิม
- `peekControlLine()` (auth): อ่านบรรทัดแบบไม่ throw — timeout/ปิด/ไบต์เกิน limit
  จะคืน `{ line: null, leftover }` เพื่อให้ส่งไบต์ต่อได้ครบ
- config ฝั่ง server: `mux` (default `true`) และ `muxPeekMs` (0–5000, default 200;
  `0` = พฤติกรรม 1.12)
- log `FASTPATH mux=1|0` และ audit `auth.fastpath` มี field `mux`

### Changed

- ข้อความ help/README: `--mux` ใช้ได้ทั้ง password และ trusted device
- ข้อความ fallback ของ client เป็นกลาง: `MUX not available on this server or
  device; using one stream per connection`

### Compatibility

- client 1.12 + server 1.13: ไม่มี upgrade → server peek แล้ว forward เหมือนเดิม
- client 1.13 + server 1.12: ไม่มี capability → fallback เงียบ ๆ
- protocol เดิมไม่เปลี่ยน (`AUTH_VERSION` ยังเป็น 3; capability เป็น field เพิ่ม)

### Tests

- `npm test` → **71 checks** (เพิ่ม peek 3 เคส, mux บน fastpath, payload ขึ้นต้น `{`,
  server ปิด mux)

## [1.12.1] - 2026-11-16

### Fixed

- **การโอนข้อมูลขนาดใหญ่ถูกตัดท้าย (ทั้ง mux และ stream ปกติ)** — เมื่อฝั่งหนึ่งปิด
  แบบ graceful อีกฝั่งทำ `destroy()` ทันที ทำให้ข้อมูลที่ยังค้างใน buffer หาย
  อาการ: `scp`/`rsync`/ดาวน์โหลดไฟล์ใหญ่ได้ไฟล์ขาดท้ายโดยไม่แจ้ง error
- **mux ไม่มี backpressure ฝั่ง client** — ตอนนี้ `write()` คืน `false` + emit `drain`
  และ pipe pause/resume socket; queue เกิน 1 MiB จะ RESET พร้อม error แทนการทิ้งเงียบ
- **half-close (FIN) ของ mux ผิดความหมาย** — `CLOSE` เคยปิดทั้ง channel ทำให้ฝั่งที่
  ยังอ่านคำตอบอยู่หยุดรับข้อมูล; ตอนนี้เป็น half-close จริง (ปิดเมื่อทั้งสองฝั่งส่ง FIN)
- **race ตอนสร้าง carrier พร้อมกัน** — หลาย connection ที่เปิดพร้อมกันสร้าง carrier
  ซ้ำ (DHT lookup ซ้ำ); ตอนนี้มี in-flight promise ตัวเดียว
- **server-side queue overflow เคย RESET ทันที** — เปลี่ยนเป็น pause target socket
  ที่ 64 KiB และ RESET เฉพาะเมื่อเกิน 1 MiB (กัน memory โตและกัน RESET ผิดจังหวะ)

### Added

- เพดานระดับ server: carrier สูงสุด 64, channel รวมสูงสุด 512 (`MUX_BUSY` เมื่อเต็ม)
- `status --json`: `traffic.mux = { carriers, channels }` และ `channels` ต่อ record
  (แก้คำอธิบายใน release notes 1.12.0 ที่เขียนเกินจริง)
- log `MUX SESSION closed ... in=<bytes> out=<bytes>` ไว้ตรวจยอดโอน

### Verified

- mux: 8 MiB และ 32 MiB upload+echo, 16 MiB download — SHA-256 ตรงทุกครั้ง
- mux ผ่าน SOCKS5: ดาวน์โหลด 8 MiB ผ่าน `--socks5 --mux` — SHA-256 ตรง (3.5 MB/s)
- mux: 8 channels พร้อมกัน × 4 MiB ผ่าน carrier เดียว — ตรงทุก channel
- abort กลางทาง (เขียน 2 MiB แล้วตัด socket) → connection ถัดไปยังใช้งานได้
- dedicated stream (ไม่ใช้ mux): 16 MiB × 3 รอบ ตรงทุกครั้ง
- `npm test` → **66 checks**

## [1.12.0] - 2026-11-16

### Added

- `--mux` (carrier + channels) สำหรับ `--socks5` และ target mode
  - carrier 1 สาย, channel สูงสุด 128, flow control ต่อ channel
  - ลดค่า connect ต่อ request จาก ~2.2 วิ (DHT) เหลือ ~0 ms หลัง carrier เปิดแล้ว
- mux framing (`src/mux.js`): OPEN/OPEN_OK/OPEN_ERR/DATA/WINDOW/CLOSE/RESET/PING
- fastpath fallback: trusted device ใช้ `--mux` จะ fallback เป็น per-connection
- self-test: framing, carrier ผ่าน challenged session, fastpath fallback (60 checks)

### Notes

- เปิดใช้แบบ opt-in (`--mux`); ยังไม่เปิด default
- carrier idle 5 นาที, keepalive 30 วินาที
- ไม่ audit ต่อ channel (ดูใน `status --json` แทน)

## [1.11.4] - 2026-11-16

### Added

- `--save <alias>` ตอน `connect` → เก็บ host ไว้ใน `~/.p2pgate/hosts.json` (0600)
- `p2pgate connect @alias` / `p2pgate ping @alias` / `p2pgate ping --all`
- `p2pgate hosts list|remove <alias>`
- `p2pgate audit [--tail N] [--failures] [--since 1h] [--json]` อ่าน audit.log
  แบบ tail จากท้ายไฟล์
- `p2pgate server --ttl 30m`, `--idle 15m`, `--once` (ปิดตัวเอง, timer ใน memory)
- self-test: hosts round-trip, audit filter/tail, ttl shutdown (57 checks)

## [1.11.3] - 2026-11-16

### Fixed

- `p2pgate ping` ใช้ไม่ได้เมื่อclient เป็น trusted device (server เลือก fastpath
  และไม่เคยอ่าน proof/ping frame) → เปลี่ยนไปวัด **connect + authenticated handshake**
  แทนการส่ง ping frame
- ทำงานได้ทุกโหมด: fastpath, key-only, challenge (PIN/password)
- `--count N` = จำนวน handshake ที่วัด แล้วรายงาน min/avg/max ของ connect และ auth

## [1.11.2] - 2026-11-16

### Fixed

- คำสั่งฝั่ง client (`ping`, `client`, `udp`, `config`, `doctor`, `master`, `keygen`)
  ใช้ `config.json` เป็นค่าเริ่มต้นเสมอ ทำให้บนเครื่อง client ขึ้น
  "configuration file not found"
- เพิ่ม fallback: ถ้า `config.json` ไม่มีแต่ `client.json` มี → ใช้ `client.json`
  อัตโนมัติ (ยังใช้ `--config` เพื่อระบุเองได้)
- `ping` แสดงคำใบ้เมื่อเจอ `AUTH_PROTOCOL` ว่า Server อาจเป็นรุ่นเก่ากว่า 1.11

## [1.11.1] - 2026-11-16

### Fixed

- self-test ใช้ `~/.p2pgate/client-key.json` (path จริงของผู้ใช้) ใน UDP test
  ทำให้ `npm test` ล้มบนเครื่องที่ไม่เคยมี client key
- เมื่อ self-test ล้ม ยังมี DHT handle ค้าง → process ไม่ยอมจบ (`npm test` ค้าง)
  แก้โดย flush output แล้ว `process.exit()` ทั้งทางผ่านและทางล้ม
- UDP test ระบุ `clientKeyPath` เป็นไฟล์ใน temp dir เสมอ

## [1.11.0] - 2026-11-16

### Added

- `p2pgate ping [--count N] [--json]` — วัด auth time และ RTT ระดับโปรโตคอล
  โดยไม่เปิด listener
- Traffic counters ใน `p2pgate status`: `totalIn`, `totalOut` และรายการ stream
  ที่ใช้งาน (tcp/udp, peer, target, bytes)
- `p2pgate status --watch` รีเฟรชทุก 1 วินาที
- self-test: ping RTT + traffic counters (54 checks)

### Changed

- help ระบุ v1.11 และรองรับ TCP/UDP
- `status` แสดง traffic รวมและ stream ที่ใช้งาน

## [1.10.0] - 2026-11-16

### Added

- UDP forwarding แบบ opt-in: `udpTargets` ฝั่ง Server และ `p2pgate udp --target <name>`
- framing `[len:uint16][payload]`, จำกัด 1200 ไบต์, drop ของที่ใหญ่กว่า
- one session per client source endpoint + idle timeout (ค่าเริ่มต้น 60 วิ)
- `udpTarget` / `udpListen` ใน client config
- Client `udp` ใช้ credential แบบ lazy (ถามเฉพาะเมื่อถูก challenge)
- self-test: UDP echo ผ่าน tunnel + oversized datagram ถูก drop

### Security

- client ส่งได้เฉพาะ **ชื่อ** udpTarget ที่ประกาศใน config
- host ต้องเป็น `127.0.0.1`; ไม่มีทางส่ง datagram ไปปลายทางอิสระ
- ตอบกลับได้เฉพาะ stream ที่ส่งมา → ใช้เป็น reflector ไม่ได้

## [1.9.1] - 2026-11-16

### Fixed

- README/README.th ยังแสดงหัวเป็น v1.8 หลังออก 1.9.0 — อัปเดตเป็น v1.9
  พร้อมสรุปฟีเจอร์ 1.9 (config validate, doctor, per-client SOCKS)

### Added

- `scripts/check-docs.js` + `npm run docs:check`: ตรวจว่า README heading
  (major.minor), โครงสร้างโปรเจกต์, release notes, docs index และ CHANGELOG
  ตรงกับ version ใน `package.json`
- ต่อ `docs:check` เข้า `npm run check` → `npm test` → `prepublishOnly`
  ทำให้ publish ด้วย docs ที่ไม่ตรง version ไม่ได้
- ข้ามการตรวจ `docs/` อัตโนมัติเมื่อรันจากแพ็กเกจที่ติดตั้ง (npm ไม่ publish docs/)

## [1.9.0] - 2026-11-16

### Added

- `p2pgate config validate [--json]` — ตรวจ config ก่อนรัน (exit code 1 เมื่อผิด)
- `p2pgate config show [--json]` — แสดง config ที่ normalize แล้วโดยปิด secret
- `socks.perClient` — allowlist แยกตาม client key (override global ไม่ใช่ union)
- `doctor`: fingerprint/อายุของ masterSecret, ทดสอบว่า target เปิดอยู่จริง,
  เตือน SOCKS allowlist กว้าง (`0.0.0.0/0`)
- self-test: config redaction + per-client SOCKS override

### Changed

- prompt ขอ PIN/password: กด Enter ว่างจะถามซ้ำเงียบ ๆ (ไม่ขึ้น error)
- README/README.th เพิ่มหัวข้อ config commands และ per-client SOCKS

## [1.8.4] - 2026-11-15

### Added

- `p2pgate master reset --no-backup` — ไม่สำรอง config เดิม (สำหรับเหตุฉุกเฉิน
  ที่ไม่ต้องการเก็บ secret เก่าไว้บนดิสก์)
- `SECURITY.md`: หัวข้อ **Incident response** พร้อมลำดับ revoke → password reset
  → master reset → restart → update clients และรายการไฟล์ที่ต้องลบ
- self-test: ตรวจว่า `--no-backup` ไม่ทิ้งไฟล์ `.bak-*`

### Changed

- `SECURITY.md`: ตารางเวอร์ชันที่รองรับอัปเดตเป็น 1.8.x

## [1.8.3] - 2026-11-15

### Added

- `p2pgate master show [--reveal] [--json]` — แสดง fingerprint หรือค่าเต็มของ masterSecret
- `p2pgate master reset [--yes] [--dry-run] [--json]` — หมุน masterSecret
  พร้อมสำรอง config เดิม (`config.json.bak-<timestamp>` โหมด 0600)
- audit event `master.reset` (เก็บเฉพาะ fingerprint ไม่เก็บค่า secret)
- self-test: หมุน masterSecret แล้ว backup ถูกสร้างและ field อื่นยังอยู่

### Changed

- help เป็น v1.8 และเพิ่มหัวข้อ master commands
- README/README.th เพิ่มหัวข้อ 9.4 การหมุน masterSecret

## [1.8.2] - 2026-11-15

### Fixed

- `saveConfig()` เขียน `targets.<name>.allow: null` และ `socks.allow: []`
  ลงไฟล์ แต่ loader ไม่ยอมรับค่าที่ตัวเองเขียน → เปิด config เดิมไม่ได้
  (`targets.default.allow must be a non-empty array...`)
- รับ `allow: null` เป็น "ไม่จำกัด" และยอมให้ `socks.allow: []` เมื่อ `socks.enabled: false`
- config โหมด client ไม่เก็บ `targets`/`defaultTarget`/`socks` อีกต่อไป
  (client ไม่ได้ใช้ — เดิมทำให้ไฟล์ client พังหลัง save)
- เพิ่ม self-test กันการถอยหลัง: config ต้องผ่าน save → load round-trip

## [1.8.1] - 2026-11-15

### Fixed

- README/README.th: โครงสร้างโปรเจกต์ (`## 21) Project structure`) แสดงไฟล์ไม่ครบ
  และข้ามรุ่น — อัปเดตให้ตรงกับ repo จริง
  - release notes ครบ `v1.4.0` → `v1.8.1`
  - specs เพิ่ม `phase8-targets.md`, `phase9-socks5.md`
  - `docs/HANDOFF.md`, `docs/SERVICE.md`
  - `scripts/systemd`, `scripts/termux/service`, `scripts/windows`
  - `src/allowlist.js`, `src/socks.js`

## [1.8.0] - 2026-11-15

### Added

- SOCKS5 gateway ฝั่ง client: `p2pgate connect --socks5 <port>`
- `socks` config ฝั่ง Server พร้อม allowlist แบบ IPv4/CIDR + port
- Server resolve hostname เองและตรวจ **ทุก IP** ที่ resolve ได้กับ allowlist
- Client เก็บ `socks5Port` ไว้ใช้รอบถัดไป
- log `SOCKS ALLOW` / `SOCKS DENIED` และ `target=socks` ใน `AUTH OK`/`FORWARD`

### Security

- SOCKS ปิดโดยค่าเริ่มต้น และต้องมี allow อย่างน้อย 1 รายการ
- ปฏิเสธ `UDP ASSOCIATE`, `BIND`, และปลายทาง IPv6 (v1.8)
- ส่ง SOCKS success หลัง auth สำเร็จเท่านั้น → ปลายทางที่ถูกปฏิเสธไม่ดูเป็น open proxy
- ใช้ `--socks5` ร่วมกับ `--target` ไม่ได้

### Changed

- README/README.th เปลี่ยนหัวเป็น v1.8 พร้อมส่วน SOCKS5
- เพิ่ม `src/socks.js`, `src/allowlist.js` ใน `npm run check`

## [1.7.0] - 2026-11-15

### Added

- `targets` config: Server expose หลาย service พร้อมกัน
  `{ "web": { "host": "127.0.0.1", "port": 8080 } }`
- `defaultTarget` สำหรับ client รุ่นเก่าที่ไม่ส่ง target
- `p2pgate connect --target <name>` / `p2pgate client --target <name>`
- per-target `allow` list (คีย์ client หรือ `"*"`)
- Client log `TARGET <name> -> 127.0.0.1:<port>` และ `target=` ใน `TUNNEL established`
- `status --json` เพิ่ม `targets` และ `defaultTarget`

### Changed

- Server banner แสดงรายการ targets + default target
- `server --port` override ค่า default target เฉพาะรอบ
- `FORWARD` log ระบุ `target=<name>`

### Security

- Client ส่งได้เฉพาะ **ชื่อ target** — ไม่มีทางส่ง `host:port` ดิบ (กัน SSRF)
- target ต้องเป็น `127.0.0.1` เท่านั้น
- target ที่ไม่รู้จัก/ไม่อยู่ใน allowlist ถูกปฏิเสธโดยไม่แตะ service ปลายทาง
  และไม่นับเป็น auth failure (ไม่เพิ่ม lockout)

## [1.6.4] - 2026-11-15

### Added

- `p2pgate server --port <targetPort>` และ `--target-port <targetPort>`
  สำหรับ override พอร์ตปลายทางเฉพาะรอบที่รัน (ไม่บันทึกลง config)
- Error code `PORT_INVALID` พร้อมข้อความแยกจาก config error

### Changed

- Help แสดงรูปแบบ `p2pgate server [--config <path>] [--port <targetPort>]`
- README/README.th เพิ่มแถวคำสั่ง `server --port`
- Roadmap: `targets` (multi-port) อยู่ในแผน v1.7.0

## [1.6.3] - 2026-11-15

### Changed

- ข้อความตอนเริ่ม `p2pgate client` ชัดขึ้นว่า PIN/รหัสผ่านจะถูกถาม
  **เมื่อมี connection เข้ามา** ไม่ใช่ตอนเริ่มโปรแกรม
- เพิ่ม log ก่อนขึ้น prompt: `เซิร์ฟเวอร์ขอการยืนยันตัวตน: กรอก PIN (10 ตัว) หรือรหัสผ่าน (12 ตัวขึ้นไป)`
  เพื่อให้รู้ว่าทำไม prompt โผล่มาหลัง `ssh`
- ข้อความโหมด `--pin-stdin` ระบุว่าเป็นการอ่านเมื่อถูกขอ ไม่ใช่ตอนเริ่ม

### Note

พฤติกรรม lazy prompt คงเดิมโดยตั้งใจ — trusted/fast-path ต้องไม่ถูกถามอะไรเลย

## [1.6.2] - 2026-11-15

### Changed

- ปรับข้อความ prompt ของ client ให้ตรงกับทุกโหมด:
  `🔐 PIN (10 ตัว) หรือรหัสผ่าน (12 ตัวขึ้นไป):`
  (เดิมใช้คำว่า "รหัสผ่านสำรอง" ซึ่งทำให้สับสนใน password mode)
- ปรับข้อความแจ้งเมื่อ credential ผิดรูปแบบให้เป็นกลาง:
  `ต้องเป็น PIN 10 ตัวอักษร หรือรหัสผ่านอย่างน้อย 12 ตัวอักษร`
- Help และ error message เลิกใช้คำว่า "รหัสผ่านสำรอง" เมื่อหมายถึงรหัสผ่านที่ใช้จริง

## [1.6.1] - 2026-11-15

### Fixed

- Client ส่ง `READY` ทันทีหลังได้ `CHALLENGE_REQUIRED` แล้วจึงถาม PIN/password
  ทำให้การพิมพ์ช้าไม่ชนกับ timeout ของ transport อีก
- Server รอ proof ด้วย `max(authTimeoutMs, preAuthTimeoutMs)` เพราะผู้ใช้ต้องพิมพ์
  รหัสหลังได้รับ challenge
- ถ้า stream ปิดระหว่างยืนยันตัวตน Client จะ retry slot เดิมหนึ่งครั้งอัตโนมัติ
  และรายงานว่า `การเชื่อมต่อขาดระหว่างรอการยืนยันตัวตน (ลองใหม่ได้)`
  แทน `authentication failed`
- Server log `AUTH TIMEOUT ... stage=ready|proof` เพื่อวินิจฉัยสาเหตุ
- Timeout ตอนรอ proof ไม่ถูกนับเป็น auth failure (ไม่ทำให้ lockout เพิ่มขึ้น)

### Added

- `startClient({ credential })` รองรับฟังก์ชัน async ที่คืนค่า credential
  (ใช้กับ embedding และ self-test)
- Self-test เพิ่ม 2 เคส: พิมพ์รหัสช้า และ retry เมื่อ stream ปิดกลาง handshake

## [1.6.0] - 2026-11-15

### Added

- Zero-setup `p2pgate server`: สร้าง config, masterSecret และ connection password อัตโนมัติ
- `p2pgate connect` พร้อม `-s/-p` สำหรับเชื่อมต่อแบบบรรทัดเดียว
- `authMode: password|registry` (password เป็นค่าเริ่มต้นของ zero-setup)
- `p2pgate password reset`
- `P2PGATE_LANG=en|th` และ `--lang`
- `quickstart.txt` สำหรับ headless first run (สิทธิ์ `0600`)

### Changed

- `p2pgate setup` เป็น advanced configuration
- Client สร้าง key และ config อัตโนมัติผ่าน `connect`
- `p2pgate server` เริ่มได้แม้ registry ว่างใน password mode
- README/README.th อัปเดต zero-setup flow

### Security

- Connection password 24 ตัวอักษร เก็บเฉพาะ SCRAM verifier
- เตือนเมื่อใช้ `-p` บน command line
- Existing registry configs ไม่ถูกสลับเป็น password mode อัตโนมัติ

## [1.5.0] - 2026-11-15

### Added

- Audit log แบบ JSONL (`~/.p2pgate/audit.log`) พร้อม rotation
- Client key ที่ป้องกันด้วย passphrase (scrypt + AES-256-GCM)
- `p2pgate status --json` และ `p2pgate doctor --json`
- Control token ต่อเซิร์ฟเวอร์ (`~/.p2pgate/control.token`)
- POSIX control socket owner/permission check
- แสดง lockout/revocation state ใน `p2pgate devices list`
- Tests สำหรับ audit, encrypted key, control token, doctor JSON

### Changed

- Control protocol เป็น version `2` และทุก request ต้องมี token
- `config.json` รองรับ `auditLog`
- `doctor` ตรวจ audit log และสถานะ encryption ของ client key
- README/TESTING/docs อัปเดต v1.5

### Security

- Audit log กรอง PIN/password/passphrase/seed/verifier/token
- Control token เปรียบเทียบด้วย SHA-256 + `timingSafeEqual`
- Windows ใช้ token เสริม named-pipe DACL (Node core ตั้ง DACL เองไม่ได้)
- Client key passphrase ไม่รับผ่าน command-line argument

## [1.4.1] - 2026-11-14

### Changed

- README: เพิ่มคำสั่งติดตั้ง `npm install -g p2pgate`, badges และลิงก์ npm
- ปรับเอกสาร release/install ให้ตรงกับแพ็กเกจที่เผยแพร่แล้ว

## [1.4.0] - 2026-11-14

### Added

- Local control socket สำหรับเซิร์ฟเวอร์ที่กำลังรันอยู่
  - POSIX: `~/.p2pgate/control.sock` โหมด `0600`
  - Windows: named pipe
  - newline-delimited JSON, version `1`, request สูงสุด 4096 bytes
- คำสั่ง `p2pgate status`, `p2pgate pin`, `p2pgate revoke <key>`
- `p2pgate doctor` ตรวจสุขภาพการติดตั้งเป็นภาษาไทยด้วย ✅ / ⚠️ / ❌
- `AuthGuard.revoke()` สำหรับเพิกถอนคีย์ถาวรและตัด active tunnel
- บังคับ `--expires` หรือ `--permanent` เมื่อเพิ่ม trusted device ผ่าน CLI
- `TESTING.md` คู่มือ manual acceptance test
- English README (`README.md`) และ Thai translation (`README.th.md`)
- npm package `p2pgate@1.4.0`
- Self-test เพิ่ม coverage สำหรับ control plane, revoke/unlock, doctor
  และ trusted expiry

### Changed

- Server แสดงจำนวนอุปกรณ์จาก registry แทนจำนวนคีย์ใน config
- `server.close()` ปิดและลบ control socket
- `npm run check` ตรวจ `src/control.js` และ `src/doctor.js`
- README อัปเดต v1.4 และเพิ่มหัวข้อ control plane / doctor
- แก้ self-test ให้ทำงานได้ทั้ง terminal แบบ interactive และ non-interactive
- จัดระเบียบ spec ไว้ใน `docs/specs/` และแปลง Phase 4 จาก `.docx` เป็น Markdown
- แก้ `bin` path และคำอธิบายแพ็กเกจให้พร้อมสำหรับ npm

### Security

- PIN ถูกอ่านจากหน่วยความจำและส่งผ่าน local socket เท่านั้น
- `revoke` ปิด stream ที่ใช้งานอยู่ทันทีและบันทึกการระงับถาวร
- control socket ถูกสร้างด้วย umask `0177` และ `chmod 0600` บน POSIX
- `doctor` ไม่พิมพ์ master secret, PIN หรือ verifier

## [1.3.0]

### Added

- `verificationMode`: `hybrid`, `key-only`, `two-step`
- Dual-source device registry: `allowedClientKeys` + `trusted_devices`
- `trusted` / `scram` profiles, `expires=`, labels และ comments
- POSIX permission check และ live reload ของ `trusted_devices`
- Status frames v3: `DECLINED`, `FASTPATH_READY`, `CHALLENGE_REQUIRED`, `READY`
- Client deferred input: อ่าน PIN เฉพาะเมื่อต้อง two-step
- CLI: `devices list`, `devices add`, `devices remove`
- Setup wizard เลือก verification mode

### Changed

- Client เชื่อมต่อก่อนแล้วรอสถานะจาก Server
- `--pin-stdin` ไม่บล็อก fast-path/key-only
- README และ self-test อัปเดตสำหรับ v1.3

## [1.2.0]

### Added

- Mutual SCRAM verification พร้อม server signature
- Session PIN 10 ตัวอักษร Base32
- Async `crypto.scrypt` และ SCRAM verifier storage
- Progressive lockout: 3/15 นาที, 6/6 ชั่วโมง, 10/ถาวร
- `p2pgate unlock` แบบ live
- Serialized PIN refresh

### Changed

- แทนที่ HMAC challenge-response แบบเดิมด้วย SCRAM
- README และ self-test อัปเดตสำหรับ v1.2

## [1.1.0]

### Added

- Session PIN และ Unattended Password
- Challenge-response ก่อน pipe ไปยัง target
- Telegram alerts สำหรับความพยายามเชื่อมต่อที่ไม่ได้รับอนุญาต
- Lockout 3 ครั้ง / 15 นาที
- Hidden input และ `P2PGATE_PIN`

## [1.0.0]

### Added

- อุโมงค์ TCP แบบ P2P ผ่าน HyperDHT
- Hourly rolling server keys จาก `masterSecret`
- Protocol-level `allowedClientKeys` firewall
- Localhost-only binding
- CLI และ interactive setup wizard
- Termux:Boot script
- Self-test ชุดแรก
