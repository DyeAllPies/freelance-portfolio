// A local stand-in for the two providers, for exactly the calls this app makes:
// Mercado Pago PIX payments and Stripe Checkout sessions. It keeps its state in
// memory, serves a payable page for each, and signs and posts webhooks to the
// app itself, so the app's real signature checks and once-only event handling
// run against it. It is not the real service and moves no money.
//
// Why not stripe-mock: it answers with fixed responses, ignores what is posted
// and has no payable page or webhooks, so it cannot complete a session.
import { createServer } from "node:http";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const html = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const money = (cents) => `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;

// Turns "a[0][b]=1&c[d]=2" pairs into { a: [{ b: "1" }], c: { d: "2" } }.
export function parseForm(text) {
  const root = {};
  for (const [key, value] of new URLSearchParams(text)) {
    const path = key.split(/\[|\]\[?/).filter((p) => p !== "");
    // A key that walks the prototype chain is dropped, so a crafted body cannot pollute Object.prototype.
    if (path.some((p) => p === "__proto__" || p === "constructor" || p === "prototype")) continue;
    let node = root;
    path.forEach((part, i) => {
      if (i === path.length - 1) {
        node[part] = value;
        return;
      }
      node[part] ??= /^\d+$/.test(path[i + 1]) ? [] : {};
      node = node[part];
    });
  }
  return root;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// A 240x240 grayscale pattern seeded by the payment id. It looks like a QR code
// from afar but is not scannable.
export function patternPng(seed) {
  const size = 240;
  const cell = 8;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size + 1); // first byte is the filter type, 0 = none
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      const dark = ((cx * 31 + cy * 17 + seed * 7 + ((cx * cy) ^ seed)) >>> 0) % 3 === 0;
      row[x + 1] = dark ? 0 : 255;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function createMockServer({ appUrl, mpWebhookSecret, stripeWebhookSecret, publicUrl, log = () => {} }) {
  const app = appUrl.replace(/\/+$/, "");
  const publicBase = publicUrl.replace(/\/+$/, "");

  const payments = new Map(); // id -> payment
  const paymentsByKey = new Map(); // X-Idempotency-Key -> payment
  let nextPaymentId = 1000000001;

  const sessions = new Map(); // id -> session record
  const sessionsByKey = new Map(); // Idempotency-Key -> session record

  // Mercado Pago signs "id:<data.id>;request-id:<x-request-id>;ts:<ts>;".
  async function deliverMp(payment, { bad = false, replay = false } = {}) {
    const dataId = String(payment.id);
    const body = replay && payment.lastBody ? payment.lastBody : JSON.stringify({ action: "payment.updated", type: "payment", data: { id: dataId } });
    payment.lastBody = body;
    const requestId = randomUUID();
    const ts = Math.floor(Date.now() / 1000);
    const secret = bad ? `${mpWebhookSecret}-forged` : mpWebhookSecret;
    const id = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
    const v1 = createHmac("sha256", secret).update(`id:${id};request-id:${requestId};ts:${ts};`).digest("hex");
    const url = `${app}/api/webhooks/mercadopago?data.id=${encodeURIComponent(dataId)}&type=payment`;
    return post(url, body, { "x-request-id": requestId, "x-signature": `ts=${ts},v1=${v1}` }, `mp payment ${dataId} ${payment.status}${bad ? " (forged)" : ""}`);
  }

  // Stripe signs "<t>.<raw body>"; the same string is what gets sent.
  async function deliverStripe(record, type, object, { bad = false, replay = false } = {}) {
    let raw = replay ? record.lastEvent : null;
    if (!raw) {
      raw = JSON.stringify({ id: `evt_mock_${randomBytes(8).toString("hex")}`, object: "event", type, created: Math.floor(Date.now() / 1000), data: { object } });
      record.lastEvent = raw;
    }
    const t = Math.floor(Date.now() / 1000);
    const secret = bad ? `${stripeWebhookSecret}-forged` : stripeWebhookSecret;
    const v1 = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
    const event = JSON.parse(raw);
    return post(`${app}/api/webhooks/stripe`, raw, { "stripe-signature": `t=${t},v1=${v1}` }, `stripe ${event.type} ${event.id}${bad ? " (forged)" : ""}`);
  }

  async function post(url, body, headers, label) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
      log(`webhook ${label} -> ${res.status}`);
      return res.status;
    } catch (err) {
      log(`webhook ${label} -> failed: ${err.message}`);
      return 0;
    }
  }

  const sessionObject = (s, paid) => ({
    id: s.id,
    object: "checkout.session",
    mode: s.mode,
    status: paid ? "complete" : "open",
    payment_status: paid ? "paid" : "unpaid",
    url: s.url,
    metadata: s.metadata,
    client_reference_id: s.client_reference_id,
    customer_email: s.customer_email,
    amount_total: s.amount_total,
    currency: s.currency,
    success_url: s.success_url,
    cancel_url: s.cancel_url,
    payment_intent: s.payment_intent,
  });

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8");
  }

  const stripeError = (res, status, message) => json(res, status, { error: { type: "invalid_request_error", message } });

  const redirect = (res, to) => {
    res.writeHead(303, { Location: to });
    res.end();
  };

  const mpPage = (p) => `<!doctype html><html><head><meta charset="utf-8"><title>Mock Mercado Pago (stand-in, not the real service)</title></head><body style="font-family:sans-serif;max-width:32rem;margin:2rem auto">
