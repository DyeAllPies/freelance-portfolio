import { createHmac, timingSafeEqual } from "node:crypto";

// One @-mention of the business account, as the webhook announces it.
// A comment mention carries commentId; a caption (media) mention does not.
export type MentionEvent = { igUserId: string; mediaId: string; commentId: string | null };

// What Graph returns about the mention. For a media mention, text is the caption.
// username is null for a comment: the documented comment fields do not include
// its author. mediaUrl can be absent (some videos and reels).
export type MentionDetail = {
  kind: "comment" | "media";
  text: string;
  username: string | null;
  permalink: string | null;
  mediaUrl: string | null;
  postedAt: Date | null;
};

export interface Graph {
  fetchMention(e: MentionEvent): Promise<MentionDetail>;
  // Returns the id of the comment Instagram created.
  reply(e: MentionEvent, message: string): Promise<string>;
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

// Pulls the mentions out of a webhook payload. Only the "mentions" field is
// read; any other field on the same webhook (such as "comments") is skipped,
// and so is a change without a media_id.
export function parseWebhook(payload: any): MentionEvent[] {
  const out: MentionEvent[] = [];
  if (!Array.isArray(payload?.entry)) return out;
  for (const entry of payload.entry) {
    const igUserId = entry?.id;
    if ((typeof igUserId !== "string" && typeof igUserId !== "number") || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (change?.field !== "mentions") continue;
      const value = change.value;
      if (typeof value?.media_id !== "string" || !value.media_id) continue;
      out.push({
        igUserId: String(igUserId),
        mediaId: value.media_id,
        commentId: typeof value.comment_id === "string" && value.comment_id ? value.comment_id : null,
      });
    }
  }
  return out;
}

// The key a mention is stored and de-duplicated under.
export function mentionKey(e: MentionEvent): string {
  return e.commentId ? `comment:${e.commentId}` : `media:${e.mediaId}`;
}

// Graph answers an error with {"error":{"message":...}}; the dashboard shows
// that message rather than the raw JSON.
export function graphErrorMessage(status: number, body: string): string {
  let message = body;
  try {
    message = JSON.parse(body)?.error?.message || body;
  } catch {}
  return `Instagram ${status}: ${message}`;
}

// Instagram's comment limit.
export const MAX_REPLY_LENGTH = 2200;

// Graph writes offsets as +0000; Date wants +00:00.
function parseTime(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const d = new Date(value.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
  return Number.isNaN(d.getTime()) ? null : d;
}

const orNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export class GraphApiClient implements Graph {
  private base: string;
  private version: string;

  constructor(
    private token: string,
    opts: { baseUrl?: string; version?: string } = {},
  ) {
    this.base = (opts.baseUrl || "https://graph.facebook.com").replace(/\/$/, "");
    this.version = opts.version || "v21.0";
  }

  // The token travels in the Authorization header, so URLs are safe to log.
  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  async fetchMention(e: MentionEvent): Promise<MentionDetail> {
    const fields = e.commentId
      ? `mentioned_comment.comment_id(${e.commentId}){id,text,timestamp,like_count,media{id,permalink}}`
      : `mentioned_media.media_id(${e.mediaId}){id,caption,media_type,media_url,permalink,timestamp,username}`;
    const url = `${this.base}/${this.version}/${encodeURIComponent(e.igUserId)}?fields=${encodeURIComponent(fields)}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(graphErrorMessage(res.status, await res.text()));
    const json: any = await res.json();
    if (e.commentId) {
      const c = json?.mentioned_comment;
      if (!c) throw new Error("Instagram returned no mentioned_comment");
      return {
        kind: "comment",
        text: String(c.text ?? ""),
        username: null,
        permalink: orNull(c.media?.permalink),
        mediaUrl: null,
        postedAt: parseTime(c.timestamp),
      };
    }
    const m = json?.mentioned_media;
    if (!m) throw new Error("Instagram returned no mentioned_media");
    return {
      kind: "media",
      text: String(m.caption ?? ""),
      username: orNull(m.username),
      permalink: orNull(m.permalink),
      mediaUrl: orNull(m.media_url),
      postedAt: parseTime(m.timestamp),
    };
  }

  async reply(e: MentionEvent, message: string): Promise<string> {
    const res = await fetch(`${this.base}/${this.version}/${encodeURIComponent(e.igUserId)}/mentions`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        message: message.slice(0, MAX_REPLY_LENGTH),
        media_id: e.mediaId,
        ...(e.commentId ? { comment_id: e.commentId } : {}),
      }),
    });
    if (!res.ok) throw new Error(graphErrorMessage(res.status, await res.text()));
    const json: any = await res.json();
    return String(json?.id ?? "");
  }
}
