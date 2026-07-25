# Privacy Policy — Antigravity Remote

Last updated: 2026-07-25

This document describes what the Antigravity Remote extension, the phone web app, and the relay do with your data. It applies to the software in this repository. If you deploy your own relay, you are the operator of that relay and this document describes what the code does, not a service commitment.

## Short version

Your terminal contents are end-to-end encrypted between your PC and your phone. The relay cannot read them, and **nothing is stored** — the relay has no database and writes no logs of your session content.

## What is *not* collected

- **Terminal input and output.** Encrypted on your PC with a key established directly with your phone (X25519 key exchange, XSalsa20-Poly1305 authenticated encryption). The relay only forwards opaque ciphertext.
- **Source code, file contents, prompts, or AI agent conversations.** The extension does not read your files or upload your workspace.
- **Accounts.** The current version has no sign-up, no login, and no user identifier.
- **Analytics or telemetry.** The current version sends none.

## What the relay necessarily sees

A relay is a network intermediary, so it unavoidably observes:

- **The room ID** used to pair the two sides. It is a 128-bit random value generated per pairing and carries no information about you.
- **Connection metadata**: source IP address, connection time, and the size and timing of messages. This is inherent to any network connection.

The relay in this repository keeps no persistent storage — it holds the two live WebSocket connections in memory and drops everything when they close. If you use Cloudflare Workers as the host, Cloudflare processes the connection as a network provider under its own terms.

## Data stored on your devices

- **On your PC**: the pairing secret and the current push subscription, held **in memory only** for the lifetime of the session. Your relay URL and other preferences are stored in your editor's settings, as with any extension.
- **On your phone**: the pairing information and your custom key-bar shortcuts, stored in the browser's `localStorage` so you can reconnect. Clearing site data removes them.

Running the kill-switch command (`Antigravity Remote: リモート接続を遮断`) invalidates the pairing and drops all remote connections.

## Push notifications

If you enable notifications, your phone creates a subscription with its browser vendor's push service (for example Google's FCM for Chrome, or Mozilla's service for Firefox) and sends it to your PC over the encrypted channel. Your PC then sends notifications **directly** to that push service. The subscription is never sent to the relay, and it is not persisted after the session ends. Notification payloads contain only a session title and a short status such as "waiting for input" — never terminal contents.

## Third parties

| Party                         | Role                                  | What it sees                                       |
| ----------------------------- | ------------------------------------- | -------------------------------------------------- |
| Your relay host (e.g. Cloudflare) | transports the encrypted stream   | connection metadata, ciphertext                    |
| Browser push service (e.g. FCM)   | delivers notifications            | your subscription and the notification text        |

The extension contacts no other network service. The phone web app loads all of its dependencies from the relay that serves it — no third-party CDN is used.

## Children

This software is a developer tool and is not directed at children under 13.

## Changes

Material changes to this policy will be recorded in [CHANGELOG.md](./CHANGELOG.md) and in this file's "Last updated" date.

## Contact

Questions or requests: <https://github.com/himanande/antigravity-remote/issues>
