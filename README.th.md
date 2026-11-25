# p2pgate (v1.13)

[English](README.md) | **ไทย**

[![npm version](https://img.shields.io/npm/v/p2pgate.svg)](https://www.npmjs.com/package/p2pgate)
[![license](https://img.shields.io/npm/l/p2pgate.svg)](LICENSE)
[![Node.js](https://img.shields.io/node/v/p2pgate.svg)](package.json)
[![Socket](https://badge.socket.dev/npm/package/p2pgate?v=1.13.8)](https://socket.dev/npm/package/p2pgate)

อุโมงค์ TCP แบบ P2P ขนาดเล็ก สำหรับเข้าถึง SSH และ service อื่น ๆ บนเครื่องที่อยู่หลัง
CGNAT/ไฟร์วอลล์ โดยไม่ต้องเปิดพอร์ตออกสู่อินเทอร์เน็ต พร้อม **Mutual SCRAM**,
**Verification Policy Modes**, **Dual-Source Device Registry**, **Local Control Plane**,
**Multi-target routing** และ **SOCKS5 gateway** (ไม่บังคับ)

ใช้ได้กับ Termux/Android, Linux, macOS และ Windows ที่มี Node.js 20 ขึ้นไป

> เวอร์ชัน 1.13 ทำให้ **trusted device ใช้ `--mux` ได้**: server ประกาศ mux ใน
> `FASTPATH_READY` และรอ upgrade จาก client ไม่เกิน 200 ms — fast path จึงไม่ต้อง
> fallback เป็น 1 stream ต่อ connection อีก
> เวอร์ชัน 1.12 เพิ่ม stream multiplexing (`--mux`, 128 channels ต่อ carrier),
> 1.11 ping/traffic, 1.10 UDP, 1.9 config validation + SOCKS ต่อ client,
> 1.8 SOCKS5, 1.7 multi-target, 1.6 zero-setup
>
> **ติดตั้ง:** `npm install -g p2pgate`
>
> คู่มือทดสอบก่อนใช้งานจริง: [`TESTING.md`](TESTING.md)
>
> การรันเป็น service (Termux / systemd / Windows): [`docs/SERVICE.md`](https://github.com/incognitums/p2pgate/blob/main/docs/SERVICE.md)

## เริ่มใช้งานเร็ว (ไม่ต้อง setup)

เครื่อง Server ครั้งแรก:

```sh
p2pgate server
```

ระบบจะสร้าง `~/.p2pgate/config.json`, generate `masterSecret` และ
connection password ให้ แล้วเริ่มทำงานทันที — คัดลอกค่าที่แสดงไว้

เครื่อง Client เครื่องไหนก็ได้:

```sh
p2pgate connect -s <masterSecret> -p <password>
# หรือแบบถาม:
p2pgate connect
```

Client key ถูกสร้างอัตโนมัติ จากนั้นเปิด terminal ใหม่:

```sh
ssh -p 8022 localhost
```

ถ้าต้องการตั้งค่า advanced ใช้ `p2pgate setup`

---

## p2pgate ทำอะไร

```text
[PC / Mac / มือถือ]
ssh -p 8022 localhost
        │
        ▼
  p2pgate client  ──── HyperDHT (UDP + เข้ารหัส + hole punching) ────►  p2pgate server
  (ผูก 127.0.0.1 เท่านั้น)                                              (Termux บนมือถือ)
                                                                              │
                                                                              │ 1) registry/policy
                                                                              │ 2) fast-path หรือ SCRAM
                                                                              │ 3) ตรวจ serverSig
                                                                              ▼
                                                                       127.0.0.1:8022
                                                                           sshd
```

- ไม่เปิดพอร์ต SSH สู่อินเทอร์เน็ต
- Client เปิดเฉพาะ `127.0.0.1`
- Server ตรวจ Public Key จาก **สองแหล่ง**: `config.json` และ `trusted_devices`
- **hybrid:** อุปกรณ์ `trusted` ใช้ fast-path, อุปกรณ์อื่นใช้ two-step
- **key-only:** ใช้ Public Key เท่านั้น ไม่ถาม PIN
- **two-step:** ถาม PIN/รหัสผ่านทุกครั้ง แม้อุปกรณ์จะถูกทำเครื่องหมาย trusted
- Client เชื่อมต่อก่อน แล้วจึงถาม PIN เฉพาะเมื่อ Server ต้องใช้ two-step
- Control socket ภายในเครื่องสำหรับ `status`, `pin`, `revoke` โดยไม่ต้องรีสตาร์ต
- `p2pgate doctor` ตรวจสุขภาพการติดตั้งและแนะนำวิธีแก้เป็นภาษาไทย
- trusted devices ต้องมีวันหมดอายุหรือระบุ `--permanent` อย่างชัดเจน
- Lockout แบบก้าวหน้า 3/15 นาที, 6/6 ชั่วโมง, 10/ถาวร
- ปลดล็อกได้ทันทีด้วย `p2pgate unlock`
- **Audit log แบบ JSONL** สำหรับ auth/control/device events โดยไม่บันทึก secrets
- **Client key ที่ป้องกันด้วย passphrase** (scrypt + AES-256-GCM)
- **`status --json` / `doctor --json`** สำหรับ automation
- **Control token ต่อเซิร์ฟเวอร์** สำหรับ local control plane
- ใช้ dependency ภายนอกเพียงตัวเดียว: `hyperdht`

---

## 1) Verification Modes

ตั้งค่าใน `config.json`:

```json
"verificationMode": "hybrid"
```

| โหมด | ค่าเริ่มต้น | พฤติกรรม |
|---|---|---|
| `hybrid` | ใช่ | อุปกรณ์ `trusted` ใช้ fast-path; อุปกรณ์ `scram` ใช้ two-step |
| `key-only` | ไม่ | ตรวจเฉพาะ Public Key; ไม่มี Session PIN และไม่ถาม PIN |
| `two-step` | ไม่ | ต้องยืนยันทั้ง Public Key และ PIN/รหัสผ่านทุกครั้ง |

### hybrid

- อุปกรณ์ที่ลงทะเบียนใน `trusted_devices` ด้วย `trusted` และยังไม่หมดอายุ
  จะเริ่ม session ได้ทันทีหลังตรวจ Public Key
- อุปกรณ์ที่มาจาก `config.json` หรือโปรไฟล์ `scram` ต้องยืนยันแบบ two-step
- ถ้า Server รันแบบไม่มี terminal และไม่มี Unattended Password
  อุปกรณ์ที่ต้อง two-step จะถูกปฏิเสธ
  แต่ trusted devices ยังใช้ fast-path ได้

### key-only

- เหมาะกับ automated workflow หรือ Server ที่รันเบื้องหลัง
- ทุกคีย์ที่ลงทะเบียนและยังไม่หมดอายุใช้ fast-path
- **ไม่สร้าง Session PIN** และไม่ถาม PIN
- ต้องป้องกันไฟล์กุญแจ Client เป็นพิเศษ เพราะไม่มี PIN เป็นด่านที่สอง

### two-step

- ต้องยืนยันทั้ง Public Key และ PIN/รหัสผ่านทุกครั้ง
- โปรไฟล์ `trusted` ใน `trusted_devices` จะไม่ถูกใช้เป็น fast-path
- เหมาะกับเครื่องที่ต้องการความเข้มงวดสูงสุด

> ค่าเริ่มต้นของ config v1.2 ที่ไม่มี `verificationMode` คือ `hybrid`
> ถ้า config เดิมมี `authPin.enabled: false` จะถูกตีความเป็น `key-only`

### Authentication Modes

`authMode` กำหนดว่าต้องลงทะเบียน client key ก่อนหรือไม่:

| โหมด | พฤติกรรม |
|---|---|
| `password` | รับ client key ที่ไม่รู้จักได้ ถ้าใส่ connection password ถูก; trusted device ที่ลงทะเบียนยังใช้ fast-path ได้ |
| `registry` | ต้องมี key ใน `allowedClientKeys` หรือ `trusted_devices` ก่อน |

`p2pgate server` ครั้งแรกจะสร้าง `authMode: password`
ส่วน `p2pgate setup` แบบ advanced จะใช้ `registry`

```json
"authMode": "password"
```

connection password เก็บเฉพาะ SCRAM verifier ใน `authPin.unattended`
เปลี่ยนรหัสด้วย:

```sh
p2pgate password reset
```

> password mode สะดวกแต่ปลอดภัยน้อยกว่า registry
> ควรใช้ password ยาวและลงทะเบียน trusted device สำหรับ fast-path

---

## 2) Dual-Source Device Registry

Server รวมรายการอุปกรณ์จาก:

1. `allowedClientKeys` ใน `config.json` (โปรไฟล์ `scram` โดยปริยาย)
2. ไฟล์ `trusted_devices` (ค่าเริ่มต้น `~/.p2pgate/trusted_devices`)

กำหนด path ได้ใน `config.json`:

```json
"trustedDevicesFile": "~/.p2pgate/trusted_devices"
```

### รูปแบบไฟล์

```text
# บรรทัดว่างและบรรทัดที่เริ่มด้วย # จะถูกข้าม
trusted <64-char-hex-public-key> primary-workstation
trusted,expires=2026-12-31T23:59:59Z <64-char-hex-public-key> contractor-laptop
scram <64-char-hex-public-key> shared-terminal
<64-char-hex-public-key> legacy-default-two-step-client
```

- บรรทัดที่ไม่มี option = โปรไฟล์ `scram`
- `trusted` = fast-path ภายใต้ `hybrid` (และทุกคีย์ภายใต้ `key-only`)
- `scram` = two-step
- `expires=` ต้องเป็น ISO-8601 และมี timezone เช่น `...Z`
- ป้ายชื่อ (label) เป็นข้อความที่เหลือบนบรรทัด

### Precedence

- คีย์ที่มีเฉพาะใน `config.json` → โปรไฟล์ `scram`
- คีย์ที่มีเฉพาะใน `trusted_devices` → ใช้โปรไฟล์/วันหมดอายุที่ระบุ
- คีย์ที่มีทั้งสองที่และรายการในไฟล์ยัง active → `trusted_devices` ชนะ
- คีย์ที่มีในไฟล์แต่ **หมดอายุ** → ถูกปฏิเสธ แม้จะยังอยู่ใน `config.json`

### สิทธิ์ไฟล์ (POSIX)

ก่อนใช้ fast-path ระบบตรวจว่าไฟล์ `trusted_devices`:

- เป็นไฟล์ปกติ ไม่ใช่ symlink
- เจ้าของคือผู้ใช้ปัจจุบัน
- ไม่มีสิทธิ์สำหรับ group/other (`chmod 600` หรือเข้มกว่า)

ถ้าสิทธิ์ไม่ปลอดภัย:

- `hybrid`: รายการ `trusted` จะไม่ใช้ fast-path (ต้อง two-step)
- `key-only`: รายการที่มาจากไฟล์จะถูกปฏิเสธ
- `two-step`: ยังต้อง two-step ตามปกติ

### Live Reload

Server ติดตาม `mtimeMs` ของ `trusted_devices`
และโหลดใหม่เมื่อไฟล์เปลี่ยน โดยไม่ต้องรีสตาร์ต
แนะนำให้แก้ผ่าน `p2pgate devices add/remove` ซึ่งเขียนแบบ atomic

---

## 3) การเชื่อมต่อแบบใหม่ (Deferred Input)

Client จะ **เชื่อมต่อก่อน** แล้วรอสถานะจาก Server:

| สถานะ | ความหมาย | การทำงานของ Client |
|---|---|---|
| `FASTPATH_READY` | อุปกรณ์ใช้ fast-path | ไม่ถาม PIN, เริ่มส่งข้อมูลทันที |
| `CHALLENGE_REQUIRED` | ต้องยืนยัน two-step | อ่าน PIN/รหัสผ่าน แล้วทำ SCRAM |
| `DECLINED` | ไม่ได้รับอนุญาต/หมดอายุ/ถูกระงับ | แสดงเหตุผลและปิด connection |

- Client ไม่ถาม PIN ก่อนเชื่อมต่ออีกต่อไป
- ถ้าเป็น fast-path หรือ key-only จะไม่มีการถาม PIN เลย
- `--pin-stdin` จะอ่าน stdin **เฉพาะเมื่อถูกถาม** (ไม่บล็อก fast-path)
- `P2PGATE_PIN` ถูกลบออกจาก process ทันทีหลังอ่านตอนเริ่ม Client

หลังได้สถานะ `CHALLENGE_REQUIRED` Client จะส่ง `READY`
แล้ว Server จึงส่ง SCRAM challenge และเริ่มจับเวลา 10 วินาที

---

## 4) Session PIN และ Unattended Password

### Session PIN

- 10 ตัวอักษร Base32: `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`
- แสดงเป็น `XXXXX-XXXXX` ในกรอบ ASCII บน console แบบ interactive
- เก็บในหน่วยความจำเท่านั้น ไม่เขียนลง config/log/ไฟล์
- เปลี่ยนใหม่เมื่อมีผู้ใส่ผิดครบ 3 หรือ 6 ครั้ง (salt ใหม่ทุกครั้ง)
- **key-only ไม่สร้าง Session PIN**
- Server ที่รันแบบ headless จะไม่แสดง PIN
  ให้ใช้ fast-path, key-only หรือ Unattended Password

### Unattended Password

- ยาวอย่างน้อย 12 ตัวอักษร
- ตัวพิมพ์เล็ก-ใหญ่มีความหมาย
- ใช้ได้ใน `hybrid`/`two-step` แม้ Server ไม่มี terminal
- เก็บเฉพาะ SCRAM verifier (`saltHex`, `storedKeyHex`, `serverKeyHex`)
- ตั้งค่าผ่าน `p2pgate setup`

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

ถ้าไม่มีจะเป็น `"unattended": null`

---

## 5) การกรอก Credential ฝั่ง Client

ลำดับความสำคัญ:

1. `--pin-stdin` — อ่านหนึ่งบรรทัดจาก stdin เมื่อ Server ต้องใช้ two-step
2. `P2PGATE_PIN` — environment variable (ลบออกจาก process ทันที)
3. Hidden prompt — ค่าเริ่มต้น

> p2pgate ไม่มี flag `--pin` เพื่อไม่ให้รหัสผ่านปรากฏใน `ps` หรือ shell history
>
> หลีกเลี่ยง `P2PGATE_PIN=... p2pgate client` แบบ inline
> ใช้ hidden prompt หรือ `--pin-stdin` จากไฟล์ที่ปลอดภัย

ตัวอย่างบน Termux/Linux:

```sh
install -m 600 /dev/null ~/.p2pgate/pin.txt
nano ~/.p2pgate/pin.txt
p2pgate client --pin-stdin < ~/.p2pgate/pin.txt
```

บน Windows PowerShell:

```powershell
Get-Content .\pin.txt | p2pgate client --pin-stdin
```

ตัวอย่าง environment variable:

```sh
export P2PGATE_PIN='...'
p2pgate client
unset P2PGATE_PIN
```

### Passphrase ของ Client Key

ป้องกัน client key ด้วย passphrase ได้ โดย seed จะถูกเข้ารหัสด้วย
scrypt + AES-256-GCM และ public key ยังอ่านได้สำหรับ diagnostics

```sh
p2pgate keygen --passphrase
```

แบบไม่ interactive:

```sh
printf '%s\n' 'your-long-passphrase' | p2pgate keygen --config ~/.p2pgate/config.json --passphrase-stdin
```

ตอนเริ่ม Client:

```sh
p2pgate client --key-passphrase-stdin < ~/.p2pgate/key-passphrase.txt
```

หรือ:

```sh
export P2PGATE_KEY_PASSPHRASE='...'
p2pgate client
unset P2PGATE_KEY_PASSPHRASE
```

- passphrase ต้องยาวอย่างน้อย 12 ตัวอักษร
- ไม่มี argument `--passphrase <value>`
- `--key-passphrase-stdin` ใช้ร่วมกับ `--pin-stdin` ไม่ได้
- client key แบบ plaintext เดิมยังใช้ได้; `doctor` จะแนะนำให้เพิ่ม passphrase
- ถอดการป้องกัน:

```sh
p2pgate keygen --unprotect
```

---

## 6) Progressive Lockout และ `unlock`

นับตาม Public Key ภายใน 24 ชั่วโมง:

| ผิด | ผล |
|---|---|
| 3 ครั้ง | ระงับ 15 นาที + เปลี่ยน Session PIN |
| 6 ครั้ง | ระงับ 6 ชั่วโมง + เปลี่ยน Session PIN |
| 10 ครั้ง | ระงับถาวร |

- invalid response ถูกหน่วง 2.5–3.5 วินาที
- จำกัด concurrent verification 1 ต่อคีย์ และ 3 ทั้งระบบ
- สถานะเก็บที่ `~/.p2pgate/lockout-state.json` สิทธิ์ `0600`
- ใช้ lockfile + atomic rename + mtime reload
- `p2pgate unlock` มีผลกับ Server ที่รันอยู่ทันที

```sh
p2pgate unlock --list
p2pgate unlock <clientPublicKeyHex>
p2pgate unlock --all
```

---

## 7) CLI สำหรับจัดการอุปกรณ์

```sh
p2pgate devices list
p2pgate devices add <publicKeyHex> --mode trusted \
  --expires 2026-12-31T23:59:59Z --comment "contractor"
p2pgate devices add <publicKeyHex> --mode trusted --permanent
p2pgate devices add <publicKeyHex> --mode scram --comment "shared-terminal"
p2pgate devices remove <publicKeyHex>
```

- `list` แสดงคีย์ทั้งหมดที่ merge แล้ว: แหล่งที่มา, โปรไฟล์, วันหมดอายุ, ป้ายชื่อ
- `add`/`remove` เขียน `trusted_devices` แบบ atomic
- `--mode` ค่าเริ่มต้นคือ `scram`; ใช้ `--mode trusted` สำหรับ fast-path
- `--expires` ต้องเป็น ISO-8601 พร้อม timezone
- **`--mode trusted` ต้องระบุ `--expires` หรือ `--permanent` เท่านั้น**
  - ถ้าไม่ระบุ ระบบจะปฏิเสธและอธิบายเป็นภาษาไทย
  - ถ้าระบุทั้งสองอย่าง ระบบจะปฏิเสธ
  - `--permanent` ใช้ได้เฉพาะกับ trusted
- ระบบจะเตือนว่า trusted device ข้ามการถาม PIN
- `remove` จะเตือนถ้าคีย์นั้นยังอยู่ใน `allowedClientKeys` ของ `config.json`
- ใช้ `--config <path>` เพื่อระบุ config

ตัวอย่างผลลัพธ์ `devices list`:

```text
- aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  แหล่งที่มา: config.json (allowedClientKeys)
  โปรไฟล์: scram
  หมดอายุ: -
  ป้ายชื่อ: -
  สถานะ: ใช้งาน
  Fast-path: ไม่ใช่
  Lockout: ปกติ
  ล้มเหลวใน 24 ชม.: 0 ครั้ง
```

---

## 8) Local Control Plane (`status` / `pin` / `revoke`)

Server v1.5 เปิด **local control socket** สำหรับจัดการเซิร์ฟเวอร์ที่กำลังรันอยู่
โดยไม่ต้องรีสตาร์ตและไม่ต้องเปิดพอร์ต TCP เพิ่ม

### ตำแหน่ง socket

| ระบบ | ตำแหน่ง |
|---|---|
| Linux / macOS / Termux | `~/.p2pgate/control.sock` (สิทธิ์ `0600`, โฟลเดอร์ `0700`) |
| Windows | named pipe `\\.\pipe\p2pgate-control-<hash>` |

- ใช้ได้เฉพาะผู้ใช้เดียวกันบนเครื่องเดียวกัน
- socket ถูกลบเมื่อเซิร์ฟเวอร์ปิดอย่างถูกต้อง
- ถ้า socket ค้างจาก process ที่ตายไปแล้ว ระบบจะ probe ก่อนและลบทิ้ง
- ถ้ามีเซิร์ฟเวอร์อื่นใช้ socket อยู่ จะเริ่มไม่ได้และแจ้ง `CONTROL_IN_USE`
- ทุก request ต้องมี **control token** ของเซิร์ฟเวอร์ เก็บที่
  `~/.p2pgate/control.token` สิทธิ์ `0600` และจะไม่ถูกพิมพ์ออกมา
- POSIX ตรวจ owner และสิทธิ์ `0600` ของ socket
- Windows ใช้ token ช่วย authenticate เสริม named-pipe DACL

### คำสั่ง

```sh
p2pgate status
p2pgate status --json
p2pgate pin
p2pgate revoke <clientPublicKeyHex>
```

#### `p2pgate status`

แสดงข้อมูลที่ไม่มี secrets:

- โหมดยืนยันตัวตน
- สถานะว่ามี Session PIN หรือไม่ (ไม่แสดง PIN)
- slot ปัจจุบันและ slots ที่เปิดอยู่
- จำนวนอุปกรณ์ลงทะเบียน
- จำนวน connection และคีย์ที่เชื่อมต่อ
- จำนวนที่ถูกบล็อกสะสม
- uptime, ไฟล์ trusted_devices, control socket path

ใช้ `--json` สำหรับ automation:

```sh
p2pgate status --json
```

ผลลัพธ์เป็น JSON object เดียว โดย `"ok": true` เมื่อสำเร็จ
และ `"ok": false` พร้อม `error` เมื่อล้มเหลว (exit code 1)

#### `p2pgate pin`

ขอ Session PIN ปัจจุบันจากหน่วยความจำของเซิร์ฟเวอร์ผ่าน control socket:

```text
=== Session PIN ปัจจุบัน ===
   ABCDE-FGHJK
   generation: 1
```

- PIN ไม่ถูกเขียนลงดิสก์หรือ log
- โหมด `key-only` จะตอบ `NO_SESSION_PIN`
- ถ้าเซิร์ฟเวอร์ไม่ได้รันอยู่ จะแจ้งให้เริ่ม `p2pgate server`

#### `p2pgate revoke <key>`

- เพิกถอนคีย์แบบถาวร (`reason: manual`)
- ตัด connection ที่เปิดอยู่ของคีย์นั้นทันที
- การเชื่อมต่อครั้งถัดไปจะถูกปฏิเสธ
- ถ้าเซิร์ฟเวอร์ไม่ได้รันอยู่ คำสั่งจะบันทึกการเพิกถอนลง lockout state โดยตรง
  และมีผลเมื่อเซิร์ฟเวอร์เริ่มทำงาน/อ่าน state ใหม่

คืนสิทธิ์ด้วย:

```sh
p2pgate unlock <clientPublicKeyHex>
```

> `revoke` เป็นการตัดที่ระดับ p2pgate
> SSH session ที่ถูก pipe ผ่านอุโมงค์จะถูกปิดตาม stream
> แต่ควรตรวจสอบฝั่ง sshd เพิ่มเติมหากต้องการตัด session ระดับ OS

---

## 9) `p2pgate doctor`

คำสั่งตรวจสุขภาพแบบอ่านอย่างเดียว (read-only) แสดงผลภาษาไทยด้วย
`✅` / `⚠️` / `❌`

```sh
p2pgate doctor
p2pgate doctor --config /path/to/config.json
p2pgate doctor --json
```

ตรวจสอบ:

1. เวอร์ชัน Node.js (ต้อง >= 20)
2. ไฟล์ config อ่านและ validate ได้
3. `verificationMode` และฟิลด์ที่เกี่ยวข้อง
4. สิทธิ์ไฟล์ config, client key, trusted_devices, lockout state, audit log
   - บน Windows จะแจ้งว่าไม่ได้ตรวจ POSIX permission
5. Device registry: จำนวนอุปกรณ์, อุปกรณ์หมดอายุ,
   trusted ที่ไม่มีวันหมดอายุ, สิทธิ์ไฟล์, registry ว่าง
6. ปลายทาง: Server ตรวจว่า `127.0.0.1:<targetPort>` มี sshd ฟังอยู่หรือไม่
   Client ตรวจว่าพอร์ตท้องถิ่นว่างหรือไม่
7. Control plane: ถ้าเซิร์ฟเวอร์รันอยู่จะ query `status` ด้วย token
8. Lockout state และขนาด/สิทธิ์ audit log
9. คำเตือนเรื่องการมองเห็น Session PIN ในโหมดไม่มี terminal
10. กุญแจ Client ว่ามี ถูกต้อง และป้องกันด้วย passphrase หรือไม่

- exit code `0` เมื่อไม่มี `❌`
- exit code `1` เมื่อมีปัญหาวิกฤต
- ไม่พิมพ์ `masterSecret`, seed, verifier หรือ PIN

`--json` คืนผลแบบ machine-readable:

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

## 9.1) Audit Log

Server และ CLI เขียนเหตุการณ์ด้านความปลอดภัยลงไฟล์ JSONL ภายในเครื่อง:

```json
{"ts":"2026-11-15T10:00:00.000Z","event":"auth.success","source":"server","key":"<hex>","mode":"pin"}
```

ค่าเริ่มต้น:

```json
"auditLog": {
  "enabled": true,
  "path": "~/.p2pgate/audit.log",
  "maxBytes": 5242880
}
```

- ไฟล์สิทธิ์ `0600` โฟลเดอร์ `0700`
- หมุนไฟล์เก่าเป็น `audit.log.1` เมื่อเกิน `maxBytes`
- events: `server.start`, `auth.success`, `auth.failure`, `auth.declined`,
  `auth.fastpath`, `control.revoke`, `session.pin.rotate`, `device.add`,
  `device.remove`, `device.revoke`, `device.unlock`, `device.unlock_all`
- ไม่บันทึก PIN, รหัสผ่าน, passphrase, master secret, seed, verifier
  หรือ control token
- ถ้าเขียน audit ไม่ได้ จะ log ไว้แต่ไม่บล็อกการยืนยันตัวตน
- ปิดได้ด้วย `"auditLog": { "enabled": false }`

---

## 9.2) Multi-target routing

ประกาศ service หลายตัวบน Server แล้วให้ Client เลือกเป็นชื่อ ไม่ต้องใช้
`ssh -L` และไม่ต้องมี `sshd` สำหรับ service ที่ไม่มี shell

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
# 127.0.0.1:8080 ฝั่ง client  ->  127.0.0.1:8080 ฝั่ง server
```

กติกา:

- client ส่งได้เฉพาะ **ชื่อ target** ไม่ใช่ `host:port`
- `host` ต้องเป็น `127.0.0.1` (p2pgate ไม่ forward ออกนอกเครื่อง)
- `allow` ไม่บังคับ; `"*"` = client ที่ผ่าน auth ทุกตัว
- config ที่ไม่มี `targets` ทำงานเหมือน v1.6 ทุกประการ
- client ที่ไม่ระบุ `--target` ใช้ `defaultTarget`
- trusted (fast-path) device ใช้ `--target` ได้ตั้งแต่ 1.13.3; client ใหม่กว่าบน
  server เก่าจะได้ `TARGET_UNSUPPORTED` แทนการเงียบ ๆ ไปใช้ default
- target ที่ไม่รู้จัก/ไม่อยู่ใน allowlist ถูกปฏิเสธโดยไม่แตะ service

---

## 9.3) SOCKS5 gateway (ไม่บังคับ)

config ฝั่ง Server:

```json
"socks": {
  "enabled": true,
  "allow": ["192.168.1.0/24:8080", "127.0.0.1:3000", "10.0.0.0/8:*"]
}
```

ฝั่ง Client:

```sh
p2pgate connect -s <secret> -p <password> --socks5 1080
```

แล้วตั้ง browser/app ให้ใช้ `SOCKS5 127.0.0.1:1080`

กติกา:

- ปิดไว้โดยค่าเริ่มต้น; `socks.enabled` ต้องมี allow อย่างน้อย 1 รายการ
- entry เป็น IPv4/CIDR + port (`*` = ทุกพอร์ต)
- client ส่งปลายทางมา, server resolve เอง แล้วตรวจ **ทุก IP ที่ resolve ได้**
  กับ allowlist → DNS rebinding หลุดไม่ได้
- รองรับเฉพาะ TCP `CONNECT`; `UDP ASSOCIATE` และ `BIND` ถูกปฏิเสธ
- ปลายทาง IPv6 ถูกปฏิเสธใน v1.8
- ปลายทางที่ไม่อยู่ใน allowlist จะได้ reply "not allowed" และ log `SOCKS DENIED`
- ใช้ `--socks5` ร่วมกับ `--target` ไม่ได้

ตัวอย่างสำหรับ LAN ในบ้าน:

```json
"socks": { "enabled": true, "allow": ["192.168.1.0/24:*"] }
```

กำหนดต่อ client (ไม่บังคับ) — รายการนี้ **แทนที่** รายการกลางสำหรับ key นั้น:

```json
"socks": {
  "enabled": true,
  "allow": ["192.168.1.0/24:8080"],
  "perClient": {
    "<clientPublicKeyHex>": ["10.0.0.0/8:443"]
  }
}
```

> การเปิด SOCKS ทำให้ Server เป็น gateway ไปยังปลายทางที่คุณระบุ
> ควรจำกัด allowlist ให้แคบ — `0.0.0.0/0` เท่ากับ proxy ทั้งอินเทอร์เน็ต

---

## 9.4) การหมุน masterSecret

`masterSecret` ใช้สร้าง DHT identity ของ Server เมื่อหมุนแล้ว public key จะเปลี่ยน
ทำให้ client ทุกเครื่องต้องอัปเดตตาม

```sh
# Server
p2pgate master show            # ดู fingerprint (--reveal = ค่าเต็ม)
p2pgate master reset --yes     # สำรอง config แล้วเขียนค่าใหม่ จากนั้นรีสตาร์ต

# Client ทุกเครื่อง
p2pgate connect -s <masterSecret ใหม่> -p <password>
```

- `p2pgate master reset --dry-run` ดูว่าจะเปลี่ยนอะไรโดยไม่เขียนไฟล์
- `--no-backup` ข้ามการสำรอง (ใช้ในเหตุฉุกเฉิน: ไม่เก็บค่าเก่าที่รั่วแล้วบนดิสก์)
- config เดิมถูกคัดลอกเป็น `config.json.bak-<timestamp>` (โหมด `0600`)
- บันทึก audit event `master.reset`
- **ไม่กระทบ** connection password และ trusted device keys
- ถ้าไม่ใส่ `--yes` จะถามยืนยัน；ใน non-interactive shell ต้องใส่ `--yes`

---

## 9.5) ตรวจ config ก่อนรัน

```sh
p2pgate config validate        # exit 1 ถ้าไฟล์หายหรือไม่ถูกต้อง
p2pgate config show            # config ที่ normalize แล้ว โดยปิด secret
p2pgate config show --json
```

`config validate` ใช้ normalizer ตัวเดียวกับ daemon — ผ่านที่นี่คือผ่านตอน start
`config show` แสดงค่าที่ daemon เห็นจริง โดยปิด `masterSecret`, SCRAM verifier
และ Telegram token

คำสั่งฝั่ง client (`ping`, `client`, `udp`, `config`, `doctor`, `master`,
`keygen`) ใช้ `config.json` ถ้ามี ไม่งั้น fallback ไป `client.json` อัตโนมัติ
ถ้าระบุ `--config` จะใช้ค่านั้นเสมอ

`p2pgate doctor` เพิ่มการตรวจ:

- fingerprint ของ `masterSecret` + เตือนถ้า config ไม่ถูกแก้มา 180 วัน
- probe ทุก `targets.<name>` บน `127.0.0.1` และเตือนถ้าพอร์ตไม่ตอบ
- เตือนถ้า SOCKS allowlist เป็น `0.0.0.0/0` (เท่ากับ open proxy)

---

## 9.6) UDP targets

UDP จะทำงานเมื่อประกาศ target เท่านั้น datagram ถูกห่อใน tunnel ที่ authenticate แล้ว
(`[len:uint16][payload]` สูงสุด 1200 ไบต์)

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
# หรือเก็บใน client.json: "udpTarget": "dns", "udpListen": 5353
```

กติกา:

- client ส่งเป็น **ชื่อ** target; `host` ต้องเป็น `127.0.0.1`
- 1 stream ต่อ endpoint ของ client และปิดเมื่อ idle 60 วิ
- reply วิ่งกลับทาง stream เดิมเท่านั้น (ใช้เป็น reflector ไม่ได้)
- datagram เกิน 1200 ไบต์ถูก drop ทั้งสองฝั่ง
- รองรับ IPv4 เท่านั้น; ยังไม่รองรับผ่าน SOCKS5

---

## 9.7) Ping และ traffic counters

```sh
p2pgate ping                 # 3 pings: slot ปัจจุบัน แล้ว slot ก่อนหน้า
p2pgate ping --count 5 --json
```

```text
slot 498558  serverKey 1f0ea5c2…
   connect 170/1092/2013 ms   auth 24/31/38 ms   (2 attempts)
```

- `connect` = เวลาเปิด DHT stream, `auth` = เวลา SCRAM handshake
- `--count N` ทำ handshake ซ้ำ N ครั้ง แล้วรายงาน min/avg/max
- ใช้ได้กับ fastpath, key-only และ challenge
- ไม่เปิด listener และไม่ทิ้งพอร์ตค้าง
- exit code `1` เมื่อไม่พบ Server

`p2pgate status` รายงาน traffic ในหน่วยความจำ:

```text
Traffic รวม: in 1.2 KiB / out 8.4 MiB
Stream ที่ใช้งาน: 2
  - ssh (tcp) peer=3d8f1df0… in 512 B out 8.4 MiB
```

`p2pgate status --watch` รีเฟรชทุก 1 วินาที (Ctrl+C เพื่อหยุด)
ตัวนับรีเซ็ตเมื่อรีสตาร์ต และไม่เขียนลงดิสก์

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

- เก็บใน `~/.p2pgate/hosts.json` (โหมด `0600`)
- ไฟล์มีค่า `masterSecret` — เก็บเป็นความลับ
- `ping --all` แสดงทีละ host พร้อมเวลา connect/auth หรือ error

## 9.9) Audit viewer

```sh
p2pgate audit --tail 20
p2pgate audit --failures --since 24h
p2pgate audit --json
```

- อ่านจากท้ายไฟล์ `audit.log` (ไม่โหลดทั้งไฟล์)
- `--failures` แสดงเฉพาะ failure/declined/revoke/lockout/timeout
- audit writer ตัด secret ออกอยู่แล้ว

## 9.10) Self-stopping server

```sh
p2pgate server --ttl 30m     # ปิดเมื่อครบ 30 นาที
p2pgate server --idle 15m    # ปิดเมื่อไม่มี connection 15 นาที
p2pgate server --once        # ปิดเมื่อ session แรกจบ
```

ตอนปิดจะหยุดรับ connection ใหม่ และรอ session ที่ค้างไม่เกิน 60 วินาที
timer อยู่ในหน่วยความจำเท่านั้น

---

## 9.11) Multiplexing (`--mux`)

```sh
p2pgate connect -s <secret> -p <password> --socks5 1080
p2pgate client --config client.json --mux
```

- `--socks5` ใช้ mux เป็นค่าเริ่มต้นตั้งแต่ 1.13.1; tunnel ปกติยังเป็น opt-in
- `--no-mux` (หรือ `"mux": false` ใน `client.json`) ปิด mux
- carrier เดียว authenticate ครั้งเดียว, สูงสุด **128 channels**
- 1 channel = 1 target หรือ 1 SOCKS destination
- frame 16 KiB, window 256 KiB ต่อทิศ, queue cap 64 KiB
- carrier idle 5 นาที, keepalive ทุก 30 วินาที
- channel error คงรหัสเดิม (`TARGET_UNKNOWN`, `SOCKS_DENIED`, `MUX_BUSY`)
  และ fallback ไป dedicated stream

**trusted device:** ตั้งแต่ 1.13.0 `--mux` ใช้ได้บน fast path ด้วย — server ประกาศ
capability ใน `FASTPATH_READY`, client ขอ upgrade ทันที, server รอไม่เกิน 200 ms
ก่อน forward ไบต์ไป target ถ้า server เก่ากว่า (ไม่ประกาศ) client จะ fallback เงียบ ๆ

## 9.12) Compression (`--compress`, ไม่บังคับ)

```sh
# server
p2pgate server --compress

# client (mux หรือ tunnel ปกติ)
p2pgate connect -s <secret> -p <password> --compress
p2pgate connect -s <secret> -p <password> --compress --mux
```

- **ปิดเป็นค่าเริ่มต้น**; ต้องเปิดทั้ง server และ client
- `--no-compress` (หรือ `"compress": false` ใน config) ปิด และมีผลเหนือค่าใน config
- ใช้ zstd ถ้า Node รองรับ (>= 22.15) ไม่งั้นใช้ gzip
- รองรับทั้ง mux channel และ non-mux tunnel รวมถึง trusted device (fast path)
- `"compress": "auto"` สุ่มตัวอย่าง 32 KiB / 60 ms แล้วปิดเองถ้าข้อมูลบีบอัดไม่ได้ (mux เท่านั้น)
- มี decompression guard: output 4 GiB หรือขยายเกิน 1000x ต่อ channel
- วัดบนลิงก์ 4G: text/log 64 MiB เร็วขึ้น **2.4-2.6 เท่า**; ไฟล์ที่บีบอัดแล้ว
  (jpg/mp4/zip) ~1.0 เท่า
- ข้อมูล SSH ถูกเข้ารหัสโดย sshd อยู่แล้ว จึงไม่ช่วย — ใช้ `ssh -C` แทน

รูปแบบใน config:

```json
"compress": { "enabled": true, "algorithms": ["zstd", "gzip"] }
```

---

## 10) สิ่งที่ต้องมี

- มือถือ Android + Termux + Termux:Boot (F-Droid)
- Node.js 20 ขึ้นไป
- OpenSSH ฝั่ง Server และ `ssh` ฝั่ง Client
- อินเทอร์เน็ตที่อนุญาต UDP ขาออก

---

## 11) การติดตั้ง

### ติดตั้งจาก npm (แนะนำ)

ต้องใช้ Node.js 20 ขึ้นไป

```sh
npm install -g p2pgate
p2pgate --version
```

### ติดตั้งจาก source บน Termux

```sh
pkg update && pkg upgrade -y
pkg install nodejs openssh nano procps -y
node -v
```

คัดลอกโปรเจกต์ไปที่ `~/p2pgate` แล้ว:

```sh
cd ~/p2pgate
npm install --ignore-scripts --no-audit --no-fund
npm link --ignore-scripts
npm run check
npm run self-test
```

ถ้า native prebuild ใช้ไม่ได้:

```sh
pkg install python build-essential -y
npm install --no-audit --no-fund
```

---

## 12) ตั้งค่า SSH ให้ปลอดภัย

```sh
passwd
sshd
```

สร้าง SSH key บน Client:

```sh
ssh-keygen -t ed25519
```

นำ `id_ed25519.pub` ไปใส่ใน Termux:

```sh
mkdir -p ~/.ssh
nano ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

ปิด PasswordAuthentication:

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

## 13) ตั้งค่า Server

```sh
cd ~/p2pgate
p2pgate setup
```

เลือก `1) Server` และเลือกโหมด:

```text
1) hybrid (แนะนำ)
2) key-only
3) two-step
```

- `hybrid`: trusted devices ใช้ fast-path, อุปกรณ์อื่น two-step
- `key-only`: ไม่ถาม PIN (จะไม่ถามรหัสผ่านสำรอง)
- `two-step`: ถาม PIN/รหัสผ่านทุกครั้ง

จากนั้น:

1. วาง Public Key ของ Client
2. ตั้ง Unattended Password (ยกเว้น key-only)
3. บันทึก config
4. เพิ่ม trusted devices ถ้าต้องการ:
   ```sh
   p2pgate devices add <key> --mode trusted --expires 2027-12-31T23:59:59Z --comment "laptop"
   ```
5. เริ่ม Server:
   ```sh
   p2pgate server
   ```

ถ้ารันใน terminal และโหมดเป็น hybrid/two-step จะเห็น Session PIN ในกรอบ
ถ้ารันแบบ headless จะไม่เห็น PIN; ใช้ trusted fast-path หรือ Unattended Password

---

## 14) ตั้งค่า Client

```sh
cd p2pgate
npm install --ignore-scripts --no-audit --no-fund
npm link --ignore-scripts
p2pgate setup
```

เลือก `2) Client` วาง `masterSecret` และกำหนดพอร์ต

นำ Public Key ไปเพิ่มที่ Server:

```sh
p2pgate setup
```

หรือเพิ่มเป็น trusted device:

```sh
p2pgate devices add <key> --mode trusted --expires 2027-12-31T23:59:59Z --comment "my-pc"
```

เริ่มอุโมงค์:

```sh
p2pgate client
```

- ถ้า Server ส่ง `FASTPATH_READY` จะไม่ถาม PIN
- ถ้า Server ส่ง `CHALLENGE_REQUIRED` จะถาม PIN/รหัสผ่านในหน้าต่าง Client
- ถ้า Server ส่ง `DECLINED` จะแสดงเหตุผลและปิด

จากนั้นเปิด terminal ใหม่:

```sh
ssh -p 8022 localhost
```

---

## 15) ใช้งานประจำวัน

```sh
# Server
cd ~/p2pgate
p2pgate server

# Client
cd p2pgate
p2pgate client
ssh -p 8022 localhost
```

- trusted devices ภายใต้ hybrid ไม่ต้องกรอก PIN
- อุปกรณ์ scram ต้องกรอก PIN/รหัสผ่าน
- key-only ไม่ถาม PIN
- two-step ถามทุกครั้ง
- ถ้า PIN ถูกเปลี่ยนหรือถูกระงับ Client จะแจ้งเป็นภาษาไทย

---

## 16) Termux:Boot

```sh
mkdir -p ~/.termux/boot
cp ~/p2pgate/scripts/termux-boot.sh ~/.termux/boot/start-p2pgate.sh
chmod +x ~/.termux/boot/start-p2pgate.sh
```

- ตั้ง Battery ของ Termux เป็น Unrestricted
- เปิด Termux:Boot อย่างน้อยหนึ่งครั้ง
- รีสตาร์ตเครื่อง

โหมดที่เหมาะกับ headless:

- `key-only` — ไม่ต้องใช้ PIN
- `hybrid` + trusted devices — อุปกรณ์เหล่านั้นใช้ fast-path
- `hybrid`/`two-step` + Unattended Password — ใช้รหัสผ่านสำรอง

Session PIN ไม่ถูกเขียนลงไฟล์หรือ log ในทุกกรณี

log:

```sh
tail -f ~/.p2pgate/server.log
```

---

## 17) Telegram (ไม่บังคับ)

1. สร้างบอทกับ `@BotFather`
2. เอา Bot Token
3. ส่งข้อความหาบอทหนึ่งครั้ง
4. เอา Chat ID จาก `getUpdates`

ระบบจะแจ้งเมื่อ:

- มีคีย์ที่ไม่รู้จักพยายามเชื่อมต่อ (จำกัด 1 ครั้ง/60 วินาที/คีย์)
- ใส่ผิด 3 ครั้ง → ระงับ 15 นาที + เปลี่ยน PIN
- ใส่ผิด 6 ครั้ง → ระงับ 6 ชั่วโมง + เปลี่ยน PIN
- ใส่ผิด 10 ครั้ง → ระงับถาวร

ข้อความจะไม่มี PIN หรือรหัสผ่าน

---

## 18) ความปลอดภัย

- **`masterSecret`** ใช้สร้างคีย์ Server รายชั่วโมง
- **`allowedClientKeys` + `trusted_devices`** เป็น registry
- **`hybrid`** ให้ fast-path เฉพาะ trusted devices
- **`key-only`** ไม่มี PIN — ต้องปกป้อง Client key และ registry เป็นพิเศษ
- **`two-step`** เข้มที่สุด
- **Session PIN** อยู่ใน RAM เท่านั้น
- **Unattended Password** เก็บเฉพาะ SCRAM verifier
- **SCRAM mutual** ตรวจทั้ง Client proof และ Server signature
- **ไม่มี `--pin`** และ `P2PGATE_PIN` ถูกลบออกจาก process
- **`trusted_devices`** ต้องเป็นเจ้าของโดยผู้ใช้และ `chmod 600`
  หากสิทธิ์ไม่ปลอดภัย fast-path จะถูกปิด
- **Progressive lockout** 3/15m, 6/6h, 10/permanent
- **Control socket** เป็น local-only (`0600` หรือ named pipe ของผู้ใช้)
  - ทุก request ต้องมี control token ที่เก็บสิทธิ์ `0600`
  - POSIX ตรวจ owner และสิทธิ์ `0600`
  - PIN ถูกอ่านจาก RAM และส่งผ่าน socket เท่านั้น
  - revoke ตัด connection ที่เปิดอยู่และบันทึกการระงับถาวร
  - ไม่มี TCP listener สำหรับ control plane
  - Windows ใช้ token เสริม named-pipe DACL (Node core ตั้ง DACL เองไม่ได้)
- **Client key ที่ป้องกันด้วย passphrase** ใช้ scrypt + AES-256-GCM
  โดย key แบบ plaintext เดิมยังใช้ได้และ `doctor` จะแนะนำให้เพิ่ม passphrase
- **Audit log** สิทธิ์ `0600` เป็น JSONL และไม่บันทึก secrets
- **trusted device** ข้าม PIN จึงต้องมีวันหมดอายุหรือ `--permanent` อย่างชัดเจน
- **พอร์ตภายใน** ผูกกับ `127.0.0.1`
- **ไฟล์ config/กุญแจ/lockout/trusted_devices/control token/audit log**
  สิทธิ์ `0600`
- **doctor** ไม่พิมพ์ secrets และไม่แก้ไขไฟล์

> p2pgate ไม่ได้แทนที่ SSH security ทั้งหมด
> แต่ช่วยให้เข้าถึง SSH ได้โดยไม่ต้องเปิดพอร์ตสู่สาธารณะ

---

## 19) คำสั่งทั้งหมด

| คำสั่ง | ความหมาย |
|---|---|
| `p2pgate setup` | ตั้งค่าและเลือก verificationMode |
| `p2pgate setup --easy` | สร้าง config แบบ password ด้วยคำถามน้อยที่สุด |
| `p2pgate server` | เริ่ม Server (สร้าง config อัตโนมัติครั้งแรก) |
| `p2pgate server --port <targetPort>` | เริ่ม Server โดย override พอร์ตปลายทางเฉพาะรอบนี้ |
| `p2pgate connect` | เชื่อมต่อด้วย masterSecret + password |
| `p2pgate connect -s <secret> -p <password>` | เชื่อมต่อแบบบรรทัดเดียว |
| `p2pgate connect --target <name>` | เชื่อมต่อ target ที่ประกาศไว้บน Server |
| `p2pgate connect --socks5 <port>` | เปิด SOCKS5 gateway ในเครื่อง (allowlist อยู่ที่ Server) |
| `p2pgate connect --socks5 <port>` | เปิด SOCKS5 gateway (mux เปิดเป็นค่าเริ่มต้น) |
| `p2pgate connect --socks5 <port> --no-mux` | SOCKS5 แบบไม่ใช้ mux |
| `p2pgate master show [--reveal]` | แสดง fingerprint ของ masterSecret |
| `p2pgate master reset --yes` | หมุน masterSecret พร้อมสำรอง config |
| `p2pgate config validate` | ตรวจ config (exit 1 ถ้าผิด) |
| `p2pgate config show` | แสดง config ที่ normalize แล้วโดยปิด secret |
| `p2pgate udp --target <name> --listen <port>` | ส่ง UDP จากเครื่องไปยัง udpTarget ของ Server |
| `p2pgate ping [--count <n>]` | วัด auth time และ RTT แล้วจบ |
| `p2pgate ping --all` | ping ทุก host ใน `hosts.json` |
| `p2pgate connect @alias` | เชื่อมต่อด้วย host ที่บันทึกไว้ |
| `p2pgate connect --save <alias>` | บันทึก host ปัจจุบันเป็น alias |
| `p2pgate hosts list` | แสดงรายการ host |
| `p2pgate audit --tail 20` | อ่าน audit log แบบตารางสั้น |
| `p2pgate server --ttl 30m` | ปิด Server อัตโนมัติเมื่อครบ 30 นาที |
| `p2pgate status --watch` | รีเฟรชสถานะ (traffic) ทุก 1 วินาที |
| `p2pgate keygen` | สร้าง/แสดงกุญแจ Client |
| `p2pgate keygen --passphrase` | ตั้ง/เปลี่ยน passphrase สำหรับ client key |
| `p2pgate keygen --unprotect` | ถอด passphrase (ต้องยืนยันของเดิม) |
| `p2pgate server` | เริ่ม Server |
| `p2pgate client` | เริ่ม Client และขอ credential เฉพาะเมื่อต้อง two-step |
| `p2pgate client --pin-stdin` | อ่าน credential จาก stdin เมื่อถูกถาม |
| `p2pgate client --key-passphrase-stdin` | อ่าน passphrase ของ client key จาก stdin |
| `p2pgate devices list` | แสดง registry และ lockout state |
| `p2pgate devices add <key> --mode trusted --expires ...` | เพิ่ม trusted device ชั่วคราว |
| `p2pgate devices add <key> --mode trusted --permanent` | เพิ่ม trusted device ถาวร (ต้องยืนยันเจตนา) |
| `p2pgate devices add <key> --mode scram` | เพิ่มอุปกรณ์ที่ต้อง two-step |
| `p2pgate devices remove <key>` | ลบออกจาก trusted_devices |
| `p2pgate status` | ดูสถานะเซิร์ฟเวอร์ผ่าน control socket |
| `p2pgate status --json` | ดูสถานะแบบ machine-readable |
| `p2pgate pin` | ขอ Session PIN จากเซิร์ฟเวอร์ที่รันอยู่ |
| `p2pgate revoke <key>` | เพิกถอนคีย์และตัด connection ที่เปิดอยู่ |
| `p2pgate password reset` | เปลี่ยน connection password |
| `p2pgate doctor` | ตรวจสุขภาพการติดตั้งและแนะนำวิธีแก้ |
| `p2pgate doctor --json` | ตรวจสุขภาพแบบ machine-readable |
| `p2pgate unlock --list` | ดูสถานะ lockout/revoke |
| `p2pgate unlock <key>` | ปลดล็อกเฉพาะคีย์ |
| `p2pgate unlock --all` | ปลดล็อกทั้งหมด |
| `p2pgate help` | แสดงข้อความช่วยเหลือ |
| `npm run check` | ตรวจ syntax |
| `npm run self-test` | ทดสอบทุกโหมด, registry, control, doctor, lockout, rotation |
| `npm test` | รัน `check` + `self-test` |

ไฟล์เริ่มต้น:

- config: `~/.p2pgate/config.json`
- กุญแจ Client: `~/.p2pgate/client-key.json`
- trusted devices: `~/.p2pgate/trusted_devices`
- lockout state: `~/.p2pgate/lockout-state.json`
- control socket: `~/.p2pgate/control.sock` (Windows: named pipe)
- control token: `~/.p2pgate/control.token`
- audit log: `~/.p2pgate/audit.log`

---

## 20) แก้ปัญหา

### ขึ้น `STATUS_DECLINED`

- `unlisted`: คีย์ไม่อยู่ใน registry -> `p2pgate devices list`
- `expired`: หมดอายุ -> แก้ `--expires` หรือเพิ่มใหม่
- `insecure_registry`: ไฟล์ trusted_devices สิทธิ์ไม่ปลอดภัย -> `chmod 600`
- `interactive_unavailable`: Server headless ไม่มี terminal และไม่มี Unattended Password
  -> ใช้ trusted fast-path, key-only หรือตั้ง Unattended Password
- `busy`: มีการยืนยันตัวตนอื่นทำงานอยู่ -> ลองใหม่

### `p2pgate status` / `pin` ใช้ไม่ได้

- ต้องมีเซิร์ฟเวอร์ที่รันอยู่และเป็นผู้ใช้เดียวกัน
- ตรวจว่า `~/.p2pgate/control.sock` มีอยู่ (Windows ใช้ named pipe)
- ถ้าเซิร์ฟเวอร์เพิ่ง crash แล้ว socket ค้าง ให้เริ่มเซิร์ฟเวอร์ใหม่
  ระบบจะ probe และลบ socket ที่ไม่มีเจ้าของให้
- ถ้าขึ้น `CONTROL_IN_USE` แสดงว่ามีเซิร์ฟเวอร์อื่นใช้ socket อยู่
  ให้ปิดตัวเก่าก่อน
- ถ้าขึ้น `UNAUTHORIZED` แสดงว่า control token ไม่ตรงหรือค้างจากเซิร์ฟเวอร์เก่า
  ให้รีสตาร์ตเซิร์ฟเวอร์เพื่อสร้าง `~/.p2pgate/control.token` ใหม่
- ถ้าไม่พบ token ให้เริ่มเซิร์ฟเวอร์ก่อน CLI จะยืนยันตัวตนไม่ได้

### `revoke` แล้วยังเชื่อมต่อได้

- ตรวจว่าใช้ `p2pgate revoke <key>` กับเซิร์ฟเวอร์ที่กำลังรันอยู่
- ถ้าเซิร์ฟเวอร์ไม่ได้รัน คำสั่งจะบันทึกเฉพาะ state
  และมีผลเมื่อเซิร์ฟเวอร์อ่าน state ใหม่
- ตรวจด้วย `p2pgate unlock --list` ว่าสถานะเป็น
  "เพิกถอนด้วยคำสั่ง revoke"
- คืนสิทธิ์ด้วย `p2pgate unlock <key>`

### `devices add --mode trusted` ถูกปฏิเสธ

ต้องระบุอย่างใดอย่างหนึ่ง:

```sh
p2pgate devices add <key> --mode trusted --expires 2027-12-31T23:59:59Z
p2pgate devices add <key> --mode trusted --permanent
```

ถ้าใช้ `--permanent` ควรตรวจสอบรายการเป็นระยะด้วย `p2pgate devices list`

### `doctor` ขึ้น ❌

อ่านคำแนะนำใต้บรรทัดนั้น เช่น สิทธิ์ไฟล์ไม่ปลอดภัย, registry ว่าง,
ไม่พบกุญแจ Client หรือ config ไม่ถูกต้อง
แก้แล้วรัน `p2pgate doctor` ซ้ำ
คำเตือน `⚠️` ไม่ทำให้ exit code เป็น 1

### trusted device ไม่ใช้ fast-path

- ตรวจ `verificationMode` ว่าเป็น `hybrid` หรือ `key-only`
- ตรวจว่าไฟล์เป็น `chmod 600` และเจ้าของถูกต้อง
- ตรวจว่าไฟล์ไม่หมดอายุ
- ตรวจว่า `config.json` ไม่ได้ override (ไฟล์ควรชนะ)
- ตรวจว่า Server โหลดไฟล์ใหม่แล้ว (`devices list` / mtime)

### key-only ไม่ถาม PIN

นี่คือพฤติกรรมปกติของ `key-only`
ถ้าต้องการ PIN ให้ใช้ `hybrid` หรือ `two-step`

### two-step ถาม PIN ทุกครั้ง

นี่คือพฤติกรรมปกติ
แม้อุปกรณ์จะอยู่ใน `trusted_devices` ก็จะไม่ใช้ fast-path ในโหมดนี้

### Client ไม่ถาม PIN

- ถ้า Server ส่ง `FASTPATH_READY` หรือเป็น `key-only` จะไม่ถาม
- ถ้าต้องการให้ถาม ใช้ `hybrid` + โปรไฟล์ `scram` หรือ `two-step`

### `PIN_REQUIRED`

Client ต้อง two-step แต่ไม่มี terminal / ไม่มี `--pin-stdin` / ไม่มี `P2PGATE_PIN`

### Passphrase ของ client key ผิดพลาด

- `KEY_PASSPHRASE_REQUIRED`: key ถูกป้องกันและไม่มีทางส่ง passphrase
  - ใช้ `--key-passphrase-stdin` หรือ `P2PGATE_KEY_PASSPHRASE`
- `KEY_PASSPHRASE_INVALID`: passphrase ไม่ถูกต้อง
- `KEY_PASSPHRASE_WEAK`: passphrase ใหม่สั้นกว่า 12 ตัวอักษร
- เพิ่ม protection ให้ key เดิม:
  ```sh
  p2pgate keygen --passphrase
  ```

### `PIN_ROTATED_OR_INVALID`

- PIN อาจถูกเปลี่ยนเพราะมีผู้ใส่ผิด 3/6 ครั้ง หรือ Server รีสตาร์ต
- ดู PIN ล่าสุดบนหน้าจอ Server หรือใช้ Unattended Password

### `LOCKED_OUT`

```sh
p2pgate unlock --list
p2pgate unlock <clientPublicKeyHex>
p2pgate unlock --all
```

### `AUTH_CONFIG_UPGRADE_REQUIRED`

พบ config รูปแบบ v1.1 กรุณารัน:

```sh
p2pgate setup
```

### v1.2 config ยังใช้งานได้ไหม

ได้ — ถ้าไม่มี `verificationMode` จะถือเป็น `hybrid`
และถ้า `authPin.enabled: false` จะถือเป็น `key-only`

### `PEER_NOT_FOUND`

- ตรวจ Server ทำงาน
- ตรวจ `masterSecret` ตรงกัน
- ตรวจ registry/public key
- ตรวจ UDP เครือข่าย
- Client ลองชั่วโมงก่อนหน้าให้อัตโนมัติ

### `EADDRINUSE`

```sh
p2pgate client --port 8023
ssh -p 8023 localhost
```

### SSH `Permission denied (publickey)`

- ตรวจ `~/.ssh/authorized_keys` และสิทธิ์
- ตรวจ `PasswordAuthentication no` และรีสตาร์ต sshd

---

## 21) โครงสร้างโปรเจกต์

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

### การพัฒนาและ CI

- คู่มือทดสอบก่อนใช้งานจริง: [`TESTING.md`](TESTING.md)
- ประวัติเวอร์ชัน: [`CHANGELOG.md`](CHANGELOG.md)
- แนวทางมีส่วนร่วม: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- นโยบายความปลอดภัย: [`SECURITY.md`](SECURITY.md)
- workflow `.github/workflows/ci.yml` รัน `npm ci --ignore-scripts`,
  `npm run check` และ `npm run self-test` บน Ubuntu (Node 20/22/24),
  Windows (24) และ macOS (24) เมื่อ GitHub Actions ของบัญชีพร้อมใช้งาน
- รันชุดเดียวกันในเครื่องก่อน push:

```sh
npm test
```

---

## 22) หมายเหตุทางเทคนิค

- **Registry merge:** config keys = scram; file entries override; expired file entry denies
- **POSIX check:** symlink/owner/group-other permissions before fast-path
- **Live reload:** `mtimeMs` + atomic rename
- **Status frames v3:** `DECLINED`, `FASTPATH_READY`, `CHALLENGE_REQUIRED`, `READY`
- **Client READY:** Client ส่งหลังได้ credential เพื่อไม่ให้เวลาพิมพ์ถูกนับใน 10 วินาที
- **Control protocol:** newline-delimited JSON, version `2`, max 4096 bytes, timeout 5 วินาที
- **Control commands:** `status`, `pin`, `revoke`
  - ทุก request ต้องมี control token
  - `status` ไม่คืน PIN
  - `pin` อ่านจาก memory เท่านั้น
  - `revoke` ใช้ `AuthGuard.revoke(key, 'manual')` แล้วปิด active streams
- **Control socket:** POSIX `0600` ตรวจ owner/permission, Windows named pipe, stale-socket probe ก่อนลบ
- **Control token:** 32 random bytes, SHA-256 + `timingSafeEqual`, ไฟล์ `0600`
- **Audit log:** JSONL แบบ serialize, หมุนหนึ่งไฟล์, กรอง secret fields, ไม่บล็อก auth
- **Client key encryption:** scrypt (N=16384, r=8, p=1) + AES-256-GCM
- **JSON output:** `status --json` และ `doctor --json`
- **doctor:** read-only, exit 1 เมื่อมี `❌`, ไม่พิมพ์ secrets
- **Trusted expiry:** CLI บังคับ `--expires` หรือ `--permanent`; ไฟล์เดิมยังใช้ได้
- **SCRAM:** ยังใช้ challenge/response แบบ mutual และตรวจ `serverSig`
- **Session PIN:** 10 ตัวอักษร Base32, salt ใหม่ทุกครั้งที่สร้าง/เปลี่ยน
- **Async scrypt:** `crypto.scrypt` (N=16384, r=8, p=1)
- **Lockout:** 24-hour failure window, lockfile, atomic rename, mtime reload
- **Concurrency:** 1 ต่อคีย์, 3 ทั้งระบบ
- **Invalid delay:** 2.5–3.5 วินาที (self-test ใช้ค่าสั้น)
- **No `P2PGATE_TEST_*` env hooks**
- **Self-test:** ใช้ `HyperDHT.bootstrapper` และ injected clock/delay

---

## 22.1) ภาษา

```sh
P2PGATE_LANG=en p2pgate server
P2PGATE_LANG=th p2pgate setup
```

หรือ:

```sh
p2pgate --lang th doctor
```

ลำดับการเลือกภาษา: `P2PGATE_LANG`/`--lang` → `LANG`/`LC_ALL` → ค่าเริ่มต้น `en`

quickstart, setup, server, connect และ help รองรับสองภาษา

คำสั่ง legacy บางส่วนยังอยู่ในระหว่างการแปล

---

## 23) License

p2pgate ใช้ **Apache License 2.0**

- [`LICENSE`](LICENSE)
- [`NOTICE`](NOTICE)

Copyright 2026 incognitums

