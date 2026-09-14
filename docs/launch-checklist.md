# Soundbox launch checklist

One page, four gates. ✅ = done and verified · ☐ = outstanding.
Runbooks: `licensing/README.md` (license server, webhook, Fly.io deploy) · `docs/release-notes-v1.4.0.md`.

## 1. Repo

- ✅ GitHub repo `Dami1233/soundbox` created **public** — the updater's `raw.githubusercontent.com` / `releases/latest/download` endpoints are unauthenticated, so private would silently break updates
- ✅ Full history on `main` (unshallowed from the fork's shallow clone; upstream: noFAYZ/zuno)
- ✅ `soundbox` remote configured locally; versions consistent at 1.4.0 across `package.json` / `tauri.conf.json` / `Cargo.toml`
- ☐ Branch protection on `main` (require green CI before merge)
- ☐ Repo description + topics before going public

## 2. Secrets

- ✅ `TAURI_SIGNING_PRIVATE_KEY` repo secret set (minisign key `~/.tauri/soundbox-updater.key`, empty password — deliberately **no** `*_PASSWORD` secret)
- ✅ Public half embedded in `src-tauri/tauri.conf.json` matches the secret (keyId `dfdb5b3b55419d17`, proven by verifying the CI-built MSI signature)
- ✅ `ADMIN_TOKEN` — strong random token for the license server; set via `fly secrets set`, copy kept outside the repo (never in git)
- ☐ `LS_API_KEY` — only if the webhook should email keys to buyers (`licensing/webhook.mjs`)
- ☐ `WINGET_IDENTIFIER` — optional; unset = the winget job auto-skips (current behavior)
- ☐ Final sweep: no keys/tokens/`.env*` committed

## 3. First release (v1.4.0)

- ✅ Tag `v1.4.0` pushed → release workflow green: Windows, macOS (arm64 + Intel), Linux, updater-channel mirror; winget skipped as designed
- ✅ Release assets complete: installers + `.sig` + `latest.json` (17 assets)
- ✅ CI signature verified against the embedded pubkey (minisign pre-hashed "ED" mode — via `minisign-verify`, the same crate the updater uses)
- ✅ Release body filled from `docs/release-notes-v1.4.0.md`
- ☐ Install the CI-built MSI → Settings → Check for updates → expect "You are up to date."

## 4. Go-public gates (blockers before announcing)

- ✅ License server live: Fly.io app `soundbox-license` at `https://soundbox-license.fly.dev` (deployed 2026-09-14; runbook + Windows flyctl field notes in `licensing/README.md`)
- ✅ **Server db seeded with the production keypair** — remote key verified byte-identical to the embedded `LICENSE_PUBLIC_KEY_B64`; a real activation envelope was issued by prod and verified against the embedded key (smoke key issued → activated → revoked)
- ✅ `ADMIN_TOKEN` set on the server (copy stored outside the repo); admin routes verified 401 without it
- ✅ Store link live: `LICENSE_PURCHASE_URL` → `https://milodami.lemonsqueezy.com/checkout/buy/83c11491-…` (in `src/internal/license.ts`; linked from the activation screen) — note: the shipped v1.4.0 binary still has the old placeholder; the real link rides the next release
- ☐ Create the Lemon Squeezy product; add its webhook (`order_created`) with the signing secret → `licensing/webhook.mjs` behind TLS
- ☐ Buy a real key through the store → activate it in the packaged app (proves the whole chain end-to-end)
- ☐ Compiled default `LICENSE_SERVER_URL` = `https://soundbox-license.fly.dev` — deploy must land at that exact URL (this diff)
- ☐ Windows Authenticode certificate — unsigned MSIs trigger SmartScreen warnings; strongly recommended before wide distribution
- ☐ macOS notarization — unsigned builds require right-click → Open on macOS
- ☐ Last sweep: `grep -r "buy-soundbox" src/ docs/` returns nothing (plain `example.com` also matches intentional test fixtures)
