import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { conversationPage, listPage } from "./admin.js";
import type { Bot } from "./bot.js";
import { handleInbound, sendErrorText } from "./handler.js";
import type { Store } from "./store.js";
import { parseWebhook, verifySignature, withinServiceWindow, type Sender } from "./whatsapp.js";

export type AppConfig = { verifyToken: string; appSecret: string; adminUser: string; adminPassword: string };

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createApp(deps: { store: Store; sender: Sender; bot: Bot; config: AppConfig }) {
  const { store, sender, config } = deps;
  const app = express();
  const inFlight = new Set<Promise<unknown>>();

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Meta calls this once when the webhook is registered.
  app.get("/webhook", (req, res) => {
    const ok = req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === config.verifyToken;
    if (ok) res.type("text/plain").send(String(req.query["hub.challenge"] ?? ""));
    else res.sendStatus(403);
  });

  app.post("/webhook", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifySignature(raw, req.header("x-hub-signature-256"), config.appSecret)) {
      res.sendStatus(401);
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      res.sendStatus(400);
      return;
    }
    // Meta retries a webhook that is not acknowledged quickly, so answer
    // first and work after. Duplicates are caught by the message id.
    res.sendStatus(200);
    for (const msg of parseWebhook(payload)) {
      const job = handleInbound(msg, deps).catch((err) => console.error("webhook job failed", err));
      inFlight.add(job);
      job.finally(() => inFlight.delete(job));
    }
  });

  const admin = express.Router();
  admin.use((req: Request, res: Response, next: NextFunction) => {
    const [scheme, encoded] = (req.header("authorization") ?? "").split(" ");
    const [user, ...rest] = Buffer.from(encoded ?? "", "base64").toString().split(":");
    if (scheme === "Basic" && same(user ?? "", config.adminUser) && same(rest.join(":"), config.adminPassword)) {
      next();
      return;
    }
    res.set("WWW-Authenticate", 'Basic realm="admin"').sendStatus(401);
  });
  // A form posted from another site cannot act with the attendant's login.
  admin.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.header("origin");
    if (req.method === "POST" && origin && new URL(origin).host !== req.header("host")) {
      res.sendStatus(403);
      return;
    }
    next();
  });
  admin.use(express.urlencoded({ extended: false, limit: "64kb" }));

  admin.get("/", async (_req, res) => {
    res.type("html").send(listPage(await store.listConversations()));
  });

  admin.get("/c/:waId", async (req, res) => {
    const c = await store.getConversation(req.params.waId);
    if (!c) {
      res.sendStatus(404);
      return;
    }
    res.type("html").send(conversationPage(c, await store.history(c.waId, 200), String(req.query.error ?? "")));
  });

  admin.post("/c/:waId/reply", async (req, res) => {
    const c = await store.getConversation(req.params.waId);
    const body = String(req.body?.body ?? "").trim();
    if (!c || !body) {
      res.sendStatus(400);
      return;
    }
    const back = `/admin/c/${encodeURIComponent(c.waId)}`;
    if (!withinServiceWindow(c.lastInboundAt)) {
      res.redirect(303, `${back}?error=${encodeURIComponent("Fora da janela de 24 horas.")}`);
      return;
    }
    try {
      const wamid = await sender.sendText(c.waId, body);
      await store.recordOutbound(c.waId, "agent", body, wamid);
      // An attendant who replies owns the conversation from here.
      if (c.mode === "bot") await store.setMode(c.waId, "human", "atendente assumiu");
      res.redirect(303, back);
    } catch (err) {
      console.error(`admin reply to ${c.waId} failed`, err);
      await store.recordOutbound(c.waId, "agent", body, null, sendErrorText(err));
      res.redirect(303, `${back}?error=${encodeURIComponent("O WhatsApp recusou o envio.")}`);
    }
  });

  admin.post("/c/:waId/mode", async (req, res) => {
    const mode = req.body?.mode;
    if (mode !== "bot" && mode !== "human") {
      res.sendStatus(400);
      return;
    }
    await store.setMode(req.params.waId, mode, mode === "human" ? "atendente assumiu" : null);
    res.redirect(303, `/admin/c/${encodeURIComponent(req.params.waId)}`);
  });

  app.use("/admin", admin);

  // For tests and graceful shutdown: resolves once queued messages are handled.
  const idle = async () => {
    while (inFlight.size) await Promise.all([...inFlight]);
  };
  return { app, idle };
}
