# Terms of Use — the managed relay

Last updated: 2026-07-26

These terms cover the **managed relay service** at `relay.termhop.dev` and the web app at `termhop.dev`, operated by the Antigravity Remote project.

They do **not** cover the software itself. The extension, the web app and the relay are open source under the [MIT License](./LICENSE) — you may use, modify and self-host them under that licence, and nothing here restricts that.

## The service

The managed relay forwards end-to-end encrypted traffic between your computer and your phone. It is provided **free of charge, as-is, with no service-level commitment**. It may be slow, rate-limited, interrupted, or discontinued at any time.

If you need guaranteed availability, [run your own relay](./relay-cf) — that path is fully supported and always will be.

## Acceptable use

Don't use the managed relay to:

- attack, overload, or probe the service or anyone else's systems;
- circumvent the rate limits, or run automated traffic that isn't a real interactive session;
- host content or run activity that is illegal where you or we are located;
- resell or repackage the relay as your own hosted service. (Self-hosting for yourself, your team, or your customers is fine — that is what the MIT licence is for.)

We may block an IP address or refuse service if the relay is being abused. Because traffic is end-to-end encrypted, such decisions are based only on traffic patterns — we cannot and do not inspect your terminal contents.

## Your responsibility

You control what runs in the terminals you expose. Anyone holding a pairing QR code can drive those terminals, so treat a QR code like a password: it is single-use, it embeds a secret, and you should not share or photograph it where others can see. Use the kill-switch command to revoke pairing immediately.

We are not responsible for what you or anyone you share access with does on your machine.

## No warranty, no liability

The service is provided "as is", without warranty of any kind. To the fullest extent permitted by law, the operator is not liable for any damages arising from use of, or inability to use, the service — including lost work, data loss, or downtime.

## Privacy

See [PRIVACY.md](./PRIVACY.md). In short: the relay cannot read your terminal contents, and we do not retain connection metadata.

## Changes

We may update these terms. Material changes will be noted in [CHANGELOG.md](./CHANGELOG.md) and in the "Last updated" date above. Continuing to use the managed relay after a change means you accept it.

## Contact

<https://github.com/himanande/antigravity-remote/issues>
