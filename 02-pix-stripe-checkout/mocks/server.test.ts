import Stripe from "stripe";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockServer } from "./server.mjs";
import { createPixPayment, getPayment, mapPaymentStatus, verifyWebhookSignature } from "../lib/mercadopago";
import { createCheckoutSession, mapStripeEvent, stripeClient } from "../lib/stripe";

const MP_SECRET = "mp_test_secret";
const STRIPE_SECRET = "whsec_test_secret";
const APP_URL = "https://app.example.test";

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: string };

let mock: Server;
let receiver: Server;
let base: string;
let seen: Seen[] = [];

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );
}

beforeAll(async () => {
  // Stands in for the app: records what the mock delivers and answers 200.
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200).end();
    });
  });
  const receiverUrl = await listen(receiver);
  // The mock's public URL must be known before it is built, so reserve a free
  // port first and then listen on it.
  const probe = createServer();
  const probeUrl = await listen(probe);
  await new Promise((r) => probe.close(r));
  base = probeUrl;
  mock = createMockServer({ appUrl: receiverUrl, mpWebhookSecret: MP_SECRET, stripeWebhookSecret: STRIPE_SECRET, publicUrl: base });
  await new Promise<void>((resolve) => mock.listen(Number(new URL(base).port), "127.0.0.1", resolve));
});

afterAll(() => {
  mock.close();
  receiver.close();
});

async function post(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, { method: "POST", ...init });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function lastSeen(): Seen {
  return seen[seen.length - 1];
}

function mpArgs(orderId: string) {
  return {
    accessToken: "TEST-token",
    orderId,
    amountCents: 12_345,
    description: "Mock order",
    payerEmail: "buyer@example.test",
    notificationUrl: `${APP_URL}/api/webhooks/mercadopago`,
    apiBase: base,
  };
}

function mpVerifies(s: Seen, secret: string) {
  const dataId = new URL(s.url, "http://x").searchParams.get("data.id");
  return verifyWebhookSignature({
    xSignature: String(s.headers["x-signature"] ?? ""),
    xRequestId: String(s.headers["x-request-id"] ?? ""),
    dataId,
    secret,
  });
}

function stripeSession(orderId: string) {
  return createCheckoutSession(stripeClient("sk_test_x", base), {
    orderId,
    amountCents: 9_900,
    productName: "Mock product",
    email: "buyer@example.test",
    appUrl: APP_URL,
  });
}

function stripeEvent(s: Seen, secret: string) {
  return new Stripe("sk_test_x").webhooks.constructEvent(s.body, String(s.headers["stripe-signature"] ?? ""), secret);
}

