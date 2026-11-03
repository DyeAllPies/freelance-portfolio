import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { GraphApiClient, parseWebhook, verifySignature } from "../instagram.js";
import { MemoryStore } from "../store.js";
import { createGraphMock, type MockOptions } from "./graph-mock.js";

const TOKEN = "test-token";
const SECRET = "test-app-secret";
const IG_USER = "17841400000000001";

type Received = { body: string; signature: string | undefined };

let servers: Server[];
let received: Received[];

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  servers.push(server);
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

// A tiny http server that records every webhook the mock delivers.
async function recordingTarget() {
  const { url } = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ body: Buffer.concat(chunks).toString("utf8"), signature: req.headers["x-hub-signature-256"] as string | undefined });
      res.statusCode = 200;
      res.end("ok");
    });
  });
  return `${url}/webhook`;
}

// The mock on a random port. opts is kept so a test can point webhookUrl at an app started afterwards.
async function startMock(over: Partial<MockOptions> = {}) {
  const opts: MockOptions = {
    accessToken: TOKEN,
    igUserId: IG_USER,
    appSecret: SECRET,
    webhookUrl: await recordingTarget(),
    publicUrl: "http://mock.test",
    ...over,
  };
  const mock = createGraphMock(opts);
  const { url } = await listen(mock.app);
  return { ...mock, opts, url, graph: new GraphApiClient(TOKEN, { baseUrl: url }) };
}

beforeEach(() => {
  servers = [];
  received = [];
});
afterEach(() => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))));

