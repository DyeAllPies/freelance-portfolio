import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CloudApiSender, graphErrorMessage, parseWebhook, SERVICE_WINDOW_MS, verifySignature, withinServiceWindow } from "./whatsapp.js";

const secret = "app-secret";
const sign = (body: string, key = secret) => "sha256=" + createHmac("sha256", key).update(body).digest("hex");

describe("verifySignature", () => {
  const body = '{"object":"whatsapp_business_account"}';

  it("accepts the body Meta signed", () => {
    expect(verifySignature(Buffer.from(body), sign(body), secret)).toBe(true);
  });

  it("rejects another secret, a changed body, and missing or malformed headers", () => {
    expect(verifySignature(Buffer.from(body), sign(body, "other"), secret)).toBe(false);
    expect(verifySignature(Buffer.from(body + " "), sign(body), secret)).toBe(false);
    expect(verifySignature(Buffer.from(body), undefined, secret)).toBe(false);
    expect(verifySignature(Buffer.from(body), "sha1=abc", secret)).toBe(false);
    expect(verifySignature(Buffer.from(body), "sha256=short", secret)).toBe(false);
  });
});

describe("parseWebhook", () => {
  it("reads text and media messages with the contact's name", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: "5519999990000", profile: { name: "Ana" } }],
                messages: [
                  { id: "wamid.1", from: "5519999990000", timestamp: "1793385000", type: "text", text: { body: "Oi" } },
                  { id: "wamid.2", from: "5519999990000", timestamp: "1793385001", type: "image", image: {} },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(parseWebhook(payload)).toEqual([
      { wamid: "wamid.1", waId: "5519999990000", name: "Ana", type: "text", text: "Oi", sentAt: new Date(1793385000_000) },
      { wamid: "wamid.2", waId: "5519999990000", name: "Ana", type: "image", text: null, sentAt: new Date(1793385001_000) },
    ]);
  });

  it("skips delivery receipts and junk", () => {
    expect(parseWebhook({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.1", status: "read" }] } }] }] })).toEqual([]);
    expect(parseWebhook(null)).toEqual([]);
    expect(parseWebhook({ entry: [{ changes: [{ value: { messages: [{ type: "text" }] } }] }] })).toEqual([]);
  });
});

describe("withinServiceWindow", () => {
  const now = new Date("2026-10-30T20:00:00Z");
  it("is open for 24 hours after the customer's last message", () => {
    expect(withinServiceWindow(new Date(now.getTime() - SERVICE_WINDOW_MS + 60_000), now)).toBe(true);
    expect(withinServiceWindow(new Date(now.getTime() - SERVICE_WINDOW_MS), now)).toBe(false);
    expect(withinServiceWindow(null, now)).toBe(false);
  });
});

describe("CloudApiSender", () => {
  async function urlSent(sender: CloudApiSender): Promise<string> {
    const real = globalThis.fetch;
    let url = "";
    globalThis.fetch = (async (input: any) => {
      url = String(input);
      return new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      await sender.sendText("5519999990000", "Oi");
    } finally {
      globalThis.fetch = real;
    }
    return url;
  }

  it("posts to graph.facebook.com by default", async () => {
    expect(await urlSent(new CloudApiSender("t", "123"))).toBe("https://graph.facebook.com/v21.0/123/messages");
  });

  it("posts to a custom base, ignoring one trailing slash", async () => {
    expect(await urlSent(new CloudApiSender("t", "123", "v21.0", "http://localhost:3100"))).toBe("http://localhost:3100/v21.0/123/messages");
    expect(await urlSent(new CloudApiSender("t", "123", "v21.0", "http://localhost:3100/"))).toBe("http://localhost:3100/v21.0/123/messages");
  });
});

describe("graphErrorMessage", () => {
  it("keeps Graph's own message from its error JSON", () => {
    const body = '{"error":{"message":"Invalid OAuth access token - Cannot parse access token","type":"OAuthException","code":190}}';
    expect(graphErrorMessage(401, body)).toBe("WhatsApp 401: Invalid OAuth access token - Cannot parse access token");
  });

  it("falls back to the raw body when it is not Graph's JSON", () => {
    expect(graphErrorMessage(502, "Bad Gateway")).toBe("WhatsApp 502: Bad Gateway");
  });
});
