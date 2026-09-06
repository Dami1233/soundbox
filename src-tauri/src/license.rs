/*
 * Licensing — the paid activation gate.
 *
 * Flow, end to end:
 *
 *   Seller side (see licensing/README.md, licensing/server.mjs, licensing/cli.mjs):
 *     - `node licensing/cli.mjs generate-keys` mints an Ed25519 keypair. The raw public
 *       key is pasted into LICENSE_PUBLIC_KEY_B64 below; the private key stays on the
 *       seller's license server and is never shipped.
 *     - `node licensing/cli.mjs issue ...` mints a product key the seller sells.
 *
 *   Client side (this file):
 *     - First launch offers a 7-day trial (`license_start_trial`). No network needed.
 *     - The buyer enters their key (`license_activate`). The app POSTs
 *       { product, key, machineId, appVersion } to the seller's server, which answers with
 *       a signed license envelope or a refusal. The envelope is Ed25519-signed by the
 *       server's private key and carries the machineId the server bound the key to.
 *     - The app verifies the signature against LICENSE_PUBLIC_KEY_B64 *before* trusting
 *       anything, then persists the envelope next to the settings file.
 *     - Every launch, `license_status` re-verifies the stored envelope locally: signature,
 *       product id, machine binding and expiry. No network at launch, so an activated copy
 *       keeps working offline.
 *
 * What this does and does not enforce: it gates honest installs. The frontend shows the
 * activation screen until `license_status` reports an unlocked state, and the server limits
 * how many machines one key activates. Because the source is public, a determined user can
 * always patch the client — every seller of an open-source app accepts that; what the
 * signature scheme guarantees is that no one can mint a key without the seller's private
 * key, and no one can alter a stored license without breaking it.
 *
 * Debug builds skip the gate (activate as a "development" license) so day-to-day `tauri dev`
 * work is unaffected. Set SOUNDBOX_LICENSE_ENFORCE=1 to exercise the real gate in a debug build.
 */

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_compact::{PublicKey, Signature};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

/// Must match the product id the seller's server stamps into licenses. Bump both together if
/// you rename the product.
pub const PRODUCT_ID: &str = "soundbox-desktop";

/*
 * The seller's license server. Change to your own host before shipping a release build.
 *
 *   - Release builds read this constant.
 *   - SOUNDBOX_LICENSE_SERVER overrides it at runtime (useful for pointing a build at a staging
 *     server without recompiling; harmless in release, since the server can only hand out
 *     licenses signed by the private key that matches LICENSE_PUBLIC_KEY_B64 below).
 */
pub const LICENSE_SERVER_URL: &str = "https://licenses.example.com";

/*
 * The Ed25519 public key (raw 32 bytes, standard base64) that signs every license.
 *
 * Generated once with:
 *
 *     node licensing/cli.mjs generate-keys
 *
 * The command prints this value; paste it here. The matching private key must live ONLY on
 * the license server you run — never in a build, never in a repo.
 */
pub const LICENSE_PUBLIC_KEY_B64: &str = "juhBRXePOxFG+XvHRLfVOw6ECz7wnzoTr5+DReTNhyI=";

const LICENSE_FILE_NAME: &str = "license-v1.json";
const TRIAL_FILE_NAME: &str = "trial-v1.json";
const FALLBACK_MACHINE_ID_FILE_NAME: &str = "machine-id-v1";
const TRIAL_DURATION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Serialises writes to the license/trial files, mirroring CacheLock/AppSettingsLock.
pub struct LicenseLock(pub Mutex<()>);

// ---------------------------------------------------------------------------
// Wire + stored shapes
// ---------------------------------------------------------------------------

/// What the server stamps a license with. Signed as exact JSON text, so field order in the
/// payload string matters only to the signer; parsing is order-independent.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LicensePayload {
    product: String,
    key: String,
    #[serde(default)]
    licensee: Option<String>,
    #[serde(default)]
    plan: Option<String>,
    machine_id: String,
    issued_at_ms: u64,
    #[serde(default)]
    expires_at_ms: Option<u64>,
}

