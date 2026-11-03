import { createHmac } from "node:crypto";
import express, { type Response } from "express";

// A local stand-in for the few Instagram Graph endpoints this app uses, and for
// the signed "mentions" webhook Meta sends. Nothing here reaches Meta: it exists
// so the whole flow can run with no Meta app, no token and no public URL.

export type MockOptions = {
  accessToken: string;
  igUserId: string;
  appSecret: string;
  // Where the signed webhook is POSTed (this app's /webhook).
  webhookUrl: string;
  // How a browser reaches this mock; used for the default media image URL.
  publicUrl: string;
};

export type MockMedia = {
  id: string;
  caption: string;
  media_type: string;
  // Absent for a media Graph gives no media_url for (some videos and reels).
  media_url: string | null;
  permalink: string;
  timestamp: string;
  username: string;
};
export type MockComment = { id: string; text: string; timestamp: string; like_count: number; mediaId: string };
export type MockReply = { id: string; message: string; mediaId: string; commentId: string | null };

export type EmitInput = { kind: "comment" | "media"; username: string; text: string; mediaUrl?: string | null };
export type EmitResult = {
  delivered: number;
  mediaId: string;
  commentId: string | null;
  // The exact signed request, so a test can send it again.
  body: string;
  signature: string;
};

const COMMENT_FIELDS = ["id", "text", "timestamp", "like_count", "media"];
const COMMENT_MEDIA_FIELDS = ["id", "permalink"];
const MEDIA_FIELDS = ["id", "caption", "media_type", "media_url", "permalink", "timestamp", "username"];

// Splits on the commas outside any braces, so media{id,permalink} stays whole.
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

class FieldError extends Error {}
const nonexisting = (name: string) => new FieldError(`(#100) Tried accessing nonexisting field (${name})`);

// "media{id,permalink}" -> ["media", ["id", "permalink"]]; "id" -> ["id", null].
function splitField(f: string): [string, string[] | null] {
  const m = /^([A-Za-z_]+)(?:\{(.*)\})?$/s.exec(f);
  if (!m) throw nonexisting(f);
  return [m[1]!, m[2] === undefined ? null : splitTop(m[2])];
}