<h1>Mock Mercado Pago (stand-in, not the real service)</h1>
<p>Amount: <strong>${escapeHtml(money(Math.round(p.transaction_amount * 100)))}</strong></p>
<p>Status: ${escapeHtml(p.status)}</p>
<p>PIX copy and paste code:</p><textarea readonly rows="4" style="width:100%">${escapeHtml(p.qr_code)}</textarea>
<form method="post" action="/mp/pay/${p.id}/approve" style="display:inline"><button>Approve</button></form>
<form method="post" action="/mp/pay/${p.id}/reject" style="display:inline"><button>Reject</button></form>
</body></html>`;

  const stripePage = (s) => `<!doctype html><html><head><meta charset="utf-8"><title>Mock Stripe Checkout (stand-in, not Stripe)</title></head><body style="font-family:sans-serif;max-width:32rem;margin:2rem auto">
<h1>Mock Stripe Checkout (stand-in, not Stripe)</h1>
<p>Product: <strong>${escapeHtml(s.product_name)}</strong></p>
<p>Amount: <strong>${escapeHtml(money(s.amount_total))}</strong> (BRL)</p>
<p>Email: ${escapeHtml(s.customer_email ?? "")}</p>
<form method="post" action="/stripe/pay/${s.id}/complete" style="display:inline"><button>Pay</button></form>
<form method="post" action="/stripe/pay/${s.id}/expire" style="display:inline"><button>Cancel</button></form>
</body></html>`;

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://mock");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const bad = url.searchParams.get("bad") === "1";
    let m;

    // ---- Mercado Pago ----
    if (method === "POST" && path === "/v1/payments") {
      if (!/^Bearer\s+\S+/.test(req.headers.authorization ?? "")) {
        return json(res, 401, { message: "Invalid access token", error: "unauthorized", status: 401 });
      }
      const key = req.headers["x-idempotency-key"];
      const existing = key ? paymentsByKey.get(String(key)) : undefined;
      let payment = existing;
      if (!payment) {
        let input;
        try {
          input = JSON.parse((await readBody(req)) || "{}");
        } catch {
          return json(res, 400, { message: "Invalid JSON", error: "bad_request", status: 400 });
        }
        const id = nextPaymentId++;
        payment = {
          id,
          status: "pending",
          external_reference: input.external_reference ?? "",
          notification_url: input.notification_url ?? "",
          transaction_amount: Number(input.transaction_amount ?? 0),
          qr_code: `00020126580014br.gov.bcb.pix0136mock-${randomBytes(6).toString("hex")}5204000053039865802BR5909MOCK PIX6009SAO PAULO62070503***6304${id}`,
        };
        payments.set(String(id), payment);
        if (key) paymentsByKey.set(String(key), payment);
        log(`mp payment ${id} created: approve at ${publicBase}/mp/pay/${id}`);
      }
      return json(res, 201, {
        id: payment.id,
        status: payment.status,
        external_reference: payment.external_reference,
        transaction_amount: payment.transaction_amount,
        point_of_interaction: {
          transaction_data: { qr_code: payment.qr_code, qr_code_base64: patternPng(payment.id).toString("base64") },
        },
      });
    }

    if (method === "GET" && (m = path.match(/^\/v1\/payments\/([^/]+)$/))) {
      const p = payments.get(decodeURIComponent(m[1]));
      if (!p) return json(res, 404, { message: "Payment not found", error: "not_found", status: 404 });
      return json(res, 200, { id: p.id, status: p.status, external_reference: p.external_reference });
    }

    if (method === "GET" && (m = path.match(/^\/mp\/pay\/([^/]+)$/))) {
      const p = payments.get(decodeURIComponent(m[1]));
      if (!p) return json(res, 404, { error: "not found" });
      return html(res, 200, mpPage(p));
    }

    if (method === "POST" && (m = path.match(/^\/mp\/pay\/([^/]+)\/(approve|reject)$/))) {
      const p = payments.get(decodeURIComponent(m[1]));
      if (!p) return json(res, 404, { error: "not found" });
      p.status = m[2] === "approve" ? "approved" : "rejected";
      await deliverMp(p);
      return redirect(res, `/mp/pay/${p.id}`);
    }

    if (method === "POST" && (m = path.match(/^\/_mock\/mp\/payments\/([^/]+)\/status$/))) {
      const p = payments.get(decodeURIComponent(m[1]));
      if (!p) return json(res, 404, { error: "not found" });
      let input;
      try {
        input = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }
      if (!["approved", "rejected", "cancelled", "refunded"].includes(input.status)) {
        return json(res, 400, { error: "status must be approved, rejected, cancelled or refunded" });
      }
      p.status = input.status;
      return json(res, 200, { delivered: await deliverMp(p, { bad }) });
    }

    if (method === "POST" && (m = path.match(/^\/_mock\/mp\/payments\/([^/]+)\/replay$/))) {
      const p = payments.get(decodeURIComponent(m[1]));
      if (!p) return json(res, 404, { error: "not found" });
      return json(res, 200, { delivered: await deliverMp(p, { bad, replay: true }) });
    }

    // ---- Stripe ----
    if (method === "POST" && path === "/v1/checkout/sessions") {
      const auth = req.headers.authorization ?? "";
      if (!/^Bearer\s+sk_test_\S*/.test(auth)) {
        return stripeError(res, 401, "Invalid API Key provided: this stand-in accepts test-mode keys (sk_test_...) only.");
      }
      const key = req.headers["idempotency-key"];
      let record = key ? sessionsByKey.get(String(key)) : undefined;
      if (!record) {
        const f = parseForm(await readBody(req));
        const item = f.line_items?.[0];
        const unit = item?.price_data?.unit_amount;
        const unitNumber = unit === undefined || unit === "" ? NaN : Number(unit);
        if (f.mode !== "payment") return stripeError(res, 400, "Invalid mode: only payment is supported.");
        if (!Number.isInteger(unitNumber)) return stripeError(res, 400, "Invalid integer: line_items[0][price_data][unit_amount]");
        const quantity = item.quantity === undefined ? 1 : Number(item.quantity);
        if (item.quantity === "" || !Number.isInteger(quantity) || quantity < 1) return stripeError(res, 400, "Invalid integer: line_items[0][quantity]");
        if (!item.price_data.currency) return stripeError(res, 400, "Missing required param: line_items[0][price_data][currency].");
        if (!f.success_url) return stripeError(res, 400, "Missing required param: success_url.");
        if (!f.cancel_url) return stripeError(res, 400, "Missing required param: cancel_url.");
        const id = `cs_test_${randomBytes(12).toString("hex")}`;
        record = {
          id,
          mode: f.mode,
          url: `${publicBase}/stripe/pay/${id}`,
          metadata: f.metadata ?? {},
          client_reference_id: f.client_reference_id ?? null,
          customer_email: f.customer_email ?? null,
          amount_total: unitNumber * quantity,
          currency: item.price_data.currency,
          success_url: f.success_url,
          cancel_url: f.cancel_url,
          payment_intent: `pi_mock_${randomBytes(8).toString("hex")}`,
          product_name: item.price_data.product_data?.name ?? "Product",
          paid: false,
        };
        sessions.set(id, record);
        if (key) sessionsByKey.set(String(key), record);
      }
      return json(res, 200, sessionObject(record, record.paid));
    }

    if (method === "GET" && (m = path.match(/^\/stripe\/pay\/([^/]+)$/))) {
      const s = sessions.get(decodeURIComponent(m[1]));
      if (!s) return json(res, 404, { error: "not found" });
      return html(res, 200, stripePage(s));
    }

    const stripeAction = path.match(/^\/stripe\/pay\/([^/]+)\/(complete|expire)$/);
    if (method === "POST" && stripeAction) {
      const s = sessions.get(decodeURIComponent(stripeAction[1]));
      if (!s) return json(res, 404, { error: "not found" });
      if (stripeAction[2] === "complete") {
        s.paid = true;
        await deliverStripe(s, "checkout.session.completed", sessionObject(s, true));
        return redirect(res, s.success_url);
      }
      await deliverStripe(s, "checkout.session.expired", sessionObject(s, false));
      return redirect(res, s.cancel_url);
    }

    if (method === "POST" && (m = path.match(/^\/_mock\/stripe\/sessions\/([^/]+)\/(complete|expire|refund|replay)$/))) {
      const s = sessions.get(decodeURIComponent(m[1]));
      if (!s) return json(res, 404, { error: "not found" });
      const action = m[2];
      if (action === "complete") {
        s.paid = true;
        return json(res, 200, { delivered: await deliverStripe(s, "checkout.session.completed", sessionObject(s, true), { bad }) });
      }
      if (action === "expire") {
        return json(res, 200, { delivered: await deliverStripe(s, "checkout.session.expired", sessionObject(s, false), { bad }) });
      }
      if (action === "refund") {
        if (!s.paid) return json(res, 409, { error: "the session is not paid yet" });
        const charge = { id: `ch_mock_${randomBytes(8).toString("hex")}`, object: "charge", refunded: true, metadata: s.metadata };
        return json(res, 200, { delivered: await deliverStripe(s, "charge.refunded", charge, { bad }) });
      }
      if (!s.lastEvent) return json(res, 409, { error: "nothing to replay yet" });
      return json(res, 200, { delivered: await deliverStripe(s, "", null, { bad, replay: true }) });
    }

    return json(res, 404, { error: "not found" });
  }

  return createServer((req, res) => {
    res.on("finish", () => log(`${req.method} ${req.url} -> ${res.statusCode}`));
    handle(req, res).catch((err) => {
      log(`error: ${err.stack ?? err}`);
      if (!res.headersSent) json(res, 500, { error: "mock server error" });
      else res.end();
    });
  });
}

function main() {
  for (const name of ["MP_WEBHOOK_SECRET", "STRIPE_WEBHOOK_SECRET"]) {
    if (!process.env[name]) {
      console.error(`${name} is required (the secret the app verifies webhooks with).`);
      process.exit(1);
    }
  }
  const port = Number(process.env.MOCK_PORT || 4010);
  const server = createMockServer({
    appUrl: process.env.APP_URL || "http://localhost:3000",
    mpWebhookSecret: process.env.MP_WEBHOOK_SECRET,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    publicUrl: process.env.MOCK_PUBLIC_URL || `http://localhost:${port}`,
    log: (line) => console.log(line),
  });
  server.listen(port, () => console.log(`mock providers listening on port ${port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
