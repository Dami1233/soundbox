/*
 * The pre-activation lock screen.
 *
 * Rendered by ActivationGate whenever `license_status` reports anything but "activated" /
 * "trial". It is deliberately self-contained: it cannot reach the rest of the app, so it
 * only needs the window chrome, a trial call-to-action and the license key entry.
 */
import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { KeyIcon } from "@/ui/icons";
import { useNativeWindowControls } from "../settings/windowControls";
import { logInternalError } from "../../internal/logging";
import {
  LICENSE_PURCHASE_URL,
  LICENSE_SUPPORT_EMAIL,
  activateLicense,
  startLicenseTrial,
  type LicenseStatus,
} from "../../internal/license";

const KEY_GROUPS = 4;
const KEY_GROUP_LENGTH = 4;

/** "abcd-efgh-ijkl-mnop" style grouping while typing; caps and strips anything else. */
function formatKeyInput(raw: string): string {
  const clean = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, KEY_GROUPS * KEY_GROUP_LENGTH);
  const groups = clean.match(new RegExp(`.{1,${KEY_GROUP_LENGTH}}`, "g")) ?? [];
  return groups.join("-");
}

function describeState(status: LicenseStatus): { title: string; body: string } {
  switch (status.state) {
    case "unactivated":
      return {
        title: "Activate Soundbox",
        body: "This copy of Soundbox has not been activated yet. Start the 7-day free trial, or enter the license key you bought.",
      };
    case "trial":
      return {
        title: "Trial in progress",
        body: `You have ${status.trialDaysLeft ?? 0} day${(status.trialDaysLeft ?? 0) === 1 ? "" : "s"} left in your free trial. Enter your license key now or when the trial ends.`,
      };
    case "trialExpired":
      return {
        title: "Your free trial has ended",
        body: "Thanks for trying Soundbox. Enter the license key you bought to keep listening.",
      };
    case "expired":
      return {
        title: "This license has expired",
        body: "Enter a valid license key to continue using Soundbox.",
      };
    case "wrongMachine":
      return {
        title: "Activated on another computer",
        body: "This copy of Soundbox is activated on a different machine. If you recently reinstalled or upgraded this computer, deactivate the old machine and activate this one again.",
      };
    case "activated":
      return {
        title: "Soundbox is ready",
        body: "Your license is valid. Enjoy the music.",
      };
  }
}

interface ActivationScreenProps {
  status: LicenseStatus;
  /** Called with the fresh status after a trial starts or a key activates. */
  onStatus: (status: LicenseStatus) => void;
}

