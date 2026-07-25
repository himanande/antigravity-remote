# Changelog

All notable changes to this extension are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — unreleased

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
