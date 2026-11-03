import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPixPayment, getPayment, mapPaymentStatus, paymentsUrl, verifyWebhookSignature } from "./mercadopago";

const secret = "test-secret";
const now = 1_793_385_000_000;
const ts = String(now / 1000 - 10);

function sign(dataId: string, requestId: string, timestamp = ts, key = secret) {
  const v1 = createHmac("sha256", key).update(`id:${dataId};request-id:${requestId};ts:${timestamp};`).digest("hex");
  return `ts=${timestamp},v1=${v1}`;
}

describe("verifyWebhookSignature", () => {
  const base = { xRequestId: "req-1", dataId: "123456", secret, now };

  it("accepts a correctly signed notification", () => {
    expect(verifyWebhookSignature({ ...base, xSignature: sign("123456", "req-1") })).toBe(true);
  });

  it("rejects a signature made with another secret", () => {
    expect(verifyWebhookSignature({ ...base, xSignature: sign("123456", "req-1", ts, "other") })).toBe(false);
  });

  it("rejects a notification whose payment id was swapped", () => {
    expect(verifyWebhookSignature({ ...base, dataId: "999999", xSignature: sign("123456", "req-1") })).toBe(false);
  });

  it("rejects a replay older than five minutes", () => {
    const old = String(now / 1000 - 600);
    expect(verifyWebhookSignature({ ...base, xSignature: sign("123456", "req-1", old) })).toBe(false);
  });

  it("accepts a timestamp sent in milliseconds", () => {
    const ms = String(now - 10_000);
    expect(verifyWebhookSignature({ ...base, xSignature: sign("123456", "req-1", ms) })).toBe(true);
  });

  it("signs alphanumeric ids in lower case", () => {
    expect(verifyWebhookSignature({ ...base, dataId: "ABC123", xSignature: sign("abc123", "req-1") })).toBe(true);
  });

  it("rejects missing headers and malformed signatures", () => {
    expect(verifyWebhookSignature({ ...base, xSignature: null })).toBe(false);
    expect(verifyWebhookSignature({ ...base, xRequestId: null, xSignature: sign("123456", "req-1") })).toBe(false);
    expect(verifyWebhookSignature({ ...base, xSignature: "garbage" })).toBe(false);
    expect(verifyWebhookSignature({ ...base, xSignature: `ts=${ts},v1=short` })).toBe(false);
  });
});

describe("paymentsUrl", () => {
  it("defaults to the real API", () => {
    expect(paymentsUrl()).toBe("https://api.mercadopago.com/v1/payments");
  });

  it("uses a given base, with or without trailing slashes", () => {
    expect(paymentsUrl("http://127.0.0.1:4010")).toBe("http://127.0.0.1:4010/v1/payments");
    expect(paymentsUrl("http://127.0.0.1:4010//")).toBe("http://127.0.0.1:4010/v1/payments");
  });
});

describe("MP_API_BASE override", () => {
  async function withServer(reply: unknown, run: (base: string, seen: { method?: string; url?: string }) => Promise<void>) {
    const seen: { method?: string; url?: string } = {};
    const server = createServer((req, res) => {
      seen.method = req.method;
      seen.url = req.url;
      req.resume();
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
    } finally {
      server.close();
    }
  }

  it("createPixPayment posts to the given base", async () => {
    const reply = { id: 77, point_of_interaction: { transaction_data: { qr_code: "code", qr_code_base64: "b64" } } };
    await withServer(reply, async (apiBase, seen) => {
      const out = await createPixPayment({
        accessToken: "TEST-x",
        orderId: "order-1",
        amountCents: 1000,
        description: "Thing",
        payerEmail: "a@b.co",
        notificationUrl: "http://localhost:3000/api/webhooks/mercadopago",
        apiBase,
      });
      expect(out).toEqual({ paymentId: "77", copyPaste: "code", qrBase64: "b64" });
      expect(seen).toEqual({ method: "POST", url: "/v1/payments" });
    });
  });

  it("getPayment reads from the given base", async () => {
    await withServer({ status: "approved", external_reference: "order-1" }, async (apiBase, seen) => {
      expect(await getPayment("TEST-x", "77", apiBase)).toEqual({ status: "approved", orderId: "order-1" });
      expect(seen).toEqual({ method: "GET", url: "/v1/payments/77" });
    });
  });
});

describe("mapPaymentStatus", () => {
  it("maps final states and ignores in-flight ones", () => {
    expect(mapPaymentStatus("approved")).toBe("paid");
    expect(mapPaymentStatus("rejected")).toBe("failed");
    expect(mapPaymentStatus("cancelled")).toBe("failed");
    expect(mapPaymentStatus("refunded")).toBe("refunded");
    expect(mapPaymentStatus("charged_back")).toBe("refunded");
    expect(mapPaymentStatus("pending")).toBeNull();
    expect(mapPaymentStatus("in_process")).toBeNull();
  });
});
