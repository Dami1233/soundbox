#!/usr/bin/env node
/*
 * The license server the desktop app talks to during activation.
 *
 * Run it anywhere Node 18+ runs (a small VPS, Railway, Fly, Render, …) and put it behind
 * HTTPS — the app requires a real https:// origin in release builds. The private key never
 * leaves this server: it signs license envelopes that the app verifies with the embedded
 * public key before trusting anything.
 *
 *   PORT              listen port                  (default 8787)
 *   HOST              bind address                 (default 127.0.0.1 — set 0.0.0.0 behind a proxy)
 *   LICENSE_DATA_DIR  db directory                 (default ./data next to this file)
 *   ADMIN_TOKEN       bearer token for /admin/*    (default none — admin routes disabled)
 *
 * The database (licenses.json) is re-read from disk on every request, so edits made by the
 * CLI on the same host (node licensing/cli.mjs revoke <key>, issue, …) take effect
 * immediately — no server restart needed. Mutations made through /admin/* or /activate are
 * saved back atomically.
 *
 * Public routes:
 *   POST /activate    { product, key, machineId, appVersion }
 *                     -> { ok: true, license: { payload, sig } } | { ok: false, error: CODE }
 *   GET  /health
 *
 * Admin routes (Authorization: Bearer $ADMIN_TOKEN):
 *   POST /admin/issue      { licensee?, plan?, maxDevices?, days?, note? } -> { key }
 *   POST /admin/revoke     { key, revoked: boolean }
 *   POST /admin/deactivate { key, machineId }
 *   GET  /admin/keys
 */
import http from "node:http";
import crypto from "node:crypto";
import {
  PRODUCT,
  activateKey,
  dataDir,
  ensureDb,
  findKey,
  formatKey,
  issueKey,
  loadDb,
  nowMs,
  publicKeyRawB64,
  saveDb,
} from "./lib.mjs";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const MAX_BODY_BYTES = 64 * 1024;

// Create the db file on first boot; every request after that re-loads it from disk so
// CLI edits on this host are picked up immediately.
const bootDb = ensureDb(dataDir());
console.log(
  `[license] server ready  http://${HOST}:${PORT}  product=${bootDb.product ?? PRODUCT}  publicKey=${publicKeyRawB64(bootDb)}`,
);
if (!ADMIN_TOKEN) {
  console.log("[license] warning: ADMIN_TOKEN is not set — /admin/* routes are disabled");
}

let db = bootDb;

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function authorized(req) {
  if (!ADMIN_TOKEN) return false;
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return false;
  const a = Buffer.from(ADMIN_TOKEN);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const route = `${req.method} ${url.pathname}`;
  const started = nowMs();

  try {
    // --- public -----------------------------------------------------------
    if (route === "POST /activate") {
      const body = await readBody(req);
      db = loadDb(dataDir()); // fresh view: reflects CLI edits made on this host
      const machineId = String(body.machineId || "").trim();
      const product = String(body.product || "");
      if (!machineId || machineId.length > 512) {
        return sendJson(res, 400, { ok: false, error: "BAD_MACHINE_ID" });
      }
      const result = activateKey(db, body.key, machineId);
      if (result.ok) {
        saveDb(db); // persist the activation record
      }
      return sendJson(res, 200, result);
    }

    if (route === "GET /health") {
      db = loadDb(dataDir());
      return sendJson(res, 200, {
        ok: true,
        product: db.product ?? PRODUCT,
        keys: db.keys.length,
      });
    }

    // --- admin (token only) ----------------------------------------------
    if (url.pathname.startsWith("/admin/")) {
      if (!authorized(req)) {
        return sendJson(res, 401, { ok: false, error: "UNAUTHORIZED" });
      }
      if (route === "POST /admin/issue") {
        const body = await readBody(req);
        db = loadDb(dataDir());
        const key = issueKey(db, {
          licensee: body.licensee ?? null,
          plan: body.plan ?? "perpetual",
          maxDevices: body.maxDevices ?? 1,
          days: body.days ?? 0,
          note: body.note ?? "",
        });
        saveDb(db);
        return sendJson(res, 200, { ok: true, key: formatKey(key.id) });
      }
      if (route === "POST /admin/revoke") {
        const body = await readBody(req);
        db = loadDb(dataDir());
        const key = findKey(db, body.key);
        if (!key) return sendJson(res, 404, { ok: false, error: "INVALID_KEY" });
        key.revoked = Boolean(body.revoked);
        saveDb(db);
        return sendJson(res, 200, { ok: true });
      }
      if (route === "POST /admin/deactivate") {
        const body = await readBody(req);
        db = loadDb(dataDir());
        const key = findKey(db, body.key);
        if (!key) return sendJson(res, 404, { ok: false, error: "INVALID_KEY" });
        key.activations = key.activations.filter(
          (activation) => activation.machineId !== body.machineId,
        );
        saveDb(db);
        return sendJson(res, 200, { ok: true });
      }
      if (route === "GET /admin/keys") {
        db = loadDb(dataDir());
        return sendJson(res, 200, {
          ok: true,
          keys: db.keys.map((key) => ({
            key: formatKey(key.id),
            licensee: key.licensee,
            plan: key.plan,
            maxDevices: key.maxDevices,
            revoked: key.revoked,
            expiresAtMs: key.expiresAtMs,
            issuedAtMs: key.issuedAtMs,
            note: key.note,
            activations: key.activations,
          })),
        });
      }
    }

    if (route === "GET /") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Soundbox license server. See licensing/README.md.\n");
    }

    return sendJson(res, 404, { ok: false, error: "NOT_FOUND" });
  } catch (error) {
    console.error(`[license] ${route} failed: ${error.message}`);
    try {
      if (!res.headersSent) {
        sendJson(res, error.message.includes("JSON") ? 400 : 500, {
          ok: false,
          error: "SERVER_ERROR",
        });
      }
    } catch {
      // The connection may already be gone (e.g. an oversized body was rejected mid-stream).
    }
  } finally {
    if (route !== "GET /health") {
      console.log(`[license] ${route} ${res.statusCode} ${nowMs() - started}ms`);
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[license] listening on http://${HOST}:${PORT}`);
});
