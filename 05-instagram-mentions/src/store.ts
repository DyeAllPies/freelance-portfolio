import pg from "pg";
import { mentionKey, type MentionDetail, type MentionEvent } from "./instagram.js";

// sendError is Instagram's refusal when a reply was never posted.
export type StoredReply = { body: string; graphId: string | null; sendError: string | null; createdAt: Date };

export type StoredMention = {
  id: number;
  key: string;
  kind: "comment" | "media";
  igUserId: string;
  mediaId: string;
  commentId: string | null;
  username: string | null;
  text: string;
  permalink: string | null;
  mediaUrl: string | null;
  postedAt: Date | null;
  receivedAt: Date;
  // Set when the mention could not be read back from Graph.
  fetchError: string | null;
  replies: StoredReply[];
};

export interface Store {
  hasMention(key: string): Promise<boolean>;
  // False when this mention key was already stored. d is null, and fetchError
  // set, when Graph could not be read.
  recordMention(e: MentionEvent, d: MentionDetail | null, fetchError: string | null): Promise<boolean>;
  getMention(id: number): Promise<StoredMention | null>;
  // Newest first, at most 200.
  listMentions(): Promise<StoredMention[]>;
  // graphId is set, and sendError null, when Instagram accepted the reply.
  recordReply(id: number, body: string, graphId: string | null, sendError: string | null): Promise<void>;
}

const kindOf = (e: MentionEvent, d: MentionDetail | null): "comment" | "media" => d?.kind ?? (e.commentId ? "comment" : "media");

// Keeps everything in memory: the tests, and a quick local demo without Postgres.
export class MemoryStore implements Store {
  private mentions: StoredMention[] = [];

  async hasMention(key: string) {
    return this.mentions.some((m) => m.key === key);
  }

  async recordMention(e: MentionEvent, d: MentionDetail | null, fetchError: string | null) {
    const key = mentionKey(e);
    if (this.mentions.some((m) => m.key === key)) return false;
    this.mentions.push({
      id: this.mentions.length + 1,
      key,
      kind: kindOf(e, d),
      igUserId: e.igUserId,
      mediaId: e.mediaId,
      commentId: e.commentId,
      username: d?.username ?? null,
      text: d?.text ?? "",
      permalink: d?.permalink ?? null,
      mediaUrl: d?.mediaUrl ?? null,
      postedAt: d?.postedAt ?? null,
      receivedAt: new Date(),
      fetchError,
      replies: [],
    });
    return true;
  }

  async getMention(id: number) {
    const m = this.mentions.find((x) => x.id === id);
    return m ? { ...m, replies: [...m.replies] } : null;
  }

  async listMentions() {
    return this.mentions
      .map((m) => ({ ...m, replies: [...m.replies] }))
      .reverse()
      .slice(0, 200);
  }

  async recordReply(id: number, body: string, graphId: string | null, sendError: string | null) {
    this.mentions.find((x) => x.id === id)?.replies.push({ body, graphId, sendError, createdAt: new Date() });
  }
}

export class PgStore implements Store {
  constructor(private pool: pg.Pool) {}

  async hasMention(key: string) {
    const { rowCount } = await this.pool.query(`select 1 from mentions where mention_key = $1`, [key]);
    return rowCount === 1;
  }

  async recordMention(e: MentionEvent, d: MentionDetail | null, fetchError: string | null) {
    const inserted = await this.pool.query(
      `insert into mentions
         (mention_key, kind, ig_user_id, media_id, comment_id, username, text, permalink, media_url, posted_at, fetch_error)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (mention_key) do nothing`,
      [
        mentionKey(e),
        kindOf(e, d),
        e.igUserId,
        e.mediaId,
        e.commentId,
        d?.username ?? null,
        d?.text ?? "",
        d?.permalink ?? null,
        d?.mediaUrl ?? null,
        d?.postedAt ?? null,
        fetchError,
      ],
    );
    return inserted.rowCount === 1;
  }

  private static row(r: any, replies: any[]): StoredMention {
    return {
      id: Number(r.id),
      key: r.mention_key,
      kind: r.kind,
      igUserId: r.ig_user_id,
      mediaId: r.media_id,
      commentId: r.comment_id,
      username: r.username,
      text: r.text,
      permalink: r.permalink,
      mediaUrl: r.media_url,
      postedAt: r.posted_at,
      receivedAt: r.received_at,
      fetchError: r.fetch_error,
      replies: replies.map((x) => ({ body: x.body, graphId: x.graph_id, sendError: x.send_error, createdAt: x.created_at })),
    };
  }

  private async withReplies(rows: any[]): Promise<StoredMention[]> {
    if (!rows.length) return [];
    const { rows: replies } = await this.pool.query(
      `select * from replies where mention_id = any($1::bigint[]) order by id`,
      [rows.map((r) => r.id)],
    );
    return rows.map((r) =>
      PgStore.row(
        r,
        replies.filter((x) => String(x.mention_id) === String(r.id)),
      ),
    );
  }

  async getMention(id: number) {
    const { rows } = await this.pool.query(`select * from mentions where id = $1`, [id]);
    return (await this.withReplies(rows))[0] ?? null;
  }

  async listMentions() {
    const { rows } = await this.pool.query(`select * from mentions order by id desc limit 200`);
    return this.withReplies(rows);
  }

  async recordReply(id: number, body: string, graphId: string | null, sendError: string | null) {
    await this.pool.query(`insert into replies (mention_id, body, graph_id, send_error) values ($1, $2, $3, $4)`, [
      id,
      body,
      graphId || null,
      sendError,
    ]);
  }
}
