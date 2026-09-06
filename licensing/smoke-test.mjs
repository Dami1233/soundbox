#!/usr/bin/env node
/*
 * One-command end-to-end smoke test for the whole licensing stack.
 *
 *   node licensing/smoke-test.mjs            # run from the zuno/ folder
 *   node licensing/smoke-test.mjs --keep     # keep the throwaway db + server logs on exit
 *
 * What it does:
 *   - creates a throwaway license database in the OS temp dir (fresh keypair)
 *   - boots a real license server on a random 127.0.0.1 port (no network access needed)
 *   - exercises the exact HTTP flows the desktop app uses: issue -> activate ->
 *     signature verification -> idempotent re-activation -> device limit ->
 *     invalid key -> expiry -> revocation -> deactivation -> re-activation
 *   - exits 0 only when every check passes
 *
 * It runs the real licensing/cli.mjs and licensing/server.mjs processes, so it verifies the
 * same code paths a production deployment runs — not a mocked copy of them.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { PRODUCT } from "./lib.mjs";

const LICENSING_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(LICENSING_DIR, "cli.mjs");
const SERVER = path.join(LICENSING_DIR, "server.mjs");
const keep = process.argv.includes("--keep");

if (!existsSync(CLI) || !existsSync(SERVER)) {
  console.error(`[smoke] can't find licensing/cli.mjs or licensing/server.mjs next to ${LICENSING_DIR}`);
  process.exit(1);
}

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function normalizeKey(raw) {
  return String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Public key (raw 32 bytes, standard base64) straight from the db file. */
function publicKeyRawB64(db) {
  const der = crypto.createPublicKey(db.keyPair.publicKeyPem).export({ type: "spki", format: "der" });
  return der.subarray(der.length - 32).toString("base64");
}

function runNode(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function request(port, route, { method = "GET", body, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? "" : JSON.stringify(body);
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(
      { host: "127.0.0.1", port, path: route, method, headers },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          let parsed = data;
          try {
            parsed = JSON.parse(data);
          } catch {
            // non-JSON body — keep raw text for diagnostics
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error(`request to ${route} timed out`)));
    req.on("error", reject);
    req.end(payload);
  });
}