export function createGraphMock(opts: MockOptions) {
  const state = {
    media: new Map<string, MockMedia>(),
    comments: new Map<string, MockComment>(),
    replies: [] as MockReply[],
  };

  // Numeric 17-digit ids like Instagram's, from a counter so runs are repeatable.
  let counter = 0;
  const newId = () => String(17890000000000000n + BigInt(++counter));
  const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+0000");

  function graphError(res: Response, status: number, code: number, message: string, type = "OAuthException") {
    res.status(status).json({ error: { message, type, code } });
  }

  function createMedia(input: EmitInput): MockMedia {
    const id = newId();
    const media: MockMedia = {
      id,
      caption: input.kind === "media" ? input.text : "",
      media_type: "IMAGE",
      media_url: input.mediaUrl === undefined ? `${opts.publicUrl.replace(/\/$/, "")}/__mock/img/${id}.svg` : input.mediaUrl,
      permalink: `${opts.publicUrl.replace(/\/$/, "")}/__mock/p/${id}`,
      timestamp: stamp(),
      username: input.username,
    };
    state.media.set(id, media);
    return media;
  }

  // Creates the media (and the comment) and delivers the signed webhook for it.
  // Throws when the app cannot be reached.
  async function emit(input: EmitInput): Promise<EmitResult> {
    const media = createMedia(input);
    let comment: MockComment | null = null;
    if (input.kind === "comment") {
      comment = { id: newId(), text: input.text, timestamp: stamp(), like_count: 0, mediaId: media.id };
      state.comments.set(comment.id, comment);
    }
    const value: Record<string, string> = { media_id: media.id };
    if (comment) value.comment_id = comment.id;
    const body = JSON.stringify({
      object: "instagram",
      entry: [{ id: opts.igUserId, time: Math.floor(Date.now() / 1000), changes: [{ field: "mentions", value }] }],
    });
    const signature = "sha256=" + createHmac("sha256", opts.appSecret).update(body).digest("hex");
    const res = await fetch(opts.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body,
    });
    return { delivered: res.status, mediaId: media.id, commentId: comment?.id ?? null, body, signature };
  }

  const app = express();

  // Dev surface, not Graph. Registered first: GET /__mock/replies would
  // otherwise match GET /:version/:igUserId.
  app.post("/__mock/mentions", express.json(), async (req, res) => {
    const b = req.body ?? {};
    if ((b.kind !== "comment" && b.kind !== "media") || typeof b.username !== "string" || typeof b.text !== "string") {
      res.status(400).json({ error: "expected {kind: 'comment' | 'media', username, text, mediaUrl?}" });
      return;
    }
    try {
      const { delivered, mediaId, commentId } = await emit({
        kind: b.kind,
        username: b.username,
        text: b.text,
        mediaUrl: typeof b.mediaUrl === "string" || b.mediaUrl === null ? b.mediaUrl : undefined,
      });
      res.json({ delivered, mediaId, commentId });
    } catch (err) {
      res.status(502).json({ error: `could not reach ${opts.webhookUrl}: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.get("/__mock/replies", (_req, res) => {
    res.json(state.replies);
  });

  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const POST_TITLE = "Mock Instagram post (local stand-in, not Instagram)";
  app.get("/__mock/p/:id", (req, res) => {
    const media = state.media.get(String(req.params.id));
    if (!media) {
      res.sendStatus(404);
      return;
    }
    res.type("html").send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${POST_TITLE}</title></head><body>` +
        `<h1>${POST_TITLE}</h1><p>@${esc(media.username)}</p><p>${esc(media.caption)}</p></body></html>`,
    );
  });

  app.get("/__mock/img/:file", (req, res) => {
    const id = String(req.params.file).replace(/\.svg$/, "");
    if (!/^\d+$/.test(id) || !state.media.has(id)) {
      res.sendStatus(404);
      return;
    }
    const hue = Number(id.slice(-3)) % 360;
    res
      .type("image/svg+xml")
      .send(
        `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">` +
          `<rect width="320" height="320" fill="hsl(${hue},55%,50%)"/>` +
          `<text x="160" y="166" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#fff">${id}</text></svg>`,
      );
  });

  // The Graph routes.
  const graph = express.Router();
  graph.use(express.json(), express.urlencoded({ extended: false }));

  graph.use((req, res, next) => {
    const header = req.header("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    const token = bearer ?? (typeof req.query.access_token === "string" ? req.query.access_token : req.body?.access_token);
    if (token !== opts.accessToken) {
      graphError(res, 401, 190, "Invalid OAuth access token.");
      return;
    }
    next();
  });

  const unknownUser = (res: Response, id: string) =>
    graphError(
      res,
      400,
      100,
      `Unsupported get request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
      "GraphMethodException",
    );

  graph.get("/:version/:igUserId", (req, res) => {
    const igUserId = String(req.params.igUserId);
    if (igUserId !== opts.igUserId) {
      unknownUser(res, igUserId);
      return;
    }
    const fields = typeof req.query.fields === "string" ? req.query.fields : "";
    if (!fields) {
      res.json({ id: igUserId });
      return;
    }
    const shape = /^(mentioned_comment)\.comment_id\(([^)]*)\)\{(.*)\}$|^(mentioned_media)\.media_id\(([^)]*)\)\{(.*)\}$/s.exec(fields);
    if (!shape) {
      graphError(res, 400, 100, `(#100) Tried accessing nonexisting field (${fields})`, "GraphMethodException");
      return;
    }
    const isComment = shape[1] !== undefined;
    const targetId = (isComment ? shape[2] : shape[5])!;
    const wanted = splitTop((isComment ? shape[3] : shape[6])!);
    try {
      let result: Record<string, unknown>;
      if (isComment) {
        const comment = state.comments.get(targetId);
        result = {};
        for (const f of wanted) {
          const [name, subs] = splitField(f);
          if (!COMMENT_FIELDS.includes(name) || (subs && name !== "media")) throw nonexisting(name);
          if (name === "media") {
            const media = comment && state.media.get(comment.mediaId);
            const pick: Record<string, unknown> = {};
            for (const sub of subs ?? ["id"]) {
              if (!COMMENT_MEDIA_FIELDS.includes(sub)) throw nonexisting(sub);
              if (media) pick[sub] = sub === "id" ? media.id : media.permalink;
            }
            result.media = pick;
          } else if (comment) {
            result[name] = name === "id" ? comment.id : name === "text" ? comment.text : name === "timestamp" ? comment.timestamp : comment.like_count;
          }
        }
        if (!comment) {
          graphError(res, 400, 24, `(#24) The requested resource does not exist (comment ${targetId})`, "GraphMethodException");
          return;
        }
        res.json({ mentioned_comment: result, id: igUserId });
      } else {
        const media = state.media.get(targetId);
        result = {};
        for (const f of wanted) {
          const [name, subs] = splitField(f);
          if (!MEDIA_FIELDS.includes(name) || subs) throw nonexisting(name);
          const value = media?.[name as keyof MockMedia];
          // A media without a media_url is returned without that key.
          if (media && value !== null) result[name] = value;
        }
        if (!media) {
          graphError(res, 400, 24, `(#24) The requested resource does not exist (media ${targetId})`, "GraphMethodException");
          return;
        }
        res.json({ mentioned_media: result, id: igUserId });
      }
    } catch (err) {
      if (!(err instanceof FieldError)) throw err;
      graphError(res, 400, 100, err.message, "GraphMethodException");
    }
  });

  graph.post("/:version/:igUserId/mentions", (req, res) => {
    const igUserId = String(req.params.igUserId);
    if (igUserId !== opts.igUserId) {
      unknownUser(res, igUserId);
      return;
    }
    const { message, media_id: mediaId, comment_id: commentId } = req.body ?? {};
    if (typeof message !== "string" || !message) {
      graphError(res, 400, 100, "(#100) The parameter message is required.", "GraphMethodException");
      return;
    }
    if (typeof mediaId !== "string" || !mediaId) {
      graphError(res, 400, 100, "(#100) The parameter media_id is required.", "GraphMethodException");
      return;
    }
    if (!state.media.has(mediaId)) {
      graphError(res, 400, 100, `(#100) Invalid parameter: media_id ${mediaId} does not exist.`, "GraphMethodException");
      return;
    }
    let reply: MockReply["commentId"] = null;
    if (commentId !== undefined && commentId !== null && commentId !== "") {
      const comment = typeof commentId === "string" ? state.comments.get(commentId) : undefined;
      if (!comment) {
        graphError(res, 400, 100, `(#100) Invalid parameter: comment_id ${String(commentId)} does not exist.`, "GraphMethodException");
        return;
      }
      if (comment.mediaId !== mediaId) {
        graphError(res, 400, 100, `(#100) Invalid parameter: comment_id ${comment.id} is not a comment on media ${mediaId}.`, "GraphMethodException");
        return;
      }
      reply = comment.id;
    }
    const id = newId();
    state.replies.push({ id, message, mediaId, commentId: reply });
    res.json({ id });
  });

  app.use(graph);

  return { app, state, emit };
}