describe("mock Mercado Pago", () => {
  it("creates an idempotent PIX payment with a code and a PNG", async () => {
    const a = await createPixPayment(mpArgs("order-mp-1"));
    const b = await createPixPayment(mpArgs("order-mp-1"));
    expect(a.paymentId).toMatch(/^\d+$/);
    expect(b.paymentId).toBe(a.paymentId);
    expect(a.copyPaste.startsWith("00020126")).toBe(true);
    expect(a.copyPaste.endsWith(a.paymentId)).toBe(true);
    expect([...Buffer.from(a.qrBase64, "base64").subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect((await getPayment("TEST-token", a.paymentId, base)).status).toBe("pending");
  });

  it("logs the approve page once per new payment, not for an idempotent repeat", async () => {
    const lines: string[] = [];
    const logged = createMockServer({ appUrl: "http://app.test", mpWebhookSecret: MP_SECRET, stripeWebhookSecret: STRIPE_SECRET, publicUrl: "http://mock.test", log: (l) => lines.push(l) });
    const loggedBase = await listen(logged);
    try {
      const args = { ...mpArgs("order-mp-log"), apiBase: loggedBase };
      const a = await createPixPayment(args);
      await createPixPayment(args);
      const created = lines.filter((l) => l.startsWith("mp payment "));
      expect(created).toEqual([`mp payment ${a.paymentId} created: approve at http://mock.test/mp/pay/${a.paymentId}`]);
    } finally {
      logged.close();
    }
  });

  it("delivers a webhook the app's own check accepts, and getPayment reads the new status", async () => {
    const { paymentId } = await createPixPayment(mpArgs("order-mp-2"));
    seen = [];
    const r = await post(`/_mock/mp/payments/${paymentId}/status`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(r.json).toEqual({ delivered: 200 });
    expect(seen).toHaveLength(1);
    const u = new URL(lastSeen().url, "http://x");
    expect(u.pathname).toBe("/api/webhooks/mercadopago");
    expect(u.searchParams.get("type")).toBe("payment");
    expect(u.searchParams.get("data.id")).toBe(paymentId);
    expect(mpVerifies(lastSeen(), MP_SECRET)).toBe(true);
    expect(mpVerifies(lastSeen(), "another-secret")).toBe(false);
    const paid = await getPayment("TEST-token", paymentId, base);
    expect(paid).toEqual({ status: "approved", orderId: "order-mp-2" });
    expect(mapPaymentStatus(paid.status)).toBe("paid");
  });

  it("signs a forged delivery wrongly and a replay correctly", async () => {
    const { paymentId } = await createPixPayment(mpArgs("order-mp-3"));
    seen = [];
    await post(`/_mock/mp/payments/${paymentId}/status?bad=1`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(mpVerifies(lastSeen(), MP_SECRET)).toBe(false);
    const first = lastSeen().body;
    const r = await post(`/_mock/mp/payments/${paymentId}/replay`);
    expect(r.json).toEqual({ delivered: 200 });
    expect(seen).toHaveLength(2);
    expect(lastSeen().body).toBe(first);
    expect(mpVerifies(lastSeen(), MP_SECRET)).toBe(true);
  });
});

describe("mock Stripe Checkout", () => {
  it("creates an idempotent session under the public URL and refuses a live key", async () => {
    const a = await stripeSession("order-st-1");
    const b = await stripeSession("order-st-1");
    expect(a.url.startsWith(`${base}/stripe/pay/`)).toBe(true);
    expect(b.sessionId).toBe(a.sessionId);
    await expect(
      createCheckoutSession(stripeClient("sk_live_x", base), {
        orderId: "order-st-live",
        amountCents: 100,
        productName: "x",
        email: "a@example.test",
        appUrl: APP_URL,
      }),
    ).rejects.toThrow();
    const res = await fetch(`${base}/v1/checkout/sessions`, {
      method: "POST",
      headers: { Authorization: "Bearer sk_test_x", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        mode: "payment",
        currency: "brl",
        "line_items[0][price_data][unit_amount]": "100",
        cancel_url: `${APP_URL}/c`,
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("invalid_request_error");
  });

  const sessionForm = (extra: Record<string, string>) =>
    fetch(`${base}/v1/checkout/sessions`, {
      method: "POST",
      headers: { Authorization: "Bearer sk_test_x", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        mode: "payment",
        "line_items[0][price_data][currency]": "brl",
        "line_items[0][price_data][unit_amount]": "100",
        success_url: `${APP_URL}/s`,
        cancel_url: `${APP_URL}/c`,
        ...extra,
      }),
    });

  it("does not let a crafted form key pollute Object.prototype", async () => {
    const res = await sessionForm({ "line_items[0][__proto__][polluted]": "1", "metadata[constructor][prototype][polluted]": "1" });
    expect(res.status).toBe(200);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses a quantity that is not a positive integer", async () => {
    for (const bad of ["abc", "0", "-2", "1.5"]) {
      const res = await sessionForm({ "line_items[0][quantity]": bad });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { type: string } }).error.type).toBe("invalid_request_error");
    }
    expect((await sessionForm({ "line_items[0][quantity]": "3" })).status).toBe(200);
  });

  it("delivers events the app's own check accepts and maps", async () => {
    const { sessionId } = await stripeSession("order-st-2");
    seen = [];
    expect((await post(`/_mock/stripe/sessions/${sessionId}/complete`)).json).toEqual({ delivered: 200 });
    expect(seen).toHaveLength(1);
    expect(new URL(lastSeen().url, "http://x").pathname).toBe("/api/webhooks/stripe");
    const event = stripeEvent(lastSeen(), STRIPE_SECRET);
    expect(mapStripeEvent(event)).toEqual({ eventId: event.id, orderId: "order-st-2", status: "paid" });
    expect(() => stripeEvent(lastSeen(), "whsec_another")).toThrow();

    await post(`/_mock/stripe/sessions/${sessionId}/replay`);
    expect(seen).toHaveLength(2);
    expect(stripeEvent(lastSeen(), STRIPE_SECRET).id).toBe(event.id);

    await post(`/_mock/stripe/sessions/${sessionId}/refund`);
    expect(mapStripeEvent(stripeEvent(lastSeen(), STRIPE_SECRET))?.status).toBe("refunded");

    const fresh = await stripeSession("order-st-3");
    await post(`/_mock/stripe/sessions/${fresh.sessionId}/expire`);
    expect(mapStripeEvent(stripeEvent(lastSeen(), STRIPE_SECRET))).toMatchObject({ orderId: "order-st-3", status: "expired" });

    const other = await stripeSession("order-st-4");
    await post(`/_mock/stripe/sessions/${other.sessionId}/complete?bad=1`);
    expect(() => stripeEvent(lastSeen(), STRIPE_SECRET)).toThrow();
  });
});
