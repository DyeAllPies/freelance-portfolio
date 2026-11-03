import { createHmac, randomBytes } from "node:crypto";
import express from "express";
import { escapeHtml } from "../admin.js";

// A local stand-in for the WhatsApp Cloud API: it accepts the bot's send calls,
// signs and delivers webhooks for what a customer types, and shows the
// customer's side of the chat. It is not WhatsApp and says so on every page.

export type MockOptions = {
  token: string;
  phoneNumberId: string;
  appSecret: string;
  botWebhookUrl: string;
  // Numbers the mock refuses with the "re-engagement" error.
  refuseTo?: string[];
};

export type SentMessage = { to: string; body: string; wamid: string; at: Date };

type Line = { side: "left" | "right"; body: string; at: Date };

const graphError = (message: string, code: number, type = "OAuthException") => ({ error: { message, type, code } });

export function createGraphMock(opts: MockOptions) {
  const sent: SentMessage[] = [];
  const names = new Map<string, string>();
  const lines = new Map<string, Line[]>();
  const errors = new Map<string, string>();
  const refuse = new Set(opts.refuseTo ?? []);
  // Ids must stay unique across restarts: the bot's database keeps them.
  const run = Date.now().toString(36) + randomBytes(3).toString("hex");
  let n = 0;
  const nextId = (kind: string) => `wamid.${kind}.${run}.${++n}`;

  const touch = (waId: string, name?: string) => {
    if (!lines.has(waId)) lines.set(waId, []);
    if (name || !names.has(waId)) names.set(waId, name || names.get(waId) || "");
  };
  const add = (waId: string, line: Line) => {
    touch(waId);
    lines.get(waId)!.push(line);
  };

  // The payload the Cloud API webhook carries for one text message.
  const payload = (from: string, name: string, id: string, body: string) =>
    JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: from, profile: { name } }],
                messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }],
              },
            },
          ],
        },
      ],
    });

  // Records the customer's message, signs the exact bytes and posts them to the bot.
  async function deliver(waId: string, name: string, text: string): Promise<{ status: number | null; error: string }> {
    touch(waId, name);
    add(waId, { side: "right", body: text, at: new Date() });
    const raw = payload(waId, names.get(waId) ?? "", nextId("cust"), text);
    const signature = "sha256=" + createHmac("sha256", opts.appSecret).update(raw).digest("hex");
    try {
      const res = await fetch(opts.botWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": signature },
        body: raw,
      });
      if (res.ok) errors.delete(waId);
      else errors.set(waId, `O bot respondeu ${res.status} ao webhook.`);
      return { status: res.status, error: errors.get(waId) ?? "" };
    } catch (err) {
      const error = `Não foi possível falar com o bot: ${err instanceof Error ? err.message : String(err)}`;
      errors.set(waId, error);
      return { status: null, error };
    }
  }

  const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
  const hhmm = (d: Date) =>
    d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

  const page = (title: string, body: string, refresh = false) => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="3">` : ""}<title>Mock WhatsApp - ${escapeHtml(title)}</title>
<style>
:root{--bg:#efeae2;--card:#fff;--text:#1b1c20;--muted:#646675;--line:#e2e3e8;--in:#ffffff;--out:#d9fdd3;--warn:#b54708;--banner:#fff3cd}
@media (prefers-color-scheme:dark){:root{--bg:#0b141a;--card:#1c1d22;--text:#ececf1;--muted:#a1a2ae;--line:#2d2e36;--in:#202c33;--out:#005c4b;--warn:#f79009;--banner:#4a3b0a}}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--text)}
main{max-width:480px;margin:0 auto;padding:12px}a{color:inherit}
.banner{background:var(--banner);border:1px solid var(--warn);border-radius:8px;padding:8px 12px;font-size:13px;margin-bottom:12px}
.muted{color:var(--muted)}.err{color:var(--warn);font-size:13px;margin:8px 0}
.msg{max-width:80%;padding:6px 10px;border-radius:10px;margin:6px 0;white-space:pre-wrap;border:1px solid var(--line);overflow-wrap:anywhere}
.left{background:var(--in);margin-right:auto}.right{background:var(--out);margin-left:auto}
.time{font-size:11px;color:var(--muted);text-align:right}
input,textarea{padding:8px;background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:8px}
button{padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}.row input[name=body]{flex:1;min-width:0}
ul{padding-left:20px}
</style></head><body><main>
<div class="banner">Mock WhatsApp: a local stand-in for the Cloud API, not WhatsApp</div>
${body}</main></body></html>`;

  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // What the bot calls to send a message.
  app.post("/:version/:phoneNumberId/messages", express.json({ limit: "1mb" }), (req, res) => {
    if (req.header("authorization") !== `Bearer ${opts.token}`) {
      res.status(401).json(graphError("Invalid OAuth access token - Cannot parse access token", 190));
      return;
    }
    if (req.params.phoneNumberId !== opts.phoneNumberId) {
      res.status(400).json(graphError("Unsupported post request.", 100, "GraphMethodException"));
      return;
    }
    const to = String(req.body?.to ?? "");
    if (refuse.has(to)) {
      res.status(400).json(graphError("Re-engagement message", 131047));
      return;
    }
    const body = String(req.body?.text?.body ?? "");
    const wamid = nextId("mock");
    const at = new Date();
    sent.push({ to, body, wamid, at });
    add(to, { side: "left", body, at });
    res.json({ messaging_product: "whatsapp", contacts: [{ input: to, wa_id: to }], messages: [{ id: wamid }] });
  });

  // The customer's phone.
  app.get("/chat", (req, res) => {
    const number = digits(req.query.number);
    if (number) {
      touch(number, String(req.query.name ?? "").trim());
      res.redirect(303, `/chat/${encodeURIComponent(number)}`);
      return;
    }
    const items = [...lines.keys()]
      .map(
        (id) =>
          `<li><a href="/chat/${encodeURIComponent(id)}">${escapeHtml(names.get(id) || id)}</a> <span class="muted">+${escapeHtml(id)}</span></li>`,
      )
      .join("");
    res.type("html").send(
      page(
        "Clientes",
        `<h1>Clientes</h1>
${items ? `<ul>${items}</ul>` : `<p class="muted">Nenhum cliente ainda.</p>`}
<h2>Abrir uma conversa</h2>
<form class="row" method="get" action="/chat">
<input name="number" placeholder="Número, ex.: 5519999990000" required inputmode="numeric">
<input name="name" placeholder="Nome">
<button>Abrir</button></form>`,
      ),
    );
  });

  app.get("/chat/:waId", (req, res) => {
    const waId = digits(req.params.waId);
    if (!waId) {
      res.sendStatus(404);
      return;
    }
    touch(waId);
    const bubbles = (lines.get(waId) ?? [])
      .map((l) => `<div class="msg ${l.side}">${escapeHtml(l.body)}<div class="time">${escapeHtml(hhmm(l.at))}</div></div>`)
      .join("");
    const error = errors.get(waId);
    res.type("html").send(
      page(
        names.get(waId) || waId,
        `<p><a href="/chat">&larr; Clientes</a></p>
<h1>${escapeHtml(names.get(waId) || waId)} <span class="muted">+${escapeHtml(waId)}</span></h1>
${bubbles || `<p class="muted">Nenhuma mensagem ainda.</p>`}
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
<form class="row" method="post" action="/chat/${encodeURIComponent(waId)}/send">
<input type="hidden" name="name" value="${escapeHtml(names.get(waId) ?? "")}">
<input name="body" placeholder="Digite uma mensagem" required autocomplete="off">
<button>Enviar</button></form>`,
        true,
      ),
    );
  });

  app.post("/chat/:waId/send", express.urlencoded({ extended: false, limit: "64kb" }), async (req, res) => {
    const waId = digits(req.params.waId);
    const text = String(req.body?.body ?? "").trim();
    if (!waId || !text) {
      res.sendStatus(400);
      return;
    }
    await deliver(waId, String(req.body?.name ?? "").trim(), text);
    res.redirect(303, `/chat/${encodeURIComponent(waId)}`);
  });

  // The same delivery for scripts.
  app.post("/mock/inbound", express.json({ limit: "64kb" }), async (req, res) => {
    const waId = digits(req.body?.from);
    const text = String(req.body?.text ?? "").trim();
    if (!waId || !text) {
      res.status(400).json({ ok: false, error: "from and text are required" });
      return;
    }
    const result = await deliver(waId, String(req.body?.name ?? "").trim(), text);
    res.json({ ok: true, status: result.status });
  });

  return { app, sent };
}
