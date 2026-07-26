# Changelog

All notable changes to this extension are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-07-26

### Added

- **Zero-setup onboarding.** The extension now defaults to a free managed relay at `relay.termhop.dev`, with the phone web app served from `termhop.dev`. Installing and pairing no longer requires deploying anything. Traffic stays end-to-end encrypted, so the relay — including ours — only ever sees ciphertext.
- [TERMS.md](./TERMS.md) covering the managed relay, and an updated [PRIVACY.md](./PRIVACY.md) describing exactly what the operator can and cannot see.

### Changed

- `antigravityRemote.relayUrl` defaults to `wss://relay.termhop.dev`; leaving it empty falls back to that same managed relay. Pointing it at your own relay remains fully supported.
- Invalid relay URLs now produce a clear error instead of failing silently.

### Security

- Relay abuse protection: per-IP connection rate limiting (20/min, burst 40, 60s block) enforced in a Durable Object with durable state, room ID format validation, per-room connection caps (2 hosts / 6 clients), a 512 KB message cap and a per-socket flow limit.
- Terminal scrollback is now capped by bytes (256 KB) as well as chunk count, bounding the size of a single snapshot message.

## [0.1.0] — 2026-07-26

First public release.

### Added

- **Terminal hosting** — spawn real PTYs (`node-pty`) from the extension and stream them to a phone browser.
- **Multi-session** — host several terminals at once, with a list/switch UI on the phone.
- **Two-way sync** — every remote session also appears as a `⇄ …` terminal tab in the IDE; input and output stay in sync on both sides, scrollback included.
- **End-to-end encryption** — QR pairing with X25519 key exchange and XSalsa20-Poly1305 (libsodium). The relay forwards ciphertext only.
- **Cloudflare Workers relay** — Durable Objects with hibernatable WebSockets; the same Worker also serves the phone web app.
- **Mobile key bar** — arrows, Esc, Tab, Ctrl (toggle), `^C`, Enter, plus user-defined shortcuts stored on the device. Stays visible while the soft keyboard is open.
- **Web Push notifications** for sessions waiting on input.
- **Kill switch** — revoke pairing and drop all remote connections.
- **Reconnect with scrollback restore.**

### Security

- Room IDs are 128-bit random and minted per pairing.
- Browser dependencies (xterm.js, libsodium) are self-hosted with Subresource Integrity.
- Sessions are restricted to preset commands; the remote side cannot request arbitrary binaries.

### Packaging

- Native `node-pty` binaries for darwin-x64/arm64, win32-x64/arm64 and linux-x64/arm64 ship inside the `.vsix`. No build step or toolchain is required on the user's machine.
