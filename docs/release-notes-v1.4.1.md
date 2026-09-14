# Soundbox 1.4.1

This release ships the real production wiring: Soundbox now talks to the live license
server out of the box, and the buy button points at the real checkout. If you are
upgrading from 1.4.0, the in-app updater will offer this release automatically and
verify it before installing.

## What's new

- **Live license activation**: the compiled license-server default is now
  `https://soundbox-license.fly.dev` — activation works out of the box, no override
  needed.
- **Real checkout link**: the "buy a key" button on the activation screen opens the
  actual Lemon Squeezy checkout instead of a placeholder.
- **Lemon Squeezy webhook in production**: purchases issue license keys automatically
  and the key is delivered with the order receipt.

## Downloads

- **Windows**: `Soundbox_1.4.1_x64_en-US.msi` (installer) or
  `Soundbox_1.4.1_x64-setup.exe` (NSIS) — Windows 10/11, 64-bit
- **macOS**: `Soundbox_1.4.1_aarch64.dmg` (Apple Silicon) or
  `Soundbox_1.4.1_x64.dmg` (Intel)
- **Linux**: `soundbox_1.4.1_amd64.deb`, `soundbox-1.4.1-1.x86_64.rpm`, or the AppImage

Every artifact has a sibling `.sig` file; the in-app updater verifies it against the
public key embedded in the app before installing anything.

## Install & activate

1. Install for your platform from the assets above.
2. [Buy a key](https://milodami.lemonsqueezy.com/checkout/buy/83c11491-df70-499f-84fd-dcdf5a98b0d4)
   — it arrives by email after checkout.
3. Launch Soundbox, paste the key on the activation screen, click **Activate**. The key
   is bound to one machine and never expires.

## Support

- Issues and feedback: [github.com/Dami1233/soundbox/issues](https://github.com/Dami1233/soundbox/issues)
