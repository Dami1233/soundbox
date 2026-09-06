/*
 * Frontend half of the licensing gate. The authoritative state lives in Rust
 * (src-tauri/src/license.rs) — this module only mirrors whatever `license_status`
 * reports, so wiping localStorage can never unlock the app.
 */
import { invoke } from "@tauri-apps/api/core";

/** Where buyers purchase a key — point this at your store checkout before shipping. */
export const LICENSE_PURCHASE_URL = "https://example.com/buy-zuno";

/** Optional support address shown next to the purchase link; null hides it. */
export const LICENSE_SUPPORT_EMAIL: string | null = null;

export type LicenseState =
  | "activated"
  | "trial"
  | "trialExpired"
  | "expired"
  | "wrongMachine"
  | "unactivated";

export interface LicenseStatus {
  state: LicenseState;
  product: string;
  serverUrl: string;
  trialDaysLeft: number | null;
  licensee: string | null;
  plan: string | null;
}

export function isLicenseUnlocked(status: LicenseStatus | null): boolean {
  return status?.state === "activated" || status?.state === "trial";
}

export async function getLicenseStatus(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("license_status");
}

export async function activateLicense(key: string): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("license_activate", { key });
}

export async function startLicenseTrial(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("license_start_trial");
}
