import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Bot, BotReply } from "./bot.js";
import { MESSAGES } from "./handler.js";
import { MemoryStore } from "./store.js";
import type { Sender } from "./whatsapp.js";

// The real Express app on a random port, with WhatsApp and Claude replaced
// by fakes that record what they were asked to do.
const config = { verifyToken: "verify-me", appSecret: "app-secret", adminUser: "admin", adminPassword: "pw" };
const auth = "Basic " + Buffer.from("admin:pw").toString("base64");
const customer = "5519999990000";

let server: Server;
let base: string;
let store: MemoryStore;
let sent: { to: string; body: string }[];
let botReplies: (BotReply | Error)[];
let botCalls: number;
// Set to make every send fail the way Graph refuses a bad token.
let sendFails: boolean;
let idle: () => Promise<void>;

beforeEach(async () => {
  store = new MemoryStore();
  sent = [];
  botReplies = [];
  botCalls = 0;
  sendFails = false;
  const sender: Sender = {
    sendText: async (to, body) => {
      if (sendFails) throw new Error("WhatsApp 401: Invalid OAuth access token");
      sent.push({ to, body });
      return `wamid.out.${sent.length}`;
    },
  };
  const bot: Bot = {
    reply: async () => {
      botCalls++;
      const next = botReplies.shift() ?? { kind: "text", text: "resposta do bot" };
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const created = createApp({ store, sender, bot, config });
  idle = created.idle;
  server = created.app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

let seq = 0;
function inbound(text: string | null, wamid = `wamid.in.${++seq}`) {
  const message =
    text === null
      ? { id: wamid, from: customer, timestamp: String(Math.floor(Date.now() / 1000)), type: "audio", audio: {} }
      : { id: wamid, from: customer, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } };
  return JSON.stringify({
    entry: [{ changes: [{ value: { contacts: [{ wa_id: customer, profile: { name: "Ana" } }], messages: [message] } }] }],
  });
}

async function deliver(body: string, signature?: string) {
  const res = await fetch(`${base}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature ?? "sha256=" + createHmac("sha256", config.appSecret).update(body).digest("hex"),
    },
    body,
  });
  await idle();
  return res.status;
}

const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${base}/admin${path}`, { redirect: "manual", ...init, headers: { authorization: auth, ...init.headers } });
const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

describe("webhook registration", () => {
  it("echoes the challenge for the right verify token only", async () => {
    const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`);
    expect(await ok.text()).toBe("42");
    const bad = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`);
    expect(bad.status).toBe(403);
  });
});

describe("customer messages", () => {
  it("refuses an unsigned or forged webhook without answering", async () => {
    expect(await deliver(inbound("Oi"), "sha256=" + "0".repeat(64))).toBe(401);
    expect(sent).toEqual([]);
  });

  it("answers a text message with the bot's reply and stores both", async () => {
    expect(await deliver(inbound("Vocês abrem hoje?"))).toBe(200);
    expect(sent).toEqual([{ to: customer, body: "resposta do bot" }]);
    expect((await store.history(customer, 10)).map((m) => m.author)).toEqual(["customer", "bot"]);
  });

  it("answers a message Meta delivers twice only once", async () => {
    const body = inbound("Oi", "wamid.same");
    await deliver(body);
    await deliver(body);
    expect(sent).toHaveLength(1);
    expect(botCalls).toBe(1);
  });

  it("hands off on request without calling the model, then stays quiet", async () => {
    await deliver(inbound("quero falar com um atendente"));
    expect(botCalls).toBe(0);
    expect(sent.at(-1)?.body).toBe(MESSAGES.handoff);
    expect((await store.getConversation(customer))?.mode).toBe("human");

    await deliver(inbound("alô?"));
    expect(sent).toHaveLength(1);
  });

  it("hands off when the model calls the handoff tool", async () => {
    botReplies.push({ kind: "handoff", reason: "pedido atrasado", text: "Já chamo alguém." });
    await deliver(inbound("Meu pedido não chegou"));
    expect(sent.at(-1)?.body).toBe("Já chamo alguém.");
    const c = await store.getConversation(customer);
    expect(c?.mode).toBe("human");
    expect(c?.handoffReason).toBe("pedido atrasado");
  });

  it("tells the customer and hands off when the bot fails", async () => {
    botReplies.push(new Error("API down"));
    await deliver(inbound("Oi"));
    expect(sent.at(-1)?.body).toBe(MESSAGES.error);
    expect((await store.getConversation(customer))?.mode).toBe("human");
  });

  it("shows a reply WhatsApp refused on the dashboard and hands the conversation over", async () => {
    sendFails = true;
    expect(await deliver(inbound("Vocês abrem hoje?"))).toBe(200);
    const c = await store.getConversation(customer);
    expect(c?.mode).toBe("human");
    expect(c?.handoffReason).toBe("o WhatsApp recusou a resposta do bot");
    expect(await (await admin("")).text()).toContain("Não entregue: </span>resposta do bot");
    const html = await (await admin(`/c/${customer}`)).text();
    expect(html).toContain("resposta do bot");
    expect(html).toContain("Não entregue: WhatsApp 401: Invalid OAuth access token");
  });

  it("keeps the handoff reason when the handoff message itself is refused", async () => {
    sendFails = true;
    botReplies.push({ kind: "handoff", reason: "pedido atrasado", text: "Já chamo alguém." });
    await deliver(inbound("Meu pedido não chegou"));
    expect((await store.getConversation(customer))?.handoffReason).toBe("pedido atrasado");
  });

  it("asks for text when the customer sends audio", async () => {
    await deliver(inbound(null));
    expect(sent.at(-1)?.body).toBe(MESSAGES.textOnly);
    expect(botCalls).toBe(0);
  });
});

describe("dashboard", () => {
  it("requires the admin login", async () => {
    expect((await fetch(`${base}/admin`)).status).toBe(401);
    const wrong = "Basic " + Buffer.from("admin:nope").toString("base64");
    expect((await fetch(`${base}/admin`, { headers: { authorization: wrong } })).status).toBe(401);
  });

  it("escapes what customers write", async () => {
    await deliver(inbound("<script>alert(1)</script>"));
    const html = await (await admin(`/c/${customer}`)).text();
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
  });

  it("lets an attendant reply, which takes the conversation from the bot", async () => {
    await deliver(inbound("Oi"));
    const res = await admin(`/c/${customer}/reply`, form({ body: "Aqui é a Júlia!" }));
    expect(res.status).toBe(303);
    expect(sent.at(-1)).toEqual({ to: customer, body: "Aqui é a Júlia!" });
    expect((await store.getConversation(customer))?.mode).toBe("human");
  });

  it("keeps an attendant reply WhatsApp refused in the thread, marked as not delivered", async () => {
    await deliver(inbound("Oi"));
    sendFails = true;
    const res = await admin(`/c/${customer}/reply`, form({ body: "Aqui é a Júlia!" }));
    expect(res.headers.get("location")).toContain("error=");
    const html = await (await admin(`/c/${customer}`)).text();
    expect(html).toContain("Aqui é a Júlia!");
    expect(html).toContain("Não entregue:");
  });

  it("refuses a free-form reply outside the 24-hour window", async () => {
    await store.recordInbound({ wamid: "old", waId: customer, name: "Ana", body: "Oi", at: new Date(Date.now() - 25 * 3600_000) });
    const res = await admin(`/c/${customer}/reply`, form({ body: "Ainda aí?" }));
    expect(res.headers.get("location")).toContain("error=");
    expect(sent).toEqual([]);
  });

  it("refuses a form posted from another site", async () => {
    await deliver(inbound("Oi"));
    const res = await admin(`/c/${customer}/mode`, { ...form({ mode: "human" }), headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("hands a conversation back to the bot", async () => {
    await deliver(inbound("falar com atendente"));
    await admin(`/c/${customer}/mode`, form({ mode: "bot" }));
    await deliver(inbound("Qual o preço da margherita?"));
    expect(botCalls).toBe(1);
    expect(sent.at(-1)?.body).toBe("resposta do bot");
  });
});
