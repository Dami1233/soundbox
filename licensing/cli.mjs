#!/usr/bin/env node
/*
 * Seller-side CLI for the licensing database. Operates directly on the same data file the
 * server uses (licensing/data/licenses.json by default), so run it on the server host — or
 * run the server's /admin/* endpoints remotely if you prefer (see server.mjs).
 *
 *   node licensing/cli.mjs generate-keys              first run: mint the Ed25519 keypair
 *   node licensing/cli.mjs issue [--licensee X] [--plan perpetual] [--max-devices 1] [--days 0] [--note "..."]
 *   node licensing/cli.mjs list
 *   node licensing/cli.mjs revoke <key>
 *   node licensing/cli.mjs unrevoke <key>
 *   node licensing/cli.mjs deactivate <key> <machineId>
 *   node licensing/cli.mjs print-fixture              regenerates the Rust interop test fixture
 */
import { existsSync } from "node:fs";
import {
  PRODUCT,
  createDb,
  dataDir,
  dbPath,
  ensureDb,
  findKey,
  formatKey,
  issueKey,
  loadDb,
  publicKeyRawB64,
  saveDb,
  signLicense,
} from "./lib.mjs";

const args = process.argv.slice(2);
const command = args[0];

function flag(name, fallback = undefined) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return args[index + 1];
}

function hasFlag(name) {
  return args.includes(`--${name}`);
}

function usage() {
  console.log(`Usage:
  node licensing/cli.mjs generate-keys [--force]
  node licensing/cli.mjs issue [--licensee X] [--plan perpetual] [--max-devices 1] [--days 0] [--note "..."]
  node licensing/cli.mjs list
  node licensing/cli.mjs revoke <key>
  node licensing/cli.mjs unrevoke <key>
  node licensing/cli.mjs deactivate <key> <machineId>
  node licensing/cli.mjs print-fixture`);
}

switch (command) {
  case "generate-keys": {
    if (existsSync(dbPath(dataDir())) && !hasFlag("force")) {
      console.error(
        `A database already exists at ${dbPath(dataDir())}. Pass --force to replace it ` +
          "(this invalidates every previously issued key).",
      );
      process.exit(1);
    }
    const db = createDb();
    saveDb(db);
    console.log(`[license] wrote ${dbPath(dataDir())}`);
    console.log("");
    console.log("Paste this public key into src-tauri/src/license.rs as LICENSE_PUBLIC_KEY_B64:");
    console.log("");
    console.log(publicKeyRawB64(db));
    console.log("");
    console.log(`The private key stays in ${dbPath(dataDir())} — never commit it, never ship it.`);
    break;
  }

  case "issue": {
    const db = ensureDb(dataDir());
    const key = issueKey(db, {
      licensee: flag("licensee"),
      plan: flag("plan", "perpetual"),
      maxDevices: Number(flag("max-devices", 1)),
      days: Number(flag("days", 0)),
      note: flag("note", ""),
    });
    saveDb(db);
    console.log(`Issued ${formatKey(key.id)}`);
    console.log(`  plan        ${key.plan}`);
    console.log(`  maxDevices  ${key.maxDevices}`);
    if (key.expiresAtMs) console.log(`  expiresAt   ${new Date(key.expiresAtMs).toISOString()}`);
    if (key.licensee) console.log(`  licensee    ${key.licensee}`);
    break;
  }

  case "list": {
    const db = loadDb(dataDir());
    console.log(`product=${db.product ?? PRODUCT} publicKey=${publicKeyRawB64(db)}`);
    console.log(`total keys: ${db.keys.length}`);
    for (const key of db.keys) {
      const state = key.revoked
        ? "REVOKED"
        : key.expiresAtMs != null && Date.now() > key.expiresAtMs
          ? "EXPIRED"
          : "active";
      console.log(
        `${state.padEnd(7)} ${formatKey(key.id)}  devices ${key.activations.length}/${key.maxDevices}` +
          `  ${key.plan}` +
          (key.licensee ? `  ${key.licensee}` : ""),
      );
    }
    break;
  }

  case "revoke": {
    const db = loadDb(dataDir());
    const key = findKey(db, args[1]);
    if (!key) {
      console.error(`Unknown key: ${args[1]}`);
      process.exit(1);
    }
    key.revoked = true;
    saveDb(db);
    console.log(`Revoked ${formatKey(key.id)}`);
    break;
  }

  case "unrevoke": {
    const db = loadDb(dataDir());
    const key = findKey(db, args[1]);
    if (!key) {
      console.error(`Unknown key: ${args[1]}`);
      process.exit(1);
    }
    key.revoked = false;
    saveDb(db);
    console.log(`Un-revoked ${formatKey(key.id)}`);
    break;
  }

  case "deactivate": {
    const [rawKey, machineId] = [args[1], args[2]];
    if (!rawKey || !machineId) {
      usage();
      process.exit(1);
    }
    const db = loadDb(dataDir());
    const key = findKey(db, rawKey);
    if (!key) {
      console.error(`Unknown key: ${rawKey}`);
      process.exit(1);
    }
    const before = key.activations.length;
    key.activations = key.activations.filter((activation) => activation.machineId !== machineId);
    saveDb(db);
    console.log(
      before === key.activations.length
        ? `No activation for ${formatKey(key.id)} on ${machineId}`
        : `Deactivated ${formatKey(key.id)} on ${machineId} (now ${key.activations.length}/${key.maxDevices})`,
    );
    break;
  }

  case "print-fixture": {
    const db = ensureDb(dataDir());
    const payload = {
      product: db.product ?? PRODUCT,
      key: "ABCD-EFGH-JKLM-NOPQ",
      licensee: null,
      plan: "perpetual",
      machineId: "test-machine",
      issuedAtMs: 1750000000000,
      expiresAtMs: null,
    };
    const { payload: payloadText, sig } = signLicense(db, payload);
    console.log(`payload: ${JSON.stringify(payloadText)}`);
    console.log(`sig:     ${JSON.stringify(sig)}`);
    break;
  }

  default:
    usage();
    process.exit(command ? 1 : 0);
}
