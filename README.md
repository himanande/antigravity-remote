# Antigravity Remote

**Control your IDE terminals from your phone.** Start Claude Code (or any CLI) on your PC, walk away, and keep driving it from a browser — end-to-end encrypted, multi-session, and synced in both directions.

Works in [Google Antigravity](https://antigravity.google/) and other VS Code–compatible editors.

> **日本語の説明は[下にあります](#日本語)。**

---

## Why

Remote-control tools for AI coding agents are tied to one specific agent and show you a *chat*. This one hosts the **raw terminal**, so whatever you run on your PC — `claude`, `gemini`, `aider`, `npm test`, `ssh` — you can watch and type into it from your phone.

|                             | Antigravity Remote | Agent-chat remotes  |
| --------------------------- | ------------------ | ------------------- |
| Raw terminal / any CLI      | ✅                  | ❌ (one agent only) |
| Multiple sessions           | ✅                  | ❌                   |
| PC ⇄ phone two-way sync     | ✅                  | —                   |
| End-to-end encrypted        | ✅                  | varies              |
| No inbound ports on your PC | ✅                  | varies              |

## Features

- **Terminal hosting** — the extension spawns real PTYs (`node-pty`) and streams them to your phone.
- **Multi-session** — run several terminals at once; switch between them from a list on your phone.
- **Two-way sync** — each remote session also appears as a `⇄ …` terminal tab in your IDE. Type on either side; both stay in sync, scrollback included.
- **End-to-end encryption** — pair by scanning a QR code. Keys are exchanged directly between your PC and your phone (X25519 + XSalsa20-Poly1305 via libsodium). The relay only ever sees ciphertext.
- **Outbound-only** — both sides dial out over WSS. Nothing listens on your PC; no port forwarding, no inbound firewall rules.
- **Mobile-friendly key bar** — arrows, Esc, Tab, Ctrl, `^C`, Enter, plus **your own custom shortcuts**, kept visible while the soft keyboard is open.
- **Push notifications** — get pinged when a session is waiting for your input.
- **Kill switch** — revoke pairing and cut every remote connection with one command.

## Quick start

**No setup, no account, no server to deploy.**

1. Install the extension in Antigravity (or any VS Code–compatible editor).
2. Run **`Antigravity Remote: ペアリング開始(QR・E2EE)`** from the Command Palette.
3. Scan the QR code with your phone. The web app opens and connects — you're in.

The pairing QR embeds a fresh random room ID and the shared secret, so a QR is single-use and unguessable.

By default this routes through a free managed relay we operate. **It cannot read your terminal** — encryption happens on your devices, so the relay only ever forwards ciphertext. It is provided as-is with no uptime guarantee ([terms](./TERMS.md)).

### Prefer your own relay?

Fully supported, and it takes about a minute. Deploy [`relay-cf/`](./relay-cf) to your own Cloudflare account (the free tier is enough), then:

```jsonc
// settings.json
"antigravityRemote.relayUrl": "wss://<your-worker>.workers.dev"
```

Leave the setting empty to go back to the managed relay. For LAN-only use, there is also a minimal local relay in [`relay/`](./relay).

## How it works

```
Antigravity (extension)              relay (Cloudflare Worker)          phone (PWA)
  node-pty ──┐                          Durable Object                 ┌── xterm.js
             ├─ E2EE ─ WSS ─────────────► forwards ciphertext ◄─ WSS ──┤
  ⇄ terminal ┘                          (zero-knowledge)               └── key bar
```

Both ends connect **outbound** to the relay; the relay pairs them by room and forwards opaque bytes. It cannot read your terminal because encryption happens above the transport. See [ADR-002](./docs/decisions.md) for why P2P was not chosen.

## Security

- Encryption is **application-layer**, not just TLS — a compromised relay still sees only ciphertext.
- Room IDs are **128-bit random**, minted per pairing.
- Browser dependencies (xterm.js, libsodium) are **self-hosted with Subresource Integrity**, so no third-party CDN can inject code into the crypto path.
- Sessions are limited to **preset commands** (`claude` / `bash`); the phone cannot ask the host to run an arbitrary binary.
- `Antigravity Remote: リモート接続を遮断(キルスイッチ)` revokes pairing immediately.

Found a security issue? Please open a [GitHub issue](https://github.com/himanande/antigravity-remote/issues) and mark it as sensitive, and we'll move the discussion private.

## Privacy

Terminal contents are end-to-end encrypted and are **never stored**. See [PRIVACY.md](./PRIVACY.md).

## Requirements

- Antigravity, or another VS Code–compatible editor (`^1.90.0`)
- Windows / macOS / Linux on x64 or arm64 — native binaries ship inside the extension, so there is **no build step and no toolchain** required on your machine

## Development

Requirements, findings, design decisions and the task board all live in [`docs/`](./docs):

| Document                                            | Contents                                    |
| --------------------------------------------------- | ------------------------------------------- |
| [requirements_v0.3.md](./docs/requirements_v0.3.md) | What we're building                         |
| [findings.md](./docs/findings.md)                   | Verified facts, with reproduction commands  |
| [decisions.md](./docs/decisions.md)                 | Architecture decision records               |
| [tasks.md](./docs/tasks.md)                         | Task / progress board                       |
| [collaboration.md](./docs/collaboration.md)         | How humans and AI agents work together here |

```bash
npm install
npm run build      # bundle the extension
npm run package    # produce antigravity-remote.vsix (bundles native binaries)
```

## License

[MIT](./LICENSE)

---

<a name="日本語"></a>

## 日本語

**PCのターミナルを、スマホから操作する拡張機能です。**

Claude Code などのCLIをPCで起動したまま外出し、スマホのブラウザから続きを操作できます。**エンドツーエンド暗号化**・**マルチセッション**・**PC⇄スマホ双方向同期**に対応。

### 何が違うのか

既存の遠隔操作ツールは特定のエージェントの「チャット画面」を写すものが中心ですが、これは**生のターミナルそのもの**をホストします。`claude` でも `gemini` でも `npm test` でも、PCで動かせるものはそのままスマホから操作できます。

### 主な機能

- **ターミナルのホスト**: 拡張が `node-pty` で実PTYを起動し、スマホへ中継
- **マルチセッション**: 複数の端末を同時に持ち、スマホの一覧から切り替え
- **双方向同期**: 各セッションはIDE側にも `⇄ …` タブとして出現。どちらで打っても両方に反映(スクロールバックも共有)
- **E2EE**: QRを読むだけでペアリング。鍵はPCとスマホの間で直接交換され、**リレーは暗号文しか見えません**
- **アウトバウンドのみ**: PC側でポートを開けません。ポート開放も受信FW設定も不要
- **スマホ用キーバー**: 矢印/Esc/Tab/Ctrl/^C/Enter に加え**自分でショートカットを追加**可能。ソフトキーボード表示中も消えません
- **プッシュ通知**: 入力待ちになったセッションを通知
- **キルスイッチ**: 1コマンドでペアリング失効・全接続遮断

### 使い方

**設定不要・アカウント不要・サーバー構築不要です。**

1. 拡張をインストール
2. コマンドパレットで **`Antigravity Remote: ペアリング開始(QR・E2EE)`**
3. 出てきたQRをスマホで読み取ると接続完了

既定では本プロジェクトが運営する無料のマネージドリレーを経由します。**運営者にもターミナルの中身は読めません**(暗号化は端末側で行われ、リレーは暗号文しか扱いません)。無保証での提供です([利用規約](./TERMS.md))。

自前のリレーを使いたい場合は、[`relay-cf/`](./relay-cf) をCloudflareの無料枠にデプロイして `antigravityRemote.relayUrl` を自分のURLに変えてください(空にすると既定に戻ります)。こちらも一級の利用方法として維持します。

QRにはペアリングごとに新しい128bit乱数のroom IDと共有鍵が入るため、**使い捨てかつ推測不可能**です。

### 動作環境

Antigravity または VS Code 互換エディタ(`^1.90.0`)。Windows / macOS / Linux(x64・arm64)。**ネイティブバイナリを同梱しているので、利用者側でのビルドやツールチェーンは不要**です。
