import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphApiClient, graphErrorMessage, mentionKey, parseWebhook, verifySignature } from "./instagram.js";

const secret = "app-secret";
const sign = (body: string, key = secret) => "sha256=" + createHmac("sha256", key).update(body).digest("hex");

describe("verifySignature", () => {
  const body = '{"object":"instagram"}';

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
  const hook = (...changes: unknown[]) => ({ object: "instagram", entry: [{ id: "17841", time: 1520622968, changes }] });

  it("reads a comment mention with its comment id", () => {
    const payload = hook({ field: "mentions", value: { comment_id: "c1", media_id: "m1" } });
    expect(parseWebhook(payload)).toEqual([{ igUserId: "17841", mediaId: "m1", commentId: "c1" }]);
  });

  it("reads a caption mention, which has no comment id", () => {
    expect(parseWebhook(hook({ field: "mentions", value: { media_id: "m2" } }))).toEqual([
      { igUserId: "17841", mediaId: "m2", commentId: null },
    ]);
  });

  it("ignores other fields and changes without a media id", () => {
    expect(parseWebhook(hook({ field: "comments", value: { id: "c9", text: "oi", media: { id: "m9" } } }))).toEqual([]);
    expect(parseWebhook(hook({ field: "mentions", value: { comment_id: "c1" } }))).toEqual([]);
    expect(parseWebhook(hook({ field: "mentions", value: { media_id: 5 } }))).toEqual([]);
    expect(parseWebhook(hook({ field: "mentions" }))).toEqual([]);
  });

  it("tolerates junk", () => {
    expect(parseWebhook({})).toEqual([]);
    expect(parseWebhook(null)).toEqual([]);
    expect(parseWebhook({ entry: "nope" })).toEqual([]);
    expect(parseWebhook({ entry: [null, { id: "1" }, { changes: [] }] })).toEqual([]);
  });
});

describe("mentionKey", () => {
  it("keys a comment mention by its comment and a caption mention by its media", () => {
    expect(mentionKey({ igUserId: "u", mediaId: "m1", commentId: "c1" })).toBe("comment:c1");
    expect(mentionKey({ igUserId: "u", mediaId: "m1", commentId: null })).toBe("media:m1");
  });
});

describe("graphErrorMessage", () => {
  it("keeps Graph's own message from its error JSON", () => {
    const body = '{"error":{"message":"Invalid OAuth access token","type":"OAuthException","code":190}}';
    expect(graphErrorMessage(401, body)).toBe("Instagram 401: Invalid OAuth access token");
  });

  it("falls back to the raw body when it is not Graph's JSON", () => {
    expect(graphErrorMessage(502, "Bad Gateway")).toBe("Instagram 502: Bad Gateway");
  });
});

describe("GraphApiClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  type Call = { url: string; init: RequestInit };
  // Replaces global fetch with a stub that records each call and answers with
  // the given status and JSON body.
  function stubFetch(status: number, json: unknown) {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (url: any, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(json), { status });
    });
    return calls;
  }
  const header = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name];

  const comment = { igUserId: "17841", mediaId: "m1", commentId: "c1" };
  const caption = { igUserId: "17841", mediaId: "m2", commentId: null };

  it("fetches a comment mention with the token in the header, not the URL", async () => {
    const calls = stubFetch(200, {
      mentioned_comment: {
        id: "c1",
        text: "oi @loja",
        timestamp: "2026-10-30T20:00:00+0000",
        like_count: 3,
        media: { id: "m1", permalink: "https://www.instagram.com/p/abc/" },
      },
      id: "17841",
    });
    const detail = await new GraphApiClient("secret-token").fetchMention(comment);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("https://graph.facebook.com/v21.0/17841?fields=");
    expect(decodeURIComponent(calls[0]!.url)).toContain("mentioned_comment.comment_id(c1){");
    expect(calls[0]!.url).toContain("mentioned_comment.comment_id(");
    expect(calls[0]!.url).not.toContain("secret-token");
    expect(header(calls[0]!, "Authorization")).toBe("Bearer secret-token");
    expect(detail).toEqual({
      kind: "comment",
      text: "oi @loja",
      username: null,
      permalink: "https://www.instagram.com/p/abc/",
      mediaUrl: null,
      postedAt: new Date("2026-10-30T20:00:00Z"),
    });
  });

  it("fetches a caption mention and reads an absent media_url as null", async () => {
    const calls = stubFetch(200, {
      mentioned_media: { id: "m2", caption: "olha @loja", media_type: "VIDEO", permalink: "https://www.instagram.com/reel/x/", username: "ana", timestamp: "2026-10-30T20:00:00+0000" },
      id: "17841",
    });
    const detail = await new GraphApiClient("t").fetchMention(caption);
    expect(decodeURIComponent(calls[0]!.url)).toContain("mentioned_media.media_id(m2){");
    expect(detail).toMatchObject({ kind: "media", text: "olha @loja", username: "ana", mediaUrl: null });
  });

  it("reads a caption mention's media_url when there is one", async () => {
    stubFetch(200, { mentioned_media: { id: "m2", media_url: "https://cdn.example/a.jpg" }, id: "17841" });
    const detail = await new GraphApiClient("t").fetchMention(caption);
    expect(detail.mediaUrl).toBe("https://cdn.example/a.jpg");
    expect(detail.text).toBe("");
  });

  it("encodes the ids in the path", async () => {
    const calls = stubFetch(200, { mentioned_media: { id: "m2" } });
    await new GraphApiClient("t").fetchMention({ ...caption, igUserId: "a/b" });
    expect(calls[0]!.url).toContain("/v21.0/a%2Fb?fields=");
  });

  it("posts a reply to a comment mention with comment_id and media_id", async () => {
    const calls = stubFetch(200, { id: "new-1" });
    expect(await new GraphApiClient("secret-token").reply(comment, "Obrigada!")).toBe("new-1");
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v21.0/17841/mentions");
    expect(calls[0]!.init.method).toBe("POST");
    expect(header(calls[0]!, "Authorization")).toBe("Bearer secret-token");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ message: "Obrigada!", media_id: "m1", comment_id: "c1" });
  });

  it("posts a reply to a caption mention without comment_id", async () => {
    const calls = stubFetch(200, { id: "new-2" });
    await new GraphApiClient("t").reply(caption, "Obrigada!");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ message: "Obrigada!", media_id: "m2" });
  });

  it("cuts a reply at Instagram's 2200-character limit", async () => {
    const calls = stubFetch(200, { id: "new-3" });
    await new GraphApiClient("t").reply(caption, "a".repeat(3000));
    expect(JSON.parse(String(calls[0]!.init.body)).message).toHaveLength(2200);
  });

  it("throws Graph's own message on a refusal", async () => {
    stubFetch(400, { error: { message: "x", code: 100 } });
    const client = new GraphApiClient("t");
    await expect(client.reply(comment, "oi")).rejects.toThrow("Instagram 400: x");
    await expect(client.fetchMention(comment)).rejects.toThrow("Instagram 400: x");
  });

  it("uses a custom base and version, ignoring one trailing slash", async () => {
    const calls = stubFetch(200, { id: "n" });
    await new GraphApiClient("t", { baseUrl: "http://localhost:3100/", version: "v22.0" }).reply(caption, "oi");
    expect(calls[0]!.url).toBe("http://localhost:3100/v22.0/17841/mentions");
  });
});
