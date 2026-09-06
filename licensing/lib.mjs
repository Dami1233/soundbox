/*
 * Shared guts of the seller-side licensing tooling (server.mjs, cli.mjs).
 *
 * Zero runtime dependencies: everything is built on node:crypto (Ed25519) and node:fs.
 * The signatures this module produces are standard Ed25519 over the exact UTF-8 bytes of
 * the JSON payload, base64-encoded — the same scheme the Rust side verifies with
 * `ed25519-compact` (src-tauri/src/license.rs).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

export const PRODUCT = "zuno-desktop";
const DB_FILE = "licenses.json";
const KEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DAY_MS = 24 * 60 * 60 * 1000;

/** The db directory: LICENSE_DATA_DIR env, else <this folder>/data. */
export function dataDir() {
  return (
    process.env.LICENSE_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "data")
  );
}

export function dbPath(dir = dataDir()) {
  return path.join(dir, DB_FILE);
}

export function nowMs() {
  return Date.now();
}

export function createDb() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    product: PRODUCT,
    createdAtMs: nowMs(),
    keyPair: {
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    },
    keys: [],
  };
}

export function loadDb(dir = dataDir()) {
  const file = dbPath(dir);
  if (!existsSync(file)) {
    throw new Error(`No license database at ${file}. Run "node licensing/cli.mjs generate-keys" first.`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

export function saveDb(db, dir = dataDir()) {
  mkdirSync(dir, { recursive: true });
  const file = dbPath(dir);
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(db, null, 2));
  renameSync(temp, file);
}

/** Load the db, creating it with a fresh keypair on first run. */
export function ensureDb(dir = dataDir()) {
  if (existsSync(dbPath(dir))) return loadDb(dir);
  const db = createDb();
  saveDb(db, dir);
  console.log(`[license] created ${dbPath(dir)} with a fresh Ed25519 keypair`);
  return db;
}

/** The 32 raw public-key bytes, standard base64 — what goes into LICENSE_PUBLIC_KEY_B64. */
export function publicKeyRawB64(db) {
  const der = crypto
    .createPublicKey(db.keyPair.publicKeyPem)
    .export({ type: "spki", format: "der" });
  return der.subarray(der.length - 32).toString("base64");
}

/** Strip separators/case from anything the buyer pastes. */
export function normalizeKey(raw) {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** Pretty display form: XXXX-XXXX-XXXX-XXXX. */
export function formatKey(id) {
  return String(id).match(/.{1,4}/g)?.join("-") ?? String(id);
}

/** A fresh product key: 10 random bytes -> 16 base32 chars, dash-grouped. */
export function generateKey() {
  const bytes = crypto.randomBytes(10);
  let value = 0;
  let bits = 0;
  let chars = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      chars += KEY_ALPHABET[(value >> bits) & 31];
    }
  }
  return formatKey(chars);
}

export function findKey(db, rawKey) {
  const id = normalizeKey(rawKey);
  return db.keys.find((key) => key.id === id) ?? null;
}

/**
 * Build the signed envelope over a license payload. `payload` must be a plain object whose
 * key order you are happy to sign (it is, by definition, the bytes that get verified).
 */
export function signLicense(db, payload) {
  const payloadText = JSON.stringify(payload);
  const signature = crypto.sign(null, Buffer.from(payloadText, "utf8"), db.keyPair.privateKeyPem);
  return { payload: payloadText, sig: signature.toString("base64") };
}

/**
 * Activate `rawKey` for `machineId`. Mutates `db` on success (call saveDb afterwards).
 * Returns { ok, license } or { ok: false, error: CODE }.
 */
export function activateKey(db, rawKey, machineId) {
  const key = findKey(db, rawKey);
  if (!key) return { ok: false, error: "INVALID_KEY" };
  if (key.revoked) return { ok: false, error: "REVOKED" };
  if (key.expiresAtMs != null && nowMs() > key.expiresAtMs) return { ok: false, error: "EXPIRED" };

  const existing = key.activations.find((activation) => activation.machineId === machineId);
  if (existing) {
    existing.lastSeenMs = nowMs();
  } else if (key.activations.length >= key.maxDevices) {
    return { ok: false, error: "LIMIT_REACHED" };
  } else {
    key.activations.push({ machineId, activatedAtMs: nowMs(), lastSeenMs: nowMs() });
  }

  const license = signLicense(db, {
    product: db.product ?? PRODUCT,
    key: key.id,
    licensee: key.licensee ?? null,
    plan: key.plan ?? "perpetual",
    machineId,
    issuedAtMs: nowMs(),
    expiresAtMs: key.expiresAtMs ?? null,
  });
  return { ok: true, license };
}

/** Issue a new product key into `db`. */
export function issueKey(db, options = {}) {
  const days = Number(options.days) || 0;
  const key = {
    id: normalizeKey(generateKey()),
    licensee: options.licensee ?? null,
    plan: options.plan ?? "perpetual",
    maxDevices: Math.max(1, Number(options.maxDevices) || 1),
    expiresAtMs: days > 0 ? nowMs() + days * DAY_MS : null,
    revoked: false,
    issuedAtMs: nowMs(),
    note: options.note ?? "",
    activations: [],
  };
  db.keys.push(key);
  return key;
}
