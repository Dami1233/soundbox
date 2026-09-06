# Licensing — activation keys for a paid Zuno build

This folder is the seller side of the activation system. The **client** side lives in
`src-tauri/src/license.rs` (Rust) and `src/ui/components/ActivationScreen.tsx` +
`src/ui/AppGate.tsx` (React).

How a purchase flows, end to end:

1. You mint a product key: `node licensing/cli.mjs issue --licensee alice@example.com`.
2. You hand that key to the buyer (your store, an email, a Gumroad/Lemon Squeezy webhook —
   see [Selling](#selling) for a ready-made webhook body).
3. On first launch the app offers a **7-day trial**. After that (or any time) the buyer pastes
   the key into the activation screen.
4. The app computes a stable machine id and POSTs `{ product, key, machineId, appVersion }` to
   your server's `/activate`.
5. Your server checks the key: known, not revoked, not expired, and the activation count under
   `maxDevices`. It records the machine and replies with an **Ed25519-signed license envelope**
   bound to that machine id.
6. The app verifies the signature against the public key compiled into the binary **before**
   trusting anything, saves the envelope, and unlocks.

The app re-verifies the stored envelope on **every launch, offline**: signature, product,
machine binding and expiry. So an activated copy keeps working with no network — and a forged
or tampered license is rejected instantly because it cannot be signed without your private key.

## What this enforces (read this)

- No one can mint a working key without your private key, and no one can edit a stored license
  without breaking its signature.
- Each key activates at most `maxDevices` machines (default 1) and can be revoked.
- It **does not** stop a determined person who ships their own patched binary — the app's
  source is public. This is the honest ceiling for gating any open-source app. What you are
  selling is convenience and updates; that is a normal and workable model (see also
  [Legal and distribution](#legal-and-distribution)).

## Files

| File | Purpose |
|---|---|
| `lib.mjs` | Shared logic: keypair handling, key generation, signing, activation. Zero deps. |
| `server.mjs` | The HTTP license server (Node 18+, `node:http`, zero deps). |
| `cli.mjs` | Seller CLI for keypair + key management, run on the server host. |
| `data/` | **Git-ignored.** `licenses.json` holds the private key and every issued key. Never commit or upload this folder. |
| `README.md` | This file. |

## One-time setup

**1. Generate your keypair and embed the public key.**

```bash
node licensing/cli.mjs generate-keys
```

It prints a base64 public key. Paste it into `src-tauri/src/license.rs`:

```rust
pub const LICENSE_PUBLIC_KEY_B64: &str = "<paste here>";
```

> The repo ships with a *development* keypair so you can test immediately
> (`licensing/data/licenses.json` already matches the embedded key). **Before you sell
> anything, run `generate-keys --force`** and paste the new public key — otherwise anyone who
> obtains that development database can mint keys your build accepts.

**2. Point the app at your server.** In `src-tauri/src/license.rs`:

```rust
pub const LICENSE_SERVER_URL: &str = "https://licenses.example.com";
```

`ZUNO_LICENSE_SERVER` overrides it at runtime (handy for staging). **Release builds require
an https:// URL.**

**3. Point the activation screen at your store.** In `src/internal/license.ts`:

```ts
export const LICENSE_PURCHASE_URL = "https://example.com/buy-zuno";
export const LICENSE_SUPPORT_EMAIL: string | null = null;
```

## Running the server

```bash
# local test
node licensing/server.mjs
curl http://127.0.0.1:8787/health
```

Environment:

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `HOST` | `127.0.0.1` | Bind address. Set `0.0.0.0` behind your reverse proxy. |
| `LICENSE_DATA_DIR` | `./data` (next to the script) | Where `licenses.json` lives |
| `ADMIN_TOKEN` | *(unset)* | Bearer token for `/admin/*`; unset disables admin routes |

Deploy anywhere Node 18+ runs (VPS, Railway, Fly, Render, a $5 droplet — it is one small
process with one JSON file). Put it behind **HTTPS** (Caddy/nginx/Cloudflare). Persist
`LICENSE_DATA_DIR` somewhere durable; a fresh directory means a fresh keypair and every issued
key dies with the old one. Back it up.

## Issuing and managing keys

All of these run on the server host against the same `licenses.json`:

```bash
# issue a key for one machine, perpetual
node licensing/cli.mjs issue --licensee alice@example.com

# three machines, 30-day license, internal note
node licensing/cli.mjs issue --licensee "Acme Corp" --max-devices 3 --days 30 --note "volume deal"

node licensing/cli.mjs list
node licensing/cli.mjs revoke AAAA-BBBB-CCCC-DDDD
node licensing/cli.mjs deactivate AAAA-BBBB-CCCC-DDDD <machineId>   # free a device slot
node licensing/cli.mjs print-fixture                                 # see below
```

Or over HTTP from anywhere (e.g. a checkout webhook), with `ADMIN_TOKEN` set:

```bash
curl -X POST $SERVER/admin/issue \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"licensee":"alice@example.com","plan":"perpetual","maxDevices":1}'
# -> { "ok": true, "key": "WXYZ-ABCD-EFGH-IJKL" }
```

`POST /admin/revoke {key, revoked}` and `POST /admin/deactivate {key, machineId}` behave like
the CLI twins; `GET /admin/keys` lists everything.

## Selling

Two common patterns:

- **Manual / low volume** — issue keys by hand and email them.
- **Webhook / Gumroad or Lemon Squeezy** — call `/admin/issue` from their webhook when a
  payment succeeds, then deliver the returned key to the buyer (Gumroad ping + Lemon Squeezy
  both support sending the buyer a custom payload). The `/admin/*` endpoints are deliberately
  small so this stays a one-curl integration.

Buyers hitting "Already activated on the maximum number of computers" should ask you to run
`deactivate` on their old machine id (visible via `list`), or you raise their `maxDevices`.

## Trials

- First run with no license offers a 7-day trial (`license_start_trial`, stored by Rust in the
  app-data dir as `trial-v1.json`).
- The trial is **local**: clearing app data resets it, and offline clock changes are not
  detected (there is no trusted clock server in the loop). If you need trials that resist
  that, make `/activate` also mint time-limited *trial licenses* instead — the envelope
  already carries `expiresAtMs`.
- Debug builds skip the gate entirely. Run with `ZUNO_LICENSE_ENFORCE=1` to exercise the real
  flow in a dev build; release builds always enforce.

## Dev workflow

| Situation | How |
|---|---|
| `npm run tauri dev` (debug) | Gate bypassed, app opens straight away |
| Test the real gate in dev | `ZUNO_LICENSE_ENFORCE=1 npm run tauri dev` |
| Fully offline unit tests | `cargo test license` in `src-tauri` |
| Reset a machine's local activation | Delete `<app-data>/license-v1.json` + `trial-v1.json`, or ship a build that exposes `license_reset` |

## Changing the keypair (production go-live, or after a leak)

```bash
node licensing/cli.mjs generate-keys --force     # new keypair; ALL old keys stop working
node licensing/cli.mjs issue ...                 # re-issue to your customers
```

Then paste the new public key into `license.rs` and regenerate the interop fixture:

```bash
node licensing/cli.mjs print-fixture
```

…and replace the `payload` / `sig` literals in the `verifies_a_license_signed_by_the_server_keypair`
test in `src-tauri/src/license.rs`. That test is the guard that the Rust verifier and this
signer agree byte-for-byte on the wire format.

## Machine id

The app identifies a machine with the OS install id — Windows `MachineGuid`, macOS
`IOPlatformUUID` (`ioreg`), Linux `/etc/machine-id` — and falls back to a one-time random id
stored next to the license file. Reinstalling the app keeps the same id; reinstalling Windows /
wiping the OS changes it (a normal cause of "activated on another computer"; deactivate the old
id and reactivate).

## Legal and distribution

- The app is Apache-2.0. You may sell a modified build, but you must **keep the license and
  attribution notices** (upstream project and its own fork source, per the repo `LICENSE` /
  README credits) and you cannot use branding that implies YouTube/Google endorsement. Renaming
  the product is your call; `PRODUCT_ID`, `tauri.conf.json` (`productName`, `identifier`) and
  the activation-screen brand text are the places to touch.
- **Point the auto-updater at your own releases.** `src-tauri/tauri.conf.json` currently
  points `updater.endpoints` at the upstream GitHub repo, and the minisign `pubkey` is
  upstream's. If you ship that as-is, paid users silently update to the free upstream build (or
  fail signature checks). Either host your own signed artifacts + `latest.json` with your own
  minisign keypair, or disable the updater plugin in your fork.
- **YouTube/Google**: selling a YouTube Music *client* is what upstream does free; make sure
  your store listing and marketing don't claim affiliation with Google or YouTube.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `The license signature is invalid.` | Embedded `LICENSE_PUBLIC_KEY_B64` does not match the server's keypair. Regenerate one side or the other. |
| `Could not reach the license server` | Server down, `HOST`/`PORT` wrong, or not https in a release build. |
| `already activated on the maximum number of computers` | Old activation on another machine; `deactivate` it (see above). |
| Key works on one machine only | That is the default (`maxDevices 1`); issue with `--max-devices N` for more. |
| Buyer reinstalled the OS | New machine id → looks like a different computer; deactivate the old id. |
| `cargo test license` fails on the fixture | The embedded key changed without regenerating `print-fixture`. |
| Data loss | Back up `licensing/data/licenses.json`; losing it invalidates every key. |
