import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { Bot } from "../bot.js";
import { MemoryStore } from "../store.js";
import { CloudApiSender, graphErrorMessage, type Sender } from "../whatsapp.js";
import { createGraphMock } from "./graph-mock.js";

// The mock on one random port and the real app on another, joined the way the
// two run side by side: the bot sends through the mock, the mock delivers
// signed webhooks to the bot.
const customer = "5519999990000";
const phoneNumberId = "100000000000001";
const botAppSecret = "app-secret";
const config = { verifyToken: "verify-me", appSecret: botAppSecret, adminUser: "admin", adminPassword: "pw" };

const servers: Server[] = [];
async function listen(app: { listen: (port: number) => Server }): Promise<string> {
  const server = app.listen(0);
  servers.push(server);
  await new Promise((r) => server.once("listening", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function setup(o: { senderToken?: string; mockSecret?: string; refuseTo?: string[] } = {}) {
  const store = new MemoryStore();
  let sender: Sender | undefined;
  const bot: Bot = { reply: async () => ({ kind: "text", text: "resposta do bot" }) };
  const created = createApp({ store, sender: { sendText: (to, body) => sender!.sendText(to, body) }, bot, config });
  const appBase = await listen(created.app);
  const mock = createGraphMock({
    token: "mock-token",
    phoneNumberId,
    appSecret: o.mockSecret ?? botAppSecret,
    botWebhookUrl: `${appBase}/webhook`,
    refuseTo: o.refuseTo,
  });
  const mockBase = await listen(mock.app);
  sender = new CloudApiSender(o.senderToken ?? "mock-token", phoneNumberId, "v21.0", mockBase);
  const inbound = async (text: string, name = "Ana") => {
    const res = await fetch(`${mockBase}/mock/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: customer, name, text }),
    });
    const json = await res.json();
    await created.idle();
    return json as { ok: boolean; status: number };
  };
  const chat = async () => (await fetch(`${mockBase}/chat/${customer}`)).text();
  return { store, sender, mock, mockBase, inbound, chat, idle: created.idle };
}

describe("graph mock", () => {
  it("delivers a signed webhook the bot answers, and shows the reply on the chat page", async () => {
    const t = await setup();
    expect(await t.inbound("Vocês abrem hoje?")).toEqual({ ok: true, status: 200 });
    expect(t.mock.sent).toHaveLength(1);
    expect(t.mock.sent[0]).toMatchObject({ to: customer, body: "resposta do bot" });
    expect(t.mock.sent[0]!.wamid).toMatch(/^wamid\.mock\./);
    const html = await t.chat();
    expect(html).toContain("resposta do bot");
    expect(html).toContain("Vocês abrem hoje?");
    expect(html).toContain('<meta http-equiv="refresh" content="3">');
  });

  it("delivers what the customer types into the chat form", async () => {
    const t = await setup();
    const res = await fetch(`${t.mockBase}/chat/${customer}/send`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ body: "Oi", name: "Ana" }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/chat/${customer}`);
    await t.idle();
    expect((await t.store.history(customer, 10)).map((m) => m.body)).toContain("Oi");
  });

  it("refuses a wrong sender token the way Graph does, and the bot hands off", async () => {
    const t = await setup({ senderToken: "wrong" });
    const raw = await fetch(`${t.mockBase}/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: JSON.stringify({ to: customer, text: { body: "x" } }),
    });
    expect(raw.status).toBe(401);
    expect(((await raw.json()) as any).error.message).toContain("Invalid OAuth access token");

    await t.inbound("Vocês abrem hoje?");
    expect(t.mock.sent).toEqual([]);
    const c = await t.store.getConversation(customer);
    expect(c?.mode).toBe("human");
    expect(c?.handoffReason).toBe("o WhatsApp recusou a resposta do bot");
    const failed = (await t.store.history(customer, 10)).find((m) => m.author === "bot");
    expect(failed?.sendError).toContain("Invalid OAuth access token");
  });

  it("refuses a number in refuseTo with the re-engagement error", async () => {
    const t = await setup({ refuseTo: [customer] });
    const err = await t.sender!.sendText(customer, "oi").catch((e: Error) => e.message);
    expect(err).toBe(graphErrorMessage(400, JSON.stringify({ error: { message: "Re-engagement message" } })));
    const raw = await fetch(`${t.mockBase}/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { authorization: "Bearer mock-token", "content-type": "application/json" },
      body: JSON.stringify({ to: customer, text: { body: "x" } }),
    });
    expect(((await raw.json()) as any).error.code).toBe(131047);
    expect(t.mock.sent).toEqual([]);
  });

  it("refuses another phone number id", async () => {
    const t = await setup();
    const raw = await fetch(`${t.mockBase}/v21.0/999/messages`, {
      method: "POST",
      headers: { authorization: "Bearer mock-token", "content-type": "application/json" },
      body: JSON.stringify({ to: customer, text: { body: "x" } }),
    });
    expect(raw.status).toBe(400);
    expect(((await raw.json()) as any).error.code).toBe(100);
  });

  it("escapes what customers write and says it is a mock", async () => {
    const t = await setup();
    await t.inbound("<script>alert(1)</script>", "Ana <b>");
    const html = await t.chat();
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("Ana <b>");
    expect(html).toContain("Mock WhatsApp: a local stand-in for the Cloud API, not WhatsApp");
    expect(html).toMatch(/<title>[^<]*Mock/);
  });

  it("shows an error line when the app rejects the signature", async () => {
    const t = await setup({ mockSecret: "another-secret" });
    expect(await t.inbound("Oi")).toEqual({ ok: true, status: 401 });
    expect(t.mock.sent).toEqual([]);
    const html = await t.chat();
    expect(html).toContain("401");
    expect(html).toContain('class="err"');
  });

  it("answers 404 for a chat path with no digits and records no customer", async () => {
    const t = await setup();
    expect((await fetch(`${t.mockBase}/chat/abc`)).status).toBe(404);
    expect(await (await fetch(`${t.mockBase}/chat`)).text()).not.toContain("/chat/");
  });

  it("lists customers and answers health", async () => {
    const t = await setup();
    await t.inbound("Oi");
    expect(await (await fetch(`${t.mockBase}/chat`)).text()).toContain(`href="/chat/${customer}"`);
    expect(await (await fetch(`${t.mockBase}/health`)).json()).toEqual({ ok: true });
  });
});