/// The signed envelope the server returns and the app stores.
#[derive(Serialize, Deserialize)]
struct LicenseEnvelope {
    /// The exact bytes that were signed — the JSON text of the payload.
    payload: String,
    /// Ed25519 signature over `payload` (raw 64 bytes, standard base64).
    sig: String,
}

#[derive(Serialize, Deserialize)]
struct StoredLicense {
    envelope: LicenseEnvelope,
}

#[derive(Serialize, Deserialize)]
struct TrialState {
    started_at_ms: u64,
}

/// What the frontend needs to decide what to show. `state` is one of:
///   activated | trial | trialExpired | expired | wrongMachine | unactivated
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatusView {
    state: &'static str,
    product: &'static str,
    server_url: String,
    trial_days_left: Option<u64>,
    licensee: Option<String>,
    plan: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivationRequest {
    product: String,
    key: String,
    machine_id: String,
    app_version: String,
}

#[derive(Deserialize)]
struct ActivationResponse {
    ok: bool,
    license: Option<LicenseEnvelope>,
    error: Option<String>,
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn write_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("could not create the app data directory: {error}"))?;
    }
    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, content)
        .map_err(|error| format!("could not write a temporary file: {error}"))?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("could not replace an existing file: {error}"))?;
    }
    fs::rename(&temp_path, path).map_err(|error| format!("could not save the file: {error}"))
}

fn license_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(LICENSE_FILE_NAME))
        .map_err(|error| format!("the application data directory is unavailable: {error}"))
}

fn trial_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(TRIAL_FILE_NAME))
        .map_err(|error| format!("the application data directory is unavailable: {error}"))
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

// ---------------------------------------------------------------------------
// Machine identity
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn os_machine_id() -> Option<String> {
    // MachineGuid is created at Windows install time and survives reinstalls of the app.
    let output = std::process::Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().find_map(|line| {
        let index = line.find("REG_SZ")?;
        let value = line[index + "REG_SZ".len()..].trim().trim_matches('"');
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    })
}

#[cfg(target_os = "macos")]
fn os_machine_id() -> Option<String> {
    let output = std::process::Command::new("/usr/sbin/ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().rev().find_map(|line| {
        if !line.contains("IOPlatformUUID") {
            return None;
        }
        let equals = line.find('=')?;
        let value = line[equals + 1..].trim().trim_matches('"').trim();
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    })
}

#[cfg(target_os = "linux")]
fn os_machine_id() -> Option<String> {
    for candidate in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(bytes) = fs::read_to_string(candidate) {
            let id = bytes.trim();
            if !id.is_empty() {
                return Some(id.to_string());
            }
        }
    }
    None
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn os_machine_id() -> Option<String> {
    None
}

/// A stable per-machine id: the OS install id where one exists, otherwise a random id we
/// generate once and persist next to the license file (containers, unusual setups, …).
fn machine_id(app: &AppHandle) -> String {
    if let Some(id) = os_machine_id() {
        if !id.trim().is_empty() {
            return id;
        }
    }

    let fallback_path = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(FALLBACK_MACHINE_ID_FILE_NAME));
    if let Some(path) = &fallback_path {
        if let Ok(existing) = fs::read_to_string(path) {
            let existing = existing.trim();
            if !existing.is_empty() {
                return existing.to_string();
            }
        }
    }

    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let id: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    if let Some(path) = &fallback_path {
        let _ = write_atomic(path, id.as_bytes());
    }
    id
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/// Verify the envelope's signature against a specific public key and parse the payload.
/// Split out so tests can use an in-test keypair instead of the embedded one.
fn verify_signature_with_key(
    public_key_b64: &str,
    envelope: &LicenseEnvelope,
) -> Result<LicensePayload, String> {
    let public_bytes = STANDARD
        .decode(public_key_b64)
        .map_err(|_| "the embedded license key is invalid.".to_string())?;
    let public_key = PublicKey::from_slice(&public_bytes)
        .map_err(|_| "the embedded license key is invalid.".to_string())?;
    let signature_bytes = STANDARD
        .decode(&envelope.sig)
        .map_err(|_| "the license signature is unreadable.".to_string())?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| "the license signature is unreadable.".to_string())?;
    public_key
        .verify(envelope.payload.as_bytes(), &signature)
        .map_err(|_| "the license signature is invalid.".to_string())?;
    serde_json::from_str(&envelope.payload)
        .map_err(|_| "the license payload is unreadable.".to_string())
}

