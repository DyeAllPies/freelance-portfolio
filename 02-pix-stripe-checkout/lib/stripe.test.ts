import type Stripe from "stripe";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createCheckoutSession, mapStripeEvent, stripeClient } from "./stripe";

function event(type: string, object: Record<string, unknown>): Stripe.Event {
  return { id: "evt_1", type, data: { object } } as unknown as Stripe.Event;
}

describe("mapStripeEvent", () => {
  const meta = { metadata: { order_id: "order-1" } };

  it("marks a paid checkout as paid", () => {
    expect(mapStripeEvent(event("checkout.session.completed", { ...meta, payment_status: "paid" }))).toEqual({
      eventId: "evt_1",
      orderId: "order-1",
      status: "paid",
    });
  });

  it("waits on a checkout completed but not yet paid", () => {
    expect(mapStripeEvent(event("checkout.session.completed", { ...meta, payment_status: "unpaid" }))).toBeNull();
  });

  it("maps a delayed payment's outcome", () => {
    expect(mapStripeEvent(event("checkout.session.async_payment_succeeded", { ...meta, payment_status: "paid" }))?.status).toBe("paid");
    expect(mapStripeEvent(event("checkout.session.async_payment_failed", meta))?.status).toBe("failed");
  });

  it("expires an abandoned checkout", () => {
    expect(mapStripeEvent(event("checkout.session.expired", meta))?.status).toBe("expired");
  });

  it("refunds only a fully refunded charge", () => {
    expect(mapStripeEvent(event("charge.refunded", { ...meta, refunded: true }))?.status).toBe("refunded");
    expect(mapStripeEvent(event("charge.refunded", { ...meta, refunded: false }))).toBeNull();
  });

  it("ignores events without an order or of other types", () => {
    expect(mapStripeEvent(event("checkout.session.expired", { metadata: {} }))).toBeNull();
    expect(mapStripeEvent(event("customer.created", meta))).toBeNull();
  });
});

describe("STRIPE_API_BASE override", () => {
  it("sends the request to the given local server and returns what it answered", async () => {
    const seen: { method?: string; url?: string; auth?: string } = {};
    const server = createServer((req, res) => {
      seen.method = req.method;
      seen.url = req.url;
      seen.auth = req.headers.authorization;
      req.resume();
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: "cs_test_x", url: "http://x/y" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const stripe = stripeClient("sk_test_dummy", `http://127.0.0.1:${port}`);
      const out = await createCheckoutSession(stripe, {
        orderId: "order-1",
        amountCents: 1000,
        productName: "Thing",
        email: "a@b.co",
        appUrl: "http://localhost:3000",
      });
      expect(out).toEqual({ sessionId: "cs_test_x", url: "http://x/y" });
      expect(seen.method).toBe("POST");
      expect(seen.url).toBe("/v1/checkout/sessions");
      expect(seen.auth).toBe("Bearer sk_test_dummy");
    } finally {
      server.close();
    }
  });

  it("names STRIPE_API_BASE when the base is not a URL", () => {
    expect(() => stripeClient("sk_test_dummy", "not a url")).toThrow(/STRIPE_API_BASE/);
  });
});

describe("webhook signature", () => {
  const stripe = stripeClient("sk_test_dummy");
  const secret = "whsec_test";
  const payload = JSON.stringify({ id: "evt_1", object: "event", type: "checkout.session.expired", data: { object: {} } });

  it("accepts a signed payload and rejects a tampered one", () => {
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
    expect(stripe.webhooks.constructEvent(payload, header, secret).id).toBe("evt_1");
    expect(() => stripe.webhooks.constructEvent(payload.replace("evt_1", "evt_2"), header, secret)).toThrow();
  });
});
