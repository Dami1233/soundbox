#!/usr/bin/env node
/*
 * Soundbox — Lemon Squeezy checkout webhook
 *
 * A tiny HTTP server that Lemon Squeezy POSTs checkout events to. It verifies the
 * HMAC-SHA256 signature on the raw body, then issues a license key on your license
 * server via POST /admin/issue and (optionally) emails the key to the buyer through
 * the Lemon Squeezy API.
 *
 * Why a separate process: the license server binds to localhost and holds the private
 * key / admin token. This webhook is the only piece exposed to the internet (through
 * your reverse proxy), and it never sees the license server's private key — it only
 * calls the admin route with a bearer token.
 *
 * Env:
 *   PORT                          listen port          (default 8790)
 *   HOST                          bind address         (default 127.0.0.1 — set 0.0.0.0 behind a proxy)
 *   LEMONSQUEEZY_WEBHOOK_SECRET   LS signing secret    (required)
 *   LICENSE_SERVER_URL            license server base  (default http://127.0.0.1:8787)
 *   ADMIN_TOKEN                   license server admin token (required)
 *   ALLOWED_EVENTS                comma-separated      (default order_created)
 *   DEFAULT_PLAN                  license plan         (default perpetual)
 *   DEFAULT_MAX_DEVICES           machine limit        (default 1)
 *   SUBSCRIPTION_DAYS             key lifetime for subscription events; 0 = never expire (default 0)
 *   LS_API_KEY                    Lemon Squeezy Personal Access Token — enables emailing the key (optional)
 *   ALLOW_TEST_MODE               1 to issue keys for Lemon Squeezy test events (default off)
 *
 * Deploying: see the "Lemon Squeezy checkout webhook" section in licensing/README.md.
 */
import http from "node:http";
import crypto from "node:crypto";

const env = (k, d) => process.env[k] ?? d;

const PORT = Number(env("PORT", "8790"));
const HOST = env("HOST", "127.0.0.1");
const WEBHOOK_SECRET = env("LEMONSQUEEZY_WEBHOOK_SECRET", "");
const LICENSE_SERVER_URL = env("LICENSE_SERVER_URL", "http://127.0.0.1:8787").replace(/\/+$/, "");
const ADMIN_TOKEN = env("ADMIN_TOKEN", "");
const ALLOWED_EVENTS = new Set(
  env("ALLOWED_EVENTS", "order_created")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const DEFAULT_PLAN = env("DEFAULT_PLAN", "perpetual");
const DEFAULT_MAX_DEVICES = Number(env("DEFAULT_MAX_DEVICES", "1"));
const SUBSCRIPTION_DAYS = Number(env("SUBSCRIPTION_DAYS", "0"));
const LS_API_KEY = env("LS_API_KEY", "");
const ALLOW_TEST_MODE = env("ALLOW_TEST_MODE", "") === "1";

const MAX_BODY_BYTES = 1 * 1024 * 1024;

if (!WEBHOOK_SECRET) {
  console.error("[webhook] LEMONSQUEEZY_WEBHOOK_SECRET is not set — refusing to start");
  process.exit(1);
}
if (!ADMIN_TOKEN) {
  console.error("[webhook] ADMIN_TOKEN is not set — refusing to start");
  process.exit(1);
}

function log(...a) {
  console.log(`[${new Date().toISOString()}]`, ...a);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Constant-time comparison of a hex signature against the freshly computed one. */
function verifySignature(rawBody, provided) {
  if (!provided || !WEBHOOK_SECRET) return false;
  const expected = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  if (expected.length !== provided.length) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return crypto.timingSafeEqual(a, b);
}

function extractEmail(payload) {
  const attrs = payload.data?.attributes || {};
  if (attrs.customer_email) return attrs.customer_email;
  if (attrs.user_email) return attrs.user_email;
  const custom = payload.meta?.custom_data || {};
  return custom.email || custom.buyer_email || null;
}

async function issueLicense({ licensee, plan, maxDevices, days, note }) {
  const res = await fetch(`${LICENSE_SERVER_URL}/admin/issue`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ licensee, plan, maxDevices, days, note }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!res.ok || !body?.ok) {
    throw new Error(`license server ${res.status}: ${text.slice(0, 300)}`);
  }
  return body.key;
}

/** Optionally email the key to the buyer via the Lemon Squeezy fulfillment API. */
async function deliverKeyByEmail(orderId, key, email) {
  const res = await fetch(`https://api.lemonsqueezy.com/v1/orders/${orderId}/deliver`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${LS_API_KEY}`,
      "content-type": "application/json",
      accept: "application/vnd.api+json",
    },
    body: JSON.stringify({
      deliver: "custom",
      custom_payload: `<p>Thanks for buying Soundbox!</p><p>Your license key:</p><p><b>${key}</b></p><p>Paste it into the activation screen in the app. It is bound to one machine and never expires.</p>`,
    }),
  });
  if (!res.ok) {
    throw new Error(`lemonsqueezy deliver ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return true;
}

async function handle(req, res) {
  if (req.method === "GET" && req.url.split("?")[0] === "/health") {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch {
    return sendJson(res, 413, { ok: false, error: "BODY_TOO_LARGE" });
  }

  // Lemon Squeezy signs the raw request body; headers are not part of the HMAC.
  const signature = req.headers["x-signature"] ?? req.headers["signature"];
  if (!verifySignature(raw, signature)) {
    log("REJECTED bad signature");
    return sendJson(res, 401, { ok: false, error: "BAD_SIGNATURE" });
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return sendJson(res, 400, { ok: false, error: "BAD_JSON" });
  }

  const event = req.headers["x-event-name"] || payload?.meta?.event_name;
  if (payload?.meta?.test_mode && !ALLOW_TEST_MODE) {
    log("skipping test-mode event", event);
    return sendJson(res, 200, { ok: true, skipped: "test_mode" });
  }
  if (!event || !ALLOWED_EVENTS.has(event)) {
    log("skipping unhandled event", event);
    return sendJson(res, 200, { ok: true, skipped: event });
  }

  const email = extractEmail(payload);
  if (!email) {
    return sendJson(res, 422, { ok: false, error: "NO_EMAIL" });
  }

  const attrs = payload.data?.attributes || {};
  const orderId = payload.data?.id;
  const orderNumber = attrs.order_number || orderId || "";
  const isSubscription = event.startsWith("subscription");
  const days = isSubscription ? SUBSCRIPTION_DAYS : 0;
  const custom = payload.meta?.custom_data || {};
  const licensee = email; // LS already sent a receipt; using the buyer email is unambiguous
  const maxDevices = Number(custom.max_devices || DEFAULT_MAX_DEVICES);
  const note = `ls:${event}:${orderNumber}`;

  let key;
  try {
    key = await issueLicense({ licensee, plan: DEFAULT_PLAN, maxDevices, days, note });
  } catch (err) {
    log("license server error:", err.message);
    return sendJson(res, 502, { ok: false, error: "LICENSE_SERVER", detail: err.message });
  }
  log(`issued key ${key} -> ${email} (${event}, order ${orderNumber})`);

  if (LS_API_KEY && orderId) {
    try {
      await deliverKeyByEmail(orderId, key, email);
      log("key emailed to", email);
    } catch (err) {
      log("warn: could not email key:", err.message);
    }
  }

  return sendJson(res, 200, { ok: true, key, email });
}

http
  .createServer(handle)
  .listen(PORT, HOST, () => {
    log(
      `webhook ready http://${HOST}:${PORT} -> ${LICENSE_SERVER_URL}  allowedEvents=[${[...ALLOWED_EVENTS].join(", ")}]`,
    );
  });