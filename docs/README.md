# Documentation

## Specifications

| Document | Version | Description |
|---|---|---|
| [Project handoff specification](specs/project-spec.md) | v1.0 | Original architecture, security model, file layout, and acceptance criteria |
| [Phase 2 — PIN/password gate](specs/phase2-v1.1.md) | v1.1 | Challenge-response PIN/password layer and first lockout rules |
| [Phase 3 — Mutual SCRAM](specs/phase3-v1.2.md) | v1.2 | SCRAM verification, async scrypt, progressive lockout, live unlock |
| [Phase 4 — Verification modes](specs/phase4-v1.3.0.md) | v1.3.0 | Verification policy modes, trusted_devices registry, status frames v3 |
| [Phase 5 — Control plane](specs/phase5-v1.4.0.md) | v1.4.0 | Local control socket, doctor, trusted-device expiry enforcement |
| [Phase 6 — Auditability](specs/phase6-v1.5.0.md) | v1.5.0 | Audit log, encrypted keys, JSON output, control token |
| [Phase 7 — Zero-setup](specs/phase7-v1.6.0.md) | v1.6.0 | Zero-setup server, password auth, one-line connect |
| [Phase 8 — `p2phub`](https://github.com/incognitums/p2phub/blob/main/docs/spec.md) | draft | Separate repository: optional control plane (inventory, directory, policy, enrollment, secret custody) |
| [Phase 8 — Multi-target](specs/phase8-targets.md) | v1.7.0 | `targets` map, `--target`, per-target allowlist |
| [Phase 9 — SOCKS5](specs/phase9-socks5.md) | v1.8.0 | SOCKS5 gateway with an IP/CIDR allowlist |
| [Phase 10 — masterSecret rotation](specs/phase10-master.md) | v1.8.3 | `master show` / `master reset` with backup |
| [Phase 11 — Hardening](specs/phase11-v1.9.0.md) | v1.9.0 | `config validate/show`, doctor upgrades, per-client SOCKS |
| [Phase 12 — UDP](specs/phase12-udp.md) | v1.10.0 | UDP-over-stream with `udpTargets` |
| [Phase 13 — Ping/traffic](specs/phase13-ping-traffic.md) | v1.11.0 | `p2pgate ping`, traffic counters, `status --watch` |
| [Phase 14 — Multiplexing](specs/phase14-mux.md) | v1.12.0 | `--mux` carrier with channels (opt-in) |
| [Phase 15 — mux over fast-path](specs/phase15-fastpath-mux.md) | v1.13.0 | capability + bounded peek for trusted devices |

The Phase 4 document was converted from the original `.docx` handoff file to
Markdown for easier review and diffing.

## Other documents

- [Session handoff](HANDOFF.md) — current state, invariants, next steps
- [Product handoff](PRODUCT-HANDOFF.md) — product-oriented briefing for a new agent (what exists, constraints, directions)
- [Spike — Rust module port](spikes/rust-module-port.md) — 2-day experiment: is one deterministic module worth porting?
- [Soak test record](SOAK.md) — overnight run results and next-round template
- [Running as a service](SERVICE.md) — Termux, systemd, Windows
- [Release notes v1.13.5](releases/v1.13.5.md)
- [Release notes v1.13.6](releases/v1.13.6.md)
- [Release notes v1.13.7](releases/v1.13.7.md)
- [Release notes v1.13.8](releases/v1.13.8.md)
- [Release notes v1.13.4](releases/v1.13.4.md)
- [Release notes v1.13.3](releases/v1.13.3.md)
- [Release notes v1.13.2](releases/v1.13.2.md)
- [Release notes v1.13.1](releases/v1.13.1.md)
- [Release notes v1.13.0](releases/v1.13.0.md)
- [Release notes v1.12.1](releases/v1.12.1.md)
- [Release notes v1.12.0](releases/v1.12.0.md)
- [Release notes v1.11.4](releases/v1.11.4.md)
- [Release notes v1.11.3](releases/v1.11.3.md)
- [Release notes v1.11.2](releases/v1.11.2.md)
- [Release notes v1.11.1](releases/v1.11.1.md)
- [Release notes v1.11.0](releases/v1.11.0.md)
- [Release notes v1.10.0](releases/v1.10.0.md)
- [Release notes v1.9.1](releases/v1.9.1.md)
- [Release notes v1.9.0](releases/v1.9.0.md)
- [Release notes v1.8.4](releases/v1.8.4.md)
- [Release notes v1.8.3](releases/v1.8.3.md)
- [Release notes v1.8.2](releases/v1.8.2.md)
- [Release notes v1.8.1](releases/v1.8.1.md)
- [Release notes v1.8.0](releases/v1.8.0.md)
- [Release notes v1.7.0](releases/v1.7.0.md)
- [Release notes v1.6.4](releases/v1.6.4.md)
- [Release notes v1.6.3](releases/v1.6.3.md)
- [Release notes v1.6.2](releases/v1.6.2.md)
- [Release notes v1.6.1](releases/v1.6.1.md)
- [Release notes v1.6.0](releases/v1.6.0.md)
- [Release notes v1.5.0](releases/v1.5.0.md)
- [Release notes v1.4.1](releases/v1.4.1.md)
- [Release notes v1.4.0](releases/v1.4.0.md)
- [Manual acceptance testing](../TESTING.md) (Thai)
- [Changelog](../CHANGELOG.md)
- [Contributing](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