fn verify_signature(envelope: &LicenseEnvelope) -> Result<LicensePayload, String> {
    verify_signature_with_key(LICENSE_PUBLIC_KEY_B64, envelope)
}

/// Product, machine and expiry checks on an already-verified payload.
fn license_matches(payload: &LicensePayload, expected_machine_id: &str) -> Result<(), String> {
    if payload.product != PRODUCT_ID {
        return Err("this license was issued for a different product.".to_string());
    }
    if payload.machine_id != expected_machine_id {
        return Err("this license is locked to a different computer.".to_string());
    }
    if payload.expires_at_ms.is_some_and(|expires_at| expires_at < now_ms()) {
        return Err("this license has expired.".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Trial
// ---------------------------------------------------------------------------

fn trial_remaining_days(started_at_ms: u64) -> Option<u64> {
    let deadline = started_at_ms.checked_add(TRIAL_DURATION.as_millis() as u64)?;
    let now = now_ms();
    if now >= deadline {
        return None;
    }
    let day_ms: u64 = 24 * 60 * 60 * 1000;
    Some((deadline - now + day_ms - 1) / day_ms)
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct LicenseEvaluation {
    state: &'static str,
    trial_days_left: Option<u64>,
    licensee: Option<String>,
    plan: Option<String>,
}

fn dev_evaluation() -> LicenseEvaluation {
    LicenseEvaluation {
        state: "activated",
        trial_days_left: None,
        licensee: Some("Development build".to_string()),
        plan: Some("development".to_string()),
    }
}

fn evaluate(app: &AppHandle) -> Result<LicenseEvaluation, String> {
    if !gating_enabled() {
        return Ok(dev_evaluation());
    }

    let stored: Option<StoredLicense> = license_path(app).ok().and_then(|path| read_json(&path));
    if let Some(stored) = stored {
        // Only resolve the machine id when a stored license needs checking against it — the
        // lookup can spawn a subprocess, which trial-only installs never need.
        let machine = machine_id(app);
        match verify_signature(&stored.envelope) {
            Ok(payload) => match license_matches(&payload, &machine) {
                Ok(()) => {
                    return Ok(LicenseEvaluation {
                        state: "activated",
                        trial_days_left: None,
                        licensee: payload.licensee.clone(),
                        plan: payload.plan.clone(),
                    });
                }
                // A license that doesn't match this machine is a distinct situation worth
                // telling the user about ("locked to another computer"), not a silent reset.
                Err(error) if error.contains("different computer") => {
                    return Ok(LicenseEvaluation {
                        state: "wrongMachine",
                        trial_days_left: None,
                        licensee: None,
                        plan: None,
                    });
                }
                Err(error) if error.contains("has expired") => {
                    return Ok(LicenseEvaluation {
                        state: "expired",
                        trial_days_left: None,
                        licensee: None,
                        plan: None,
                    });
                }
                // Wrong product / broken payload / bad signature: fall through to the
                // unactivated path — an honest user is simply not activated.
                Err(_) => {}
            },
            Err(_) => {}
        }
    }

    let trial: Option<TrialState> = trial_path(app).ok().and_then(|path| read_json(&path));
    match trial {
        Some(trial) => match trial_remaining_days(trial.started_at_ms) {
            Some(days) => Ok(LicenseEvaluation {
                state: "trial",
                trial_days_left: Some(days),
                licensee: None,
                plan: None,
            }),
            None => Ok(LicenseEvaluation {
                state: "trialExpired",
                trial_days_left: None,
                licensee: None,
                plan: None,
            }),
        },
        None => Ok(LicenseEvaluation {
            state: "unactivated",
            trial_days_left: None,
            licensee: None,
            plan: None,
        }),
    }
}

fn status_view(evaluation: &LicenseEvaluation) -> LicenseStatusView {
    LicenseStatusView {
        state: evaluation.state,
        product: PRODUCT_ID,
        server_url: license_server_url(),
        trial_days_left: evaluation.trial_days_left,
        licensee: evaluation.licensee.clone(),
        plan: evaluation.plan.clone(),
    }
}

// ---------------------------------------------------------------------------
// Server communication
// ---------------------------------------------------------------------------

fn license_server_url() -> String {
    std::env::var("SOUNDBOX_LICENSE_SERVER")
        .unwrap_or_else(|_| LICENSE_SERVER_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

/// Debug builds skip the gate unless SOUNDBOX_LICENSE_ENFORCE=1; release builds always gate.
fn gating_enabled() -> bool {
    if cfg!(debug_assertions) {
        std::env::var("SOUNDBOX_LICENSE_ENFORCE")
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    } else {
        true
    }
}

fn normalize_key(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_uppercase())
        .collect()
}

fn describe_network_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "The license server did not answer in time. Check your connection and try again."
            .to_string()
    } else if error.is_connect() {
        "Could not reach the license server. Check your connection and try again.".to_string()
    } else {
        format!("Could not reach the license server: {error}")
    }
}

fn describe_server_error(code: Option<&str>) -> String {
    match code {
        Some("INVALID_KEY") => {
            "That license key is not recognised. Double-check it and try again.".to_string()
        }
        Some("REVOKED") => {
            "That license key has been revoked. If you think this is a mistake, contact support."
                .to_string()
        }
        Some("LIMIT_REACHED") => {
            "This license key is already activated on the maximum number of computers. "
                .to_string()
                + "Deactivate another machine first, or contact support."
        }
        Some("EXPIRED") => "That license key has expired.".to_string(),
        Some(other) => format!("The license server refused this key ({other})."),
        None => "The license server refused this key.".to_string(),
    }
}

async fn post_activate(key: &str, machine: &str) -> Result<ActivationResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("could not create the HTTP client: {error}"))?;

    let body = ActivationRequest {
        product: PRODUCT_ID.to_string(),
        key: key.to_string(),
        machine_id: machine.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    };

    let response = client
        .post(format!("{}/activate", license_server_url()))
        .json(&body)
        .send()
        .await
        .map_err(|error| describe_network_error(&error))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("could not read the license server response: {error}"))?;

    if status.is_server_error() {
        return Err(format!(
            "The license server had a problem (HTTP {status}). Try again shortly."
        ));
    }

    serde_json::from_str(&text)
        .map_err(|_| "The license server returned an unreadable response.".to_string())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn license_status(app: AppHandle) -> Result<LicenseStatusView, String> {
    let evaluation = evaluate(&app)?;
    Ok(status_view(&evaluation))
}

#[tauri::command]
pub fn license_start_trial(
    app: AppHandle,
    lock: State<'_, LicenseLock>,
) -> Result<LicenseStatusView, String> {
    if !gating_enabled() {
        return Ok(status_view(&dev_evaluation()));
    }

    let current = evaluate(&app)?;
    match current.state {
        "trial" | "activated" => Ok(status_view(&current)),
        "trialExpired" => Err(
            "Your free trial has already ended. Enter a license key to continue using Soundbox."
                .to_string(),
        ),
        "expired" | "wrongMachine" => Err(
            "Your copy of Soundbox is already tied to a license. Enter that key to continue."
                .to_string(),
        ),
        _ => {
            let _guard = lock
                .0
                .lock()
                .map_err(|_| "Licensing is busy right now. Try again.".to_string())?;
            let path = trial_path(&app)?;
            let state = TrialState {
                started_at_ms: now_ms(),
            };
            let bytes = serde_json::to_vec(&state)
                .map_err(|error| format!("could not record the trial start: {error}"))?;
            write_atomic(&path, &bytes)?;
            eprintln!("[internal][license][info] trial started");
            let evaluation = evaluate(&app)?;
            Ok(status_view(&evaluation))
        }
    }
}

#[tauri::command]
pub async fn license_activate(
    app: AppHandle,
    lock: State<'_, LicenseLock>,
    key: String,
) -> Result<LicenseStatusView, String> {
    if !gating_enabled() {
        return Ok(status_view(&dev_evaluation()));
    }

    let machine = machine_id(&app);
    let normalized = normalize_key(&key);
    eprintln!(
        "[internal][license][info] activation requested machine={} chars={}",
        machine,
        normalized.len()
    );

    let response = post_activate(&normalized, &machine).await?;
    if !response.ok {
        return Err(describe_server_error(response.error.as_deref()));
    }

    let envelope = response
        .license
        .ok_or_else(|| "The license server returned an empty response.".to_string())?;
    let payload = verify_signature(&envelope)?;
    license_matches(&payload, &machine)?;

    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Licensing is busy right now. Try again.".to_string())?;
    let path = license_path(&app)?;
    let stored = StoredLicense { envelope };
    let bytes = serde_json::to_vec(&stored)
        .map_err(|error| format!("could not save the license: {error}"))?;
    write_atomic(&path, &bytes)?;
    eprintln!("[internal][license][info] activation succeeded machine={machine}");

    Ok(status_view(&LicenseEvaluation {
        state: "activated",
        trial_days_left: None,
        licensee: payload.licensee.clone(),
        plan: payload.plan.clone(),
    }))
}

/// Local-only reset (for development and for moving a license to another machine). The server
/// keeps the old activation record; see `node licensing/cli.mjs revoke`.
#[tauri::command]
pub fn license_reset(app: AppHandle, lock: State<'_, LicenseLock>) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Licensing is busy right now. Try again.".to_string())?;
    for path in [license_path(&app), trial_path(&app)] {
        if let Ok(path) = path {
            let _ = fs::remove_file(path);
        }
    }
    eprintln!("[internal][license][info] local license reset");
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;

    /// A fixed test seed; the matching public key is derived from it below. Never ship a
    /// signing key inside the binary — tests only.
    const TEST_SEED: [u8; 32] = [7u8; 32];

    fn test_key_pair() -> ed25519_compact::KeyPair {
        let seed = ed25519_compact::Seed::from_slice(&TEST_SEED).unwrap();
        ed25519_compact::KeyPair::from_seed(seed)
    }

    fn test_public_key_b64() -> String {
        let key_pair = test_key_pair();
        // PublicKey derefs to its raw [u8; 32].
        STANDARD.encode(*key_pair.pk)
    }

    fn test_envelope(
        machine_id: &str,
        product: &str,
        expires_at_ms: Option<u64>,
    ) -> LicenseEnvelope {
        let payload = LicensePayload {
            product: product.to_string(),
            key: "TEST-1234".to_string(),
            licensee: None,
            plan: Some("perpetual".to_string()),
            machine_id: machine_id.to_string(),
            issued_at_ms: 1_700_000_000_000,
            expires_at_ms,
        };
        let payload_text = serde_json::to_string(&payload).unwrap();
        let key_pair = test_key_pair();
        // Deterministic (noise = None); randomness is irrelevant for a fixed test seed.
        let signature = key_pair.sk.sign(payload_text.as_bytes(), None);
        LicenseEnvelope {
            payload: payload_text,
            sig: STANDARD.encode(signature.as_ref()),
        }
    }

    #[test]
    fn signed_envelope_verifies_and_parses() {
        let envelope = test_envelope("machine-a", PRODUCT_ID, None);
        let payload = verify_signature_with_key(&test_public_key_b64(), &envelope).unwrap();
        assert_eq!(payload.key, "TEST-1234");
        assert_eq!(payload.plan.as_deref(), Some("perpetual"));
        assert!(license_matches(&payload, "machine-a").is_ok());
    }

    #[test]
    fn tampered_payload_fails_verification() {
        let mut envelope = test_envelope("machine-a", PRODUCT_ID, None);
        envelope.payload = envelope.payload.replace("TEST-1234", "TEST-9999");
        assert!(verify_signature_with_key(&test_public_key_b64(), &envelope).is_err());
    }

    #[test]
    fn signature_from_a_different_key_fails() {
        let envelope = test_envelope("machine-a", PRODUCT_ID, None);
        let other_public_key = STANDARD.encode([9u8; 32]);
        assert!(verify_signature_with_key(&other_public_key, &envelope).is_err());
    }

    #[test]
    fn license_is_bound_to_its_machine() {
        let envelope = test_envelope("machine-a", PRODUCT_ID, None);
        let payload = verify_signature_with_key(&test_public_key_b64(), &envelope).unwrap();
        assert!(license_matches(&payload, "machine-a").is_ok());
        assert!(license_matches(&payload, "machine-b").is_err());
    }

    #[test]
    fn license_for_another_product_is_rejected() {
        let envelope = test_envelope("machine-a", "some-other-app", None);
        let payload = verify_signature_with_key(&test_public_key_b64(), &envelope).unwrap();
        assert!(license_matches(&payload, "machine-a").is_err());
    }

    #[test]
    fn an_expired_license_is_rejected() {
        let envelope = test_envelope("machine-a", PRODUCT_ID, Some(1_000));
        let payload = verify_signature_with_key(&test_public_key_b64(), &envelope).unwrap();
        assert!(license_matches(&payload, "machine-a").is_err());
    }

    #[test]
    fn keys_normalize_case_and_separators() {
        assert_eq!(
            normalize_key("abcd-efgh-ijkl-mnop"),
            "ABCDEFGHIJKLMNOP"
        );
        assert_eq!(normalize_key(" a1b2 c3d4 "), "A1B2C3D4");
    }

    /*
     * Wire-format interop fixture: this payload was signed by a real Ed25519 key (OpenSSL /
     * Node `crypto.sign`, the same standard algorithm licensing/server.mjs uses) whose public
     * key is LICENSE_PUBLIC_KEY_B64 above. If the embedded public key is ever regenerated,
     * regenerate this fixture with:
     *
     *     node licensing/cli.mjs print-fixture
     *
     * and paste the output here. The test exists so a change to either side of the wire
     * contract (envelope shape, base64 encoding, signing input) fails in CI instead of on a
     * paying customer's machine.
     */
    #[test]
    fn verifies_a_license_signed_by_the_server_keypair() {
        let envelope = LicenseEnvelope {
            payload: "{\"product\":\"soundbox-desktop\",\"key\":\"ABCD-EFGH-JKLM-NOPQ\",\"licensee\":null,\"plan\":\"perpetual\",\"machineId\":\"test-machine\",\"issuedAtMs\":1750000000000,\"expiresAtMs\":null}".to_string(),
            sig: "UDhGoylLppOFfhqKOs9stRC7snMe7mxctZN9J0+mbaMk4nlFkHCl1K/514tIMh6On7aqgx3WXkrp4A7t/bjeDw==".to_string(),
        };
        let payload = verify_signature(&envelope).expect("server-signed fixture must verify");
        assert_eq!(payload.key, "ABCD-EFGH-JKLM-NOPQ");
        assert!(license_matches(&payload, "test-machine").is_ok());
    }
}