export function ActivationScreen({ status, onStatus }: ActivationScreenProps) {
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nativeWindowControls = useNativeWindowControls();
  const appWindow = getCurrentWindow();
  const copy = describeState(status);
  const keyComplete = keyInput.replace(/-/g, "").length === KEY_GROUPS * KEY_GROUP_LENGTH;

  const startWindowDrag = async () => {
    try {
      await appWindow.startDragging();
    } catch (dragError) {
      // Native window decorations handle dragging themselves; ignore.
      logInternalError("ActivationScreen.startWindowDrag failed", dragError);
    }
  };

  const handleMinimize = async () => {
    try {
      await appWindow.minimize();
    } catch (minimizeError) {
      logInternalError("ActivationScreen.minimize failed", minimizeError);
    }
  };

  const handleClose = () => {
    void invoke("quit_app").catch((closeError) => {
      logInternalError("ActivationScreen.quit_app failed", closeError);
      void appWindow.close();
    });
  };

  const handleActivate = async () => {
    if (busy || !keyComplete) return;
    setBusy(true);
    setError(null);
    try {
      const next = await activateLicense(keyInput);
      onStatus(next);
    } catch (activateError) {
      setError(
        typeof activateError === "string"
          ? activateError
          : activateError instanceof Error
            ? activateError.message
            : String(activateError),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleStartTrial = async () => {
    if (busy || status.state !== "unactivated") return;
    setBusy(true);
    setError(null);
    try {
      const next = await startLicenseTrial();
      onStatus(next);
    } catch (trialError) {
      setError(
        typeof trialError === "string"
          ? trialError
          : trialError instanceof Error
            ? trialError.message
            : String(trialError),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 flex flex-col bg-background text-foreground">
      {/* Minimal window chrome: brand on the left, drag region, window buttons. */}
      <div className="relative z-30 flex h-[var(--titlebar-height)] shrink-0 items-center gap-2 bg-background px-3">
        <div className="flex shrink-0 items-center gap-2 px-1" aria-label="Soundbox">
          <span className="size-2.5 rounded-full bg-primary" aria-hidden="true" />
          <span className="text-sm font-bold">Soundbox</span>
        </div>
        <div
          className="min-w-6 flex-1 self-stretch"
          aria-label="Drag window"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            void startWindowDrag();
          }}
          onDoubleClick={() => {
            if (!nativeWindowControls) {
              void appWindow.toggleMaximize().catch(() => {});
            }
          }}
        />
        {!nativeWindowControls && (
          <div className="flex shrink-0 items-center gap-1.5 px-2" aria-label="Window controls">
            <button
              type="button"
              aria-label="Minimize"
              className="grid size-3 place-items-center rounded-full bg-muted-foreground/40 transition-colors hover:bg-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => void handleMinimize()}
            />
            <button
              type="button"
              aria-label="Close"
              className="grid size-3 place-items-center rounded-full bg-muted-foreground/40 transition-colors hover:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={handleClose}
            />
          </div>
        )}
      </div>

      {/* Lock content. */}
      <div className="grid flex-1 place-items-center overflow-y-auto px-6 py-10">
        <div className="w-full max-w-md">
          <div className="mb-6 flex flex-col items-center gap-3 text-center">
            <span
              className="grid size-14 place-items-center rounded-2xl bg-primary/15 text-primary"
              aria-hidden="true"
            >
              <KeyIcon className="size-7" />
            </span>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">{copy.title}</h1>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.body}</p>
            </div>
          </div>

          <div className="rounded-2xl bg-card p-6">
            {status.state === "unactivated" && (
              <div className="mb-5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleStartTrial()}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary/15 px-4 py-3 text-sm font-semibold text-primary transition-colors hover:bg-primary/25 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  Start my 7-day free trial
                </button>
              </div>
            )}

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleActivate();
              }}
              className="flex flex-col gap-3"
            >
              <label htmlFor="license-key" className="text-sm font-medium text-foreground">
                License key
              </label>
              <input
                id="license-key"
                type="text"
                autoFocus
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
                placeholder="XXXX-XXXX-XXXX-XXXX"
                value={keyInput}
                onChange={(event) => setKeyInput(formatKeyInput(event.target.value))}
                disabled={busy}
                aria-describedby={error ? "license-key-error" : undefined}
                className="rounded-xl border border-input bg-background px-3.5 py-2.5 font-mono text-sm tracking-widest text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={busy || !keyComplete}
                className="flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                {busy ? "Activating…" : "Activate"}
              </button>
              {error && (
                <p id="license-key-error" role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </form>

            <div className="mt-5 flex flex-col gap-1 border-t border-border pt-4 text-sm">
              <p className="text-muted-foreground">
                Don&apos;t have a license key yet?{" "}
                <button
                  type="button"
                  className="font-medium text-primary transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => void openUrl(LICENSE_PURCHASE_URL)}
                >
                  Buy Soundbox
                </button>
              </p>
              {LICENSE_SUPPORT_EMAIL && (
                <p className="text-muted-foreground/80">
                  Need help?{" "}
                  <a
                    href={`mailto:${LICENSE_SUPPORT_EMAIL}`}
                    className="font-medium text-primary transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {LICENSE_SUPPORT_EMAIL}
                  </a>
                </p>
              )}
            </div>
          </div>

          <p className="mt-5 text-center text-xs leading-relaxed text-muted-foreground/70">
            Soundbox only contacts the license server to activate a key and binds each license to a
            single computer. No usage data leaves this device.
          </p>
        </div>
      </div>
    </div>
  );
}
