import { createHmac, timingSafeEqual } from "node:crypto";
import type { OrderStatus } from "./orders";

// The payments endpoint, on the real API unless a base is given (a local
// stand-in for development).
export function paymentsUrl(apiBase?: string): string {
  const base = (apiBase ?? "https://api.mercadopago.com").replace(/\/+$/, "");
  return `${base}/v1/payments`;
}

export type PixCharge = { paymentId: string; copyPaste: string; qrBase64: string };

// Creates a PIX charge. The order id is both the idempotency key, so a
// double-clicked button cannot charge twice, and the external reference
// that ties the webhook back to the order.
export async function createPixPayment(args: {
  accessToken: string;
  orderId: string;
  amountCents: number;
  description: string;
  payerEmail: string;
  notificationUrl: string;
  apiBase?: string;
}): Promise<PixCharge> {
  const res = await fetch(paymentsUrl(args.apiBase), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": args.orderId,
    },
    body: JSON.stringify({
      transaction_amount: args.amountCents / 100,
      description: args.description,
      payment_method_id: "pix",
      payer: { email: args.payerEmail },
      external_reference: args.orderId,
      notification_url: args.notificationUrl,
      // PIX codes stay payable for 30 minutes.
      date_of_expiration: new Date(Date.now() + 30 * 60_000).toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`Mercado Pago ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const tx = body.point_of_interaction?.transaction_data;
  return { paymentId: String(body.id), copyPaste: tx?.qr_code ?? "", qrBase64: tx?.qr_code_base64 ?? "" };
}

// The webhook body carries only the payment id, so the status is always read
// back from the API rather than trusted from the request.
export async function getPayment(accessToken: string, paymentId: string, apiBase?: string) {
  const res = await fetch(`${paymentsUrl(apiBase)}/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Mercado Pago ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return { status: String(body.status), orderId: String(body.external_reference ?? "") };
}

export function mapPaymentStatus(status: string): OrderStatus | null {
  switch (status) {
    case "approved":
      return "paid";
    case "rejected":
    case "cancelled":
      return "failed";
    case "refunded":
    case "charged_back":
      return "refunded";
    default:
      // pending, in_process, authorized, in_mediation: nothing to record yet.
      return null;
  }
}

// Mercado Pago signs webhooks in the x-signature header as "ts=<unix>,v1=<hex>",
// an HMAC-SHA256 over "id:<data.id>;request-id:<x-request-id>;ts:<ts>;".
// Alphanumeric ids are signed in lower case.
export function verifyWebhookSignature(args: {
  xSignature: string | null;
  xRequestId: string | null;
  dataId: string | null;
  secret: string;
  maxAgeSeconds?: number;
  now?: number;
}): boolean {
  if (!args.xSignature || !args.xRequestId || !args.dataId) return false;
  const parts = Object.fromEntries(
    args.xSignature.split(",").map((p) => p.trim().split("=", 2) as [string, string]),
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;

  // A replayed old notification is refused. ts is in seconds; accept
  // milliseconds too, since both have been seen in the wild.
  const sentSeconds = ts.length > 10 ? Number(ts) / 1000 : Number(ts);
  const ageSeconds = (args.now ?? Date.now()) / 1000 - sentSeconds;
  if (!(ageSeconds < (args.maxAgeSeconds ?? 300))) return false;

  const id = /^[a-z0-9]+$/i.test(args.dataId) ? args.dataId.toLowerCase() : args.dataId;
  const manifest = `id:${id};request-id:${args.xRequestId};ts:${ts};`;
  const expected = createHmac("sha256", args.secret).update(manifest).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}
