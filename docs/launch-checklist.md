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
- ☐ `ADMIN_TOKEN` — strong random token for the license server; set at deploy time, never in git
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

- ☐ Deploy the license server: Fly.io app `soundbox-license` (`licensing/fly.toml` + `Dockerfile`) — runbook in `licensing/README.md`
- ☐ **Seed the server db with the existing keypair** — an empty volume makes the server mint a *new* keypair whose public key won't match the one embedded in released apps → every activation fails
- ☐ Set `ADMIN_TOKEN` on the server; smoke-test issue → activate → revoke against prod (pattern: `licensing/smoke-test.mjs`)
- ☐ Replace the store placeholder `https://example.com/buy-soundbox` in `src/ui/links.ts` and the release notes with the real Lemon Squeezy checkout URL
- ☐ Create the Lemon Squeezy product; add its webhook (`order_created`) with the signing secret → `licensing/webhook.mjs` behind TLS
- ☐ Buy a real key through the store → activate it in the packaged app (proves the whole chain end-to-end)
- ☐ Compiled default `LICENSE_SERVER_URL` = `https://soundbox-license.fly.dev` — deploy must land at that exact URL (this diff)
- ☐ Windows Authenticode certificate — unsigned MSIs trigger SmartScreen warnings; strongly recommended before wide distribution
- ☐ macOS notarization — unsigned builds require right-click → Open on macOS
- ☐ Last sweep: `grep -r "example.com" src/ docs/` returns nothing
