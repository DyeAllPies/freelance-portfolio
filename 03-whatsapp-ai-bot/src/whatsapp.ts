import { createHmac, timingSafeEqual } from "node:crypto";

export type Inbound = {
  wamid: string;
  waId: string;
  name: string;
  // "text", "image", "audio", ...; only text carries a body.
  type: string;
  text: string | null;
  sentAt: Date;
};

export interface Sender {
  sendText(to: string, body: string): Promise<string>;
}

// Meta signs each webhook body with the app secret: X-Hub-Signature-256 is
// "sha256=" + HMAC-SHA256(raw body). It must be checked on the raw bytes,
// before any JSON parsing.
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", appSecret).update(rawBody).digest("hex"));
  const given = Buffer.from(header.slice("sha256=".length));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// Pulls the customer messages out of a webhook payload. Delivery and read
// receipts arrive on the same webhook under "statuses" and are skipped.
export function parseWebhook(payload: any): Inbound[] {
  const out: Inbound[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      const names = new Map<string, string>(
        (value?.contacts ?? []).map((c: any) => [String(c.wa_id), String(c.profile?.name ?? "")]),
      );
      for (const m of value?.messages ?? []) {
        if (!m?.id || !m?.from) continue;
        out.push({
          wamid: String(m.id),
          waId: String(m.from),
          name: names.get(String(m.from)) ?? "",
          type: String(m.type ?? "unknown"),
          text: m.type === "text" ? String(m.text?.body ?? "") : null,
          sentAt: new Date(Number(m.timestamp ?? 0) * 1000),
        });
      }
    }
  }
  return out;
}

// Free-form replies are allowed only within 24 hours of the customer's last
// message; after that, WhatsApp accepts only approved templates.
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
export function withinServiceWindow(lastInboundAt: Date | null, now = new Date()): boolean {
  return lastInboundAt !== null && now.getTime() - lastInboundAt.getTime() < SERVICE_WINDOW_MS;
}

// Graph answers an error with {"error":{"message":...}}; the dashboard shows
// that message rather than the raw JSON.
export function graphErrorMessage(status: number, body: string): string {
  let message = body;
  try {
    message = JSON.parse(body)?.error?.message || body;
  } catch {}
  return `WhatsApp ${status}: ${message}`;
}

export class CloudApiSender implements Sender {
  constructor(
    private token: string,
    private phoneNumberId: string,
    private apiVersion = "v21.0",
    private graphBase = "https://graph.facebook.com",
  ) {}

  async sendText(to: string, body: string): Promise<string> {
    const base = this.graphBase.replace(/\/$/, "");
    const res = await fetch(`${base}/${this.apiVersion}/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        // WhatsApp caps a text message at 4096 characters.
        text: { preview_url: false, body: body.slice(0, 4096) },
      }),
    });
    if (!res.ok) throw new Error(graphErrorMessage(res.status, await res.text()));
    const json: any = await res.json();
    return String(json.messages?.[0]?.id ?? "");
  }
}
