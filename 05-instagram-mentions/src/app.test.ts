import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Graph, MentionDetail, MentionEvent } from "./instagram.js";
import { MemoryStore } from "./store.js";

// The real Express app on a random port, with Instagram's Graph API replaced
// by a fake that records what it was asked to do.
const config = { verifyToken: "verify-me", appSecret: "app-secret", adminUser: "admin", adminPassword: "pw" };
const auth = "Basic " + Buffer.from("admin:pw").toString("base64");
const igUser = "17841400000000000";

let server: Server;
let base: string;
let store: MemoryStore;
let fetched: MentionEvent[];
let replies: { event: MentionEvent; message: string }[];
// What the fake Graph returns for a mention, or an Error to refuse it.
let detail: MentionDetail | Error;
// Set to make every reply fail the way Graph refuses a bad token.
let replyFails: boolean;
let idle: () => Promise<void>;

const commentDetail = (over: Partial<MentionDetail> = {}): MentionDetail => ({
  kind: "comment",
  text: "Amei o produto, @loja!",
  username: null,
  permalink: "https://www.instagram.com/p/abc/",
  mediaUrl: null,
  postedAt: new Date("2026-10-30T20:00:00Z"),
  ...over,
});

beforeEach(async () => {
  store = new MemoryStore();
  fetched = [];
  replies = [];
  detail = commentDetail();
  replyFails = false;
  const graph: Graph = {
    fetchMention: async (e) => {
      fetched.push(e);
      if (detail instanceof Error) throw detail;
      return detail;
    },
    reply: async (event, message) => {
      if (replyFails) throw new Error("Instagram 400: Invalid parameter");
      replies.push({ event, message });
      return `reply.${replies.length}`;
    },
  };
  const created = createApp({ store, graph, config });
  idle = created.idle;
  server = created.app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

let seq = 0;
function mention(opts: { commentId?: string | null; mediaId?: string } = {}) {
  const value: Record<string, string> = { media_id: opts.mediaId ?? `media.${++seq}` };
  const commentId = opts.commentId === undefined ? `comment.${++seq}` : opts.commentId;
  if (commentId) value.comment_id = commentId;
  return JSON.stringify({
    object: "instagram",
    entry: [{ id: igUser, time: 1520622968, changes: [{ field: "mentions", value }] }],
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

describe("mentions", () => {
  it("refuses an unsigned or forged webhook without storing anything", async () => {
    expect(await deliver(mention(), "sha256=" + "0".repeat(64))).toBe(401);
    expect(fetched).toEqual([]);
    expect(await store.listMentions()).toEqual([]);
  });

  it("refuses a signed body that is not JSON", async () => {
    expect(await deliver("not json")).toBe(400);
    expect(fetched).toEqual([]);
  });

  it("fetches and stores a signed comment mention", async () => {
    expect(await deliver(mention({ commentId: "c1", mediaId: "m1" }))).toBe(200);
    expect(fetched).toEqual([{ igUserId: igUser, mediaId: "m1", commentId: "c1" }]);
    const [m] = await store.listMentions();
    expect(m).toMatchObject({
      key: "comment:c1",
      kind: "comment",
      igUserId: igUser,
      mediaId: "m1",
      commentId: "c1",
      text: "Amei o produto, @loja!",
      fetchError: null,
    });
  });

  it("stores a caption mention", async () => {
    detail = commentDetail({ kind: "media", text: "olha @loja", username: "ana", mediaUrl: "https://cdn.example/a.jpg" });
    await deliver(mention({ commentId: null, mediaId: "m7" }));
    expect(await store.listMentions()).toMatchObject([{ key: "media:m7", kind: "media", username: "ana", commentId: null }]);
  });

  it("stores and fetches a mention Meta delivers twice only once", async () => {
    const body = mention({ commentId: "c-same", mediaId: "m-same" });
    await deliver(body);
    await deliver(body);
    expect(fetched).toHaveLength(1);
    expect(await store.listMentions()).toHaveLength(1);
  });

  it("ignores a webhook field other than mentions", async () => {
    const body = JSON.stringify({
      object: "instagram",
      entry: [{ id: igUser, time: 1, changes: [{ field: "comments", value: { id: "c1", text: "oi", media: { id: "m1" } } }] }],
    });
    expect(await deliver(body)).toBe(200);
    expect(fetched).toEqual([]);
  });

  it("keeps a mention Graph could not be read for, and shows why on the dashboard", async () => {
    detail = new Error("Instagram 400: Unsupported get request");
    await deliver(mention({ commentId: "c-fail" }));
    const [m] = await store.listMentions();
    expect(m).toMatchObject({ key: "comment:c-fail", text: "", fetchError: "Instagram 400: Unsupported get request" });
    expect(await (await admin("")).text()).toContain("Não lida: </span>");
    expect(await (await admin(`/m/${m!.id}`)).text()).toContain("Instagram 400: Unsupported get request");
  });
});

describe("dashboard", () => {
  async function stored(over: Partial<MentionDetail> = {}, opts: Parameters<typeof mention>[0] = {}) {
    detail = commentDetail(over);
    await deliver(mention(opts));
    return (await store.listMentions())[0]!;
  }

  it("requires the admin login", async () => {
    expect((await fetch(`${base}/admin`)).status).toBe(401);
    const wrong = "Basic " + Buffer.from("admin:nope").toString("base64");
    expect((await fetch(`${base}/admin`, { headers: { authorization: wrong } })).status).toBe(401);
  });

  it("lists a mention with its kind and text", async () => {
    await stored();
    const html = await (await admin("")).text();
    expect(html).toContain("comentário");
    expect(html).toContain("Amei o produto, @loja!");
    expect(html).toContain("autor não informado pela API");
  });

  it("escapes what people write", async () => {
    const m = await stored({ kind: "media", username: "<b>x</b>", text: "<script>alert(1)</script>" });
    for (const html of [await (await admin("")).text(), await (await admin(`/m/${m.id}`)).text()]) {
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
      expect(html).not.toContain("<script>alert(1)");
      expect(html).not.toContain("<b>x</b>");
    }
  });

  it("answers 404 for an unknown or non-numeric id", async () => {
    expect((await admin("/m/999")).status).toBe(404);
    expect((await admin("/m/abc")).status).toBe(404);
    expect((await admin("/m/999/reply", form({ body: "oi" }))).status).toBe(404);
  });

  it("sends a reply to the mentioned comment and records it", async () => {
    const m = await stored({}, { commentId: "c-r", mediaId: "m-r" });
    const res = await admin(`/m/${m.id}/reply`, form({ body: "  Obrigada!  " }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/admin/m/${m.id}`);
    expect(replies).toEqual([{ event: { igUserId: igUser, mediaId: "m-r", commentId: "c-r" }, message: "Obrigada!" }]);
    expect((await store.getMention(m.id))!.replies).toMatchObject([{ body: "Obrigada!", graphId: "reply.1", sendError: null }]);
    expect(await (await admin(`/m/${m.id}`)).text()).toContain("Obrigada!");
  });

  it("replies to a caption mention without a comment id", async () => {
    const m = await stored({ kind: "media" }, { commentId: null, mediaId: "m-cap" });
    await admin(`/m/${m.id}/reply`, form({ body: "Valeu!" }));
    expect(replies[0]!.event).toEqual({ igUserId: igUser, mediaId: "m-cap", commentId: null });
  });

  it("keeps a reply Instagram refused, marked as not delivered", async () => {
    const m = await stored();
    replyFails = true;
    const res = await admin(`/m/${m.id}/reply`, form({ body: "Obrigada!" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("error=");
    expect((await store.getMention(m.id))!.replies).toMatchObject([
      { body: "Obrigada!", graphId: null, sendError: "Instagram 400: Invalid parameter" },
    ]);
    const html = await (await admin(`/m/${m.id}`)).text();
    expect(html).toContain("Obrigada!");
    expect(html).toContain("Não entregue: Instagram 400: Invalid parameter");
  });

  it("refuses an empty reply", async () => {
    const m = await stored();
    expect((await admin(`/m/${m.id}/reply`, form({ body: "   " }))).status).toBe(400);
    expect(replies).toEqual([]);
  });

  it("refuses a form posted from another site", async () => {
    const m = await stored();
    const res = await admin(`/m/${m.id}/reply`, { ...form({ body: "oi" }), headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(replies).toEqual([]);
  });

  it("refuses a form whose Origin is null or not a URL, with the same 403", async () => {
    const m = await stored();
    for (const origin of ["null", "not a url"]) {
      const res = await admin(`/m/${m.id}/reply`, { ...form({ body: "oi" }), headers: { origin } });
      expect(res.status).toBe(403);
    }
    expect(replies).toEqual([]);
  });

  it("does not render a non-http permalink or media URL as a link or image", async () => {
    const m = await stored({ kind: "media", permalink: "javascript:alert(1)", mediaUrl: "javascript:alert(2)" });
    const html = await (await admin(`/m/${m.id}`)).text();
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("ver no Instagram");
  });

  it("renders an http permalink as a link and a media URL as an image", async () => {
    const m = await stored({ kind: "media", permalink: "https://www.instagram.com/p/abc/", mediaUrl: "https://cdn.example/a.jpg" });
    const html = await (await admin(`/m/${m.id}`)).text();
    expect(html).toContain('href="https://www.instagram.com/p/abc/"');
    expect(html).toContain('<img src="https://cdn.example/a.jpg"');
  });
});