async function waitForServer(port) {
  const deadline = Date.now() + 15000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await request(port, "/health");
      if (res.status === 200 && res.body.ok) return;
      lastError = new Error(`server up but /health returned ${res.status} ${JSON.stringify(res.body)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw lastError ?? new Error("server never became ready");
}

async function main() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "zuno-license-smoke-"));
  console.log(`[smoke] throwaway db: ${tmp}`);
  console.log(`[smoke] using ${CLI} and ${SERVER}\n`);

  let serverChild = null;
  let port = 0;
  try {
    // 1. keypair generation ------------------------------------------------
    console.log("[smoke] generate-keys");
    const gen = await runNode([CLI, "generate-keys"], { LICENSE_DATA_DIR: tmp });
    check("cli generate-keys exits 0", gen.code === 0, gen.err.trim());
    const dbFile = path.join(tmp, "licenses.json");
    check("licenses.json written", existsSync(dbFile));
    const db = JSON.parse(readFileSync(dbFile, "utf8"));
    const rawPubB64 = publicKeyRawB64(db);
    check("db product is zuno-desktop", db.product === PRODUCT, db.product);
    check("public key is 32 raw bytes (44-char base64)", rawPubB64.length === 44, rawPubB64);

    // 2. issue two keys -----------------------------------------------------
    console.log("[smoke] issue keys");
    const issued = await runNode([CLI, "issue", "--licensee", "smoke@test.dev", "--note", "smoke-test"], {
      LICENSE_DATA_DIR: tmp,
    });
    const keyMatch = /^Issued ([A-Z0-9-]+)$/m.exec(issued.out);
    check("cli issue prints a key", issued.code === 0 && !!keyMatch, issued.out + issued.err);
    const keyA = keyMatch?.[1];
    const issuedExp = await runNode([CLI, "issue", "--days", "1"], { LICENSE_DATA_DIR: tmp });
    const expMatch = /^Issued ([A-Z0-9-]+)$/m.exec(issuedExp.out);
    check("cli issue --days 1 prints a key", issuedExp.code === 0 && !!expMatch, issuedExp.out + issuedExp.err);

    // 3. boot the real server ----------------------------------------------
    port = await withTimeout(freePort(), 5000, "freePort");
    console.log(`[smoke] booting server on 127.0.0.1:${port}`);
    serverChild = spawn(process.execPath, [SERVER], {
      env: { ...process.env, LICENSE_DATA_DIR: tmp, PORT: String(port), HOST: "127.0.0.1", ADMIN_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let serverErr = "";
    serverChild.stderr.on("data", (d) => (serverErr += d));
    await withTimeout(waitForServer(port), 20000, "server boot");

    // 4. happy-path activation (what the app does on Activate) --------------
    console.log("[smoke] POST /activate — happy path");
    const actA = await request(port, "/activate", {
      method: "POST",
      body: { product: PRODUCT, key: keyA, machineId: "machine-A" },
    });
    check("activation succeeds", actA.status === 200 && actA.body.ok === true, JSON.stringify(actA.body));
    const payload = actA.body?.ok ? JSON.parse(actA.body.license.payload) : null;
    const sigOk =
      actA.body?.ok &&
      crypto.verify(
        null,
        Buffer.from(actA.body.license.payload, "utf8"),
        db.keyPair.publicKeyPem,
        Buffer.from(actA.body.license.sig, "base64"),
      );
    check("envelope signature verifies with the db public key", sigOk === true);
    check(
      "envelope binds product + machine + key",
      !!payload &&
        payload.product === PRODUCT &&
        payload.machineId === "machine-A" &&
        normalizeKey(payload.key) === normalizeKey(keyA),
      JSON.stringify(payload),
    );

    // 5. re-activating the same machine is idempotent ------------------------
    console.log("[smoke] POST /activate — same machine again");
    const actA2 = await request(port, "/activate", {
      method: "POST",
      body: { product: PRODUCT, key: keyA, machineId: "machine-A" },
    });
    check("re-activation of same machine succeeds", actA2.body?.ok === true, JSON.stringify(actA2.body));

    // 6. device limit --------------------------------------------------------
    console.log("[smoke] POST /activate — second machine");
    const actB = await request(port, "/activate", {
      method: "POST",
      body: { product: PRODUCT, key: keyA, machineId: "machine-B" },
    });
    check("second machine rejected with LIMIT_REACHED", actB.body?.error === "LIMIT_REACHED", JSON.stringify(actB.body));

    // 7. garbage key ---------------------------------------------------------
    console.log("[smoke] POST /activate — unknown key");
    const actBad = await request(port, "/activate", {
      method: "POST",
      body: { product: PRODUCT, key: "ZZZZ-ZZZZ-ZZZZ-ZZZZ", machineId: "machine-A" },
    });
    check("unknown key rejected with INVALID_KEY", actBad.body?.error === "INVALID_KEY", JSON.stringify(actBad.body));

    // 8. expiry --------------------------------------------------------------
    console.log("[smoke] POST /activate — expired key");
    const db2 = JSON.parse(readFileSync(dbFile, "utf8"));
    const expiredKey = db2.keys.find((k) => normalizeKey(k.id) === normalizeKey(expMatch?.[1]));
    expiredKey.expiresAtMs = Date.now() - 60_000; // backdate so it's already expired
    writeFileSync(dbFile, JSON.stringify(db2, null, 2));
    const actExp = await request(port, "/activate", {
      method: "POST",
      body: { product: PRODUCT, key: expMatch?.[1], machineId: "machine-A" },
    });
    check("expired key rejected with EXPIRED", actExp.body?.error === "EXPIRED", JSON.stringify(actExp.body));

    // 9. revocation ----------------------------------------------------------
    console.log("[smoke] revoke then activate");
    const revoked = await runNode([CLI, "revoke", keyA], { LICENSE_DATA_DIR: tmp });
    check("cli revoke exits 0", revoked.code === 0, revoked.err);
    const actRev = await request(port, "/activate", {
      method: "POST",
      body: { product: PRODUCT, key: keyA, machineId: "machine-A" },
    });
    check("revoked key rejected with REVOKED", actRev.body?.error === "REVOKED", JSON.stringify(actRev.body));

    // 10. unrevoke + deactivate + reactivate ----------------------------------
    console.log("[smoke] unrevoke, deactivate device, reactivate");
    const unrevoked = await runNode([CLI, "unrevoke", keyA], { LICENSE_DATA_DIR: tmp });
    check("cli unrevoke exits 0", unrevoked.code === 0, unrevoked.err);
    const deactivated = await runNode([CLI, "deactivate", keyA, "machine-A"], { LICENSE_DATA_DIR: tmp });
    check("cli deactivate exits 0", deactivated.code === 0, deactivated.err);
    const actA3 = await request(port, "/activate", {
      method: "POST",
      body: { product: PRODUCT, key: keyA, machineId: "machine-A" },
    });
    check("key works again after unrevoke + deactivate", actA3.body?.ok === true, JSON.stringify(actA3.body));

    // 11. admin routes are token-gated ----------------------------------------
    console.log("[smoke] admin route without ADMIN_TOKEN");
    const adminProbe = await request(port, "/admin/keys");
    check("admin route returns 401 without token", adminProbe.status === 401, String(adminProbe.status));

    // 12. list + health --------------------------------------------------------
    const list = await runNode([CLI, "list"], { LICENSE_DATA_DIR: tmp });
    check("cli list runs and shows 2 keys", list.code === 0 && /total keys: 2/.test(list.out), list.out);
    const health = await request(port, "/health");
    check("GET /health reports ok", health.status === 200 && health.body.ok === true, JSON.stringify(health.body));

    console.log("");
    if (failures === 0) {
      console.log(`[smoke] ALL CHECKS PASSED (throwaway public key: ${rawPubB64})`);
    } else {
      console.error(`[smoke] ${failures} check(s) FAILED`);
    }
  } catch (error) {
    failures += 1;
    console.error(`[smoke] unexpected error: ${error.message}`);
    if (serverErr) console.error(`[smoke] server stderr:\n${serverErr}`);
  } finally {
    if (serverChild && !serverChild.killed) serverChild.kill();
    if (keep) {
      console.log(`[smoke] --keep: left throwaway db at ${tmp}`);
    } else {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  process.exit(failures === 0 ? 0 : 1);
}

main();
