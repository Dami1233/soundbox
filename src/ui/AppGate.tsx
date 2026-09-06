/*
 * The startup gate.
 *
 * In debug builds the Rust side reports "activated (development)" immediately, so this
 * renders <App/> right away. In release builds the app stays behind the ActivationScreen
 * until a trial is started or a license key verifies — the state comes from Rust
 * (src-tauri/src/license.rs) and cannot be unlocked by editing webview storage.
 */
import { useCallback, useEffect, useState } from "react";
import App from "./App";
import { ActivationScreen } from "./components/ActivationScreen";
import { AppLoadingScreen } from "./components/AppLoadingScreen";
import {
  getLicenseStatus,
  isLicenseUnlocked,
  type LicenseStatus,
} from "../internal/license";

function describeFailure(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function ActivationGate() {
  const [checking, setChecking] = useState(true);
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setChecking(true);
    setFailure(null);
    getLicenseStatus()
      .then((next) => setStatus(next))
      .catch((error) => setFailure(describeFailure(error)))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (checking) {
    return <AppLoadingScreen isLeaving={false} />;
  }

  if (failure || status === null) {
    return (
      <div className="fixed inset-0 grid place-items-center bg-background px-6 text-foreground">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <h1 className="text-xl font-bold">Could not check your license</h1>
          <p className="text-sm text-muted-foreground">{failure ?? "The license check returned nothing."}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!isLicenseUnlocked(status)) {
    return <ActivationScreen status={status} onStatus={setStatus} />;
  }

  return <App />;
}
