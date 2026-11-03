import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { listPage, mentionPage } from "./admin.js";
import { errorText, handleMention } from "./handler.js";
import { parseWebhook, verifySignature, type Graph } from "./instagram.js";
import type { Store } from "./store.js";

export type AppConfig = { verifyToken: string; appSecret: string; adminUser: string; adminPassword: string };

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createApp(deps: { store: Store; graph: Graph; config: AppConfig }) {
  const { store, graph, config } = deps;
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
    // first and work after. Duplicates are caught by the mention key.
    res.sendStatus(200);
    for (const event of parseWebhook(payload)) {
      const job = handleMention(event, deps).catch((err) => console.error("webhook job failed", err));
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
  // A form posted from another site cannot act with the operator's login.
  // An Origin of "null" (a sandboxed or redirected page) or one that does not
  // parse is refused the same way.
  const originHost = (origin: string) => {
    try {
      return new URL(origin).host;
    } catch {
      return null;
    }
  };
  admin.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.header("origin");
    if (req.method === "POST" && origin && originHost(origin) !== req.header("host")) {
      res.sendStatus(403);
      return;
    }
    next();
  });
  admin.use(express.urlencoded({ extended: false, limit: "64kb" }));

  admin.get("/", async (_req, res) => {
    res.type("html").send(listPage(await store.listMentions()));
  });

  // A route id is a stored mention's number; anything else is not found.
  const idOf = (raw: string | undefined) => (/^\d+$/.test(raw ?? "") ? Number(raw) : null);

  admin.get("/m/:id", async (req, res) => {
    const id = idOf(req.params.id);
    const m = id === null ? null : await store.getMention(id);
    if (!m) {
      res.sendStatus(404);
      return;
    }
    res.type("html").send(mentionPage(m, String(req.query.error ?? "")));
  });

  admin.post("/m/:id/reply", async (req, res) => {
    const id = idOf(req.params.id);
    const m = id === null ? null : await store.getMention(id);
    if (!m) {
      res.sendStatus(404);
      return;
    }
    const body = String(req.body?.body ?? "").trim();
    if (!body) {
      res.sendStatus(400);
      return;
    }
    const back = `/admin/m/${m.id}`;
    try {
      const graphId = await graph.reply({ igUserId: m.igUserId, mediaId: m.mediaId, commentId: m.commentId }, body);
      await store.recordReply(m.id, body, graphId, null);
      res.redirect(303, back);
    } catch (err) {
      console.error(`admin reply to mention ${m.id} failed`, err);
      await store.recordReply(m.id, body, null, errorText(err));
      res.redirect(303, `${back}?error=${encodeURIComponent("O Instagram recusou a resposta.")}`);
    }
  });

  app.use("/admin", admin);

  // For tests and graceful shutdown: resolves once queued mentions are handled.
  const idle = async () => {
    while (inFlight.size) await Promise.all([...inFlight]);
  };
  return { app, idle };
}