describe("the mock behind the real GraphApiClient", () => {
  it("returns an emitted comment mention's text, permalink and time", async () => {
    const m = await startMock();
    const { mediaId, commentId } = await m.emit({ kind: "comment", username: "ana", text: "Amei, @loja!" });
    const d = await m.graph.fetchMention({ igUserId: IG_USER, mediaId, commentId });
    expect(d).toMatchObject({ kind: "comment", text: "Amei, @loja!", username: null, mediaUrl: null });
    expect(d.permalink).toBe(`http://mock.test/__mock/p/${mediaId}`);
    expect(d.postedAt).toBeInstanceOf(Date);
  });

  it("returns an emitted media mention's caption, username, permalink and media URL", async () => {
    const m = await startMock();
    const { mediaId } = await m.emit({ kind: "media", username: "bruno", text: "olha @loja" });
    const d = await m.graph.fetchMention({ igUserId: IG_USER, mediaId, commentId: null });
    expect(d).toMatchObject({ kind: "media", text: "olha @loja", username: "bruno", mediaUrl: `http://mock.test/__mock/img/${mediaId}.svg` });
    expect(d.permalink).toBe(`http://mock.test/__mock/p/${mediaId}`);
  });

  it("gives a media emitted with mediaUrl null no media URL", async () => {
    const m = await startMock();
    const { mediaId } = await m.emit({ kind: "media", username: "bruno", text: "um reel", mediaUrl: null });
    const d = await m.graph.fetchMention({ igUserId: IG_USER, mediaId, commentId: null });
    expect(d.mediaUrl).toBeNull();
    const raw = await (await fetch(`${m.url}/v21.0/${IG_USER}?fields=${encodeURIComponent(`mentioned_media.media_id(${mediaId}){id,media_url}`)}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    expect(raw.mentioned_media).toEqual({ id: mediaId });
  });

  it("refuses a wrong token the way Graph does", async () => {
    const m = await startMock();
    const { mediaId, commentId } = await m.emit({ kind: "comment", username: "ana", text: "oi" });
    const bad = new GraphApiClient("not-the-token", { baseUrl: m.url });
    await expect(bad.fetchMention({ igUserId: IG_USER, mediaId, commentId })).rejects.toThrow(/^Instagram 401: Invalid OAuth access token/);
    const res = await fetch(`${m.url}/v21.0/${IG_USER}/mentions`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } });
  });

  it("also takes the token as an access_token query parameter", async () => {
    const m = await startMock();
    expect((await fetch(`${m.url}/v21.0/${IG_USER}?access_token=${TOKEN}`)).status).toBe(200);
    expect((await fetch(`${m.url}/v21.0/${IG_USER}?access_token=nope`)).status).toBe(401);
  });

  it("answers 400 for another Instagram user id", async () => {
    const m = await startMock();
    const res = await fetch(`${m.url}/v21.0/999?fields=${encodeURIComponent("mentioned_media.media_id(1){id}")}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(100);
  });

  it("answers 400 for a comment or media id it does not know", async () => {
    const m = await startMock();
    await expect(m.graph.fetchMention({ igUserId: IG_USER, mediaId: "1", commentId: "2" })).rejects.toThrow(/^Instagram 400: /);
    await expect(m.graph.fetchMention({ igUserId: IG_USER, mediaId: "1", commentId: null })).rejects.toThrow(/^Instagram 400: /);
  });

  it("records a reply to a comment mention with its comment id, and returns an id", async () => {
    const m = await startMock();
    const { mediaId, commentId } = await m.emit({ kind: "comment", username: "ana", text: "oi" });
    const id = await m.graph.reply({ igUserId: IG_USER, mediaId, commentId }, "Obrigada!");
    expect(id).toMatch(/^\d{17}$/);
    expect(m.state.replies).toEqual([{ id, message: "Obrigada!", mediaId, commentId }]);
  });

  it("records a reply to a caption mention without a comment id", async () => {
    const m = await startMock();
    const { mediaId } = await m.emit({ kind: "media", username: "bruno", text: "olha @loja" });
    await m.graph.reply({ igUserId: IG_USER, mediaId, commentId: null }, "Valeu!");
    expect(m.state.replies).toMatchObject([{ message: "Valeu!", mediaId, commentId: null }]);
  });

  it("rejects a reply naming an unknown media id", async () => {
    const m = await startMock();
    await expect(m.graph.reply({ igUserId: IG_USER, mediaId: "123", commentId: null }, "oi")).rejects.toThrow(/^Instagram 400/);
    expect(m.state.replies).toEqual([]);
  });

  it("rejects a reply without a message or a media_id", async () => {
    const m = await startMock();
    const post = (body: object) =>
      fetch(`${m.url}/v21.0/${IG_USER}/mentions`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    for (const body of [{ media_id: "1" }, { message: "oi" }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe(100);
    }
  });

  it("rejects a reply whose comment id belongs to another media", async () => {
    const m = await startMock();
    const a = await m.emit({ kind: "comment", username: "ana", text: "oi" });
    const b = await m.emit({ kind: "comment", username: "bia", text: "oi" });
    const res = await fetch(`${m.url}/v21.0/${IG_USER}/mentions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "oi", media_id: a.mediaId, comment_id: b.commentId }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(100);
    expect(m.state.replies).toEqual([]);
  });

  it("takes a urlencoded reply body", async () => {
    const m = await startMock();
    const { mediaId, commentId } = await m.emit({ kind: "comment", username: "ana", text: "oi" });
    const res = await fetch(`${m.url}/v21.0/${IG_USER}/mentions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ message: "oi", media_id: mediaId, comment_id: commentId! }).toString(),
    });
    expect(res.status).toBe(200);
    expect(m.state.replies).toHaveLength(1);
  });
});

describe("requested fields", () => {
  it("answers 400 code 100 for a field the mock does not model", async () => {
    const m = await startMock();
    const { mediaId, commentId } = await m.emit({ kind: "comment", username: "ana", text: "oi" });
    const get = (fields: string) => fetch(`${m.url}/v21.0/${IG_USER}?fields=${encodeURIComponent(fields)}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const top = await get(`mentioned_comment.comment_id(${commentId}){id,from}`);
    expect(top.status).toBe(400);
    expect(await top.json()).toMatchObject({ error: { code: 100, message: "(#100) Tried accessing nonexisting field (from)" } });
    const nested = await get(`mentioned_comment.comment_id(${commentId}){id,media{id,owner}}`);
    expect(nested.status).toBe(400);
    expect((await nested.json()).error.message).toBe("(#100) Tried accessing nonexisting field (owner)");
    const media = await get(`mentioned_media.media_id(${mediaId}){id,like_count}`);
    expect(media.status).toBe(400);
    expect((await media.json()).error.message).toBe("(#100) Tried accessing nonexisting field (like_count)");
  });

  it("returns only the requested fields, with nested media kept whole", async () => {
    const m = await startMock();
    const { mediaId, commentId } = await m.emit({ kind: "comment", username: "ana", text: "oi" });
    const res = await fetch(`${m.url}/v21.0/${IG_USER}?fields=${encodeURIComponent(`mentioned_comment.comment_id(${commentId}){text,media{permalink}}`)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await res.json()).toEqual({ mentioned_comment: { text: "oi", media: { permalink: m.state.media.get(mediaId)!.permalink } }, id: IG_USER });
  });
});

describe("the emitted webhook", () => {
  it("is signed with the app secret and reads back to the event the mock created", async () => {
    const m = await startMock();
    const c = await m.emit({ kind: "comment", username: "ana", text: "oi" });
    const t = await m.emit({ kind: "media", username: "bruno", text: "olha" });
    expect(received).toHaveLength(2);
    const [rc, rm] = received as [Received, Received];
    expect(verifySignature(Buffer.from(rc.body), rc.signature, SECRET)).toBe(true);
    expect(verifySignature(Buffer.from(rc.body), rc.signature, "another-secret")).toBe(false);
    expect(parseWebhook(JSON.parse(rc.body))).toEqual([{ igUserId: IG_USER, mediaId: c.mediaId, commentId: c.commentId }]);
    expect(parseWebhook(JSON.parse(rm.body))).toEqual([{ igUserId: IG_USER, mediaId: t.mediaId, commentId: null }]);
  });

  it("fails verification when the body is altered after signing", async () => {
    const m = await startMock();
    await m.emit({ kind: "comment", username: "ana", text: "oi" });
    const { body, signature } = received[0]!;
    expect(verifySignature(Buffer.from(body.replace("mentions", "mentionz")), signature, SECRET)).toBe(false);
    expect(verifySignature(Buffer.from(body), "sha256=" + "0".repeat(64), SECRET)).toBe(false);
  });

  it("is what POST /__mock/mentions delivers, and it answers what the app answered", async () => {
    const m = await startMock();
    const res = await fetch(`${m.url}/__mock/mentions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "comment", username: "ana", text: "oi" }),
    });
    const out = await res.json();
    expect(out).toMatchObject({ delivered: 200, commentId: expect.stringMatching(/^\d{17}$/) });
    expect(received).toHaveLength(1);
    expect(parseWebhook(JSON.parse(received[0]!.body))[0]).toMatchObject({ mediaId: out.mediaId, commentId: out.commentId });
    expect((await fetch(`${m.url}/__mock/replies`)).status).toBe(200);
  });

  it("answers 502 from the dev route when the app is unreachable", async () => {
    const m = await startMock({ webhookUrl: "http://127.0.0.1:1/webhook" });
    const res = await fetch(`${m.url}/__mock/mentions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "media", username: "bruno", text: "olha" }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toHaveProperty("error");
  });

  it("serves a labelled post page for a media's permalink, with the caption escaped", async () => {
    const m = await startMock();
    const { mediaId } = await m.emit({ kind: "media", username: "bruno", text: "olha <script>x</script>" });
    const res = await fetch(`${m.url}/__mock/p/${mediaId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<title>Mock Instagram post (local stand-in, not Instagram)</title>");
    expect(html).toContain("<h1>Mock Instagram post (local stand-in, not Instagram)</h1>");
    expect(html).toContain("olha &lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect((await fetch(`${m.url}/__mock/p/999`)).status).toBe(404);
  });

  it("serves a small SVG for a media's default image URL", async () => {
    const m = await startMock();
    const { mediaId } = await m.emit({ kind: "media", username: "bruno", text: "olha" });
    const res = await fetch(`${m.url}/__mock/img/${mediaId}.svg`);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    expect(await res.text()).toContain(mediaId);
    expect((await fetch(`${m.url}/__mock/img/999.svg`)).status).toBe(404);
  });
});

describe("end to end with the real app", () => {
  it("stores a mention once, even when the same signed webhook arrives twice, and sends the reply through", async () => {
    const m = await startMock();
    const config = { verifyToken: "v", appSecret: SECRET, adminUser: "admin", adminPassword: "pw" };
    const store = new MemoryStore();
    const created = createApp({ store, graph: new GraphApiClient(TOKEN, { baseUrl: m.url }), config });
    const { url: appUrl } = await listen(created.app);
    // The mock reads webhookUrl on each emit, so it can be pointed at the app now that the app has a port.
    m.opts.webhookUrl = `${appUrl}/webhook`;

    const { mediaId, commentId, body, signature } = await m.emit({ kind: "comment", username: "ana", text: "Amei o produto, @loja!" });
    await created.idle();
    const resent = await fetch(`${appUrl}/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body });
    expect(resent.status).toBe(200);
    await created.idle();

    const stored = await store.listMentions();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ key: `comment:${commentId}`, kind: "comment", mediaId, text: "Amei o produto, @loja!", fetchError: null });

    const auth = "Basic " + Buffer.from("admin:pw").toString("base64");
    const reply = await fetch(`${appUrl}/admin/m/${stored[0]!.id}/reply`, {
      method: "POST",
      redirect: "manual",
      headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ body: "Obrigada!" }).toString(),
    });
    expect(reply.status).toBe(303);
    expect(m.state.replies).toMatchObject([{ message: "Obrigada!", mediaId, commentId }]);
    expect((await store.getMention(stored[0]!.id))!.replies).toMatchObject([{ body: "Obrigada!", graphId: m.state.replies[0]!.id, sendError: null }]);
  });
});
