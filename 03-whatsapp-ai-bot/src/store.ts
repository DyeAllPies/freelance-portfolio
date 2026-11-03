import pg from "pg";
import type { Turn } from "./bot.js";

export type Mode = "bot" | "human";
export type Conversation = {
  waId: string;
  name: string;
  mode: Mode;
  handoffReason: string | null;
  lastInboundAt: Date | null;
  updatedAt: Date;
  lastMessage: string;
  // True when the last message is a reply WhatsApp refused.
  lastMessageFailed: boolean;
};
// sendError is WhatsApp's refusal when an outbound message never reached the customer.
export type StoredMessage = Turn & { createdAt: Date; sendError: string | null };

export interface Store {
  // False when this WhatsApp message id was already stored.
  recordInbound(m: { wamid: string; waId: string; name: string; body: string; at: Date }): Promise<boolean>;
  // sendError is set, and wamid null, when WhatsApp refused the message.
  recordOutbound(waId: string, author: "bot" | "agent", body: string, wamid: string | null, sendError?: string | null): Promise<void>;
  getConversation(waId: string): Promise<Conversation | null>;
  history(waId: string, limit: number): Promise<StoredMessage[]>;
  setMode(waId: string, mode: Mode, reason?: string | null): Promise<void>;
  listConversations(): Promise<Conversation[]>;
}

// Keeps everything in memory: the tests, and a quick local demo without Postgres.
export class MemoryStore implements Store {
  private conversations = new Map<string, Omit<Conversation, "lastMessage" | "lastMessageFailed">>();
  private messages: (StoredMessage & { waId: string; wamid: string | null })[] = [];

  async recordInbound(m: { wamid: string; waId: string; name: string; body: string; at: Date }) {
    if (this.messages.some((x) => x.wamid === m.wamid)) return false;
    const c = this.conversations.get(m.waId);
    this.conversations.set(m.waId, {
      waId: m.waId,
      name: m.name || c?.name || "",
      mode: c?.mode ?? "bot",
      handoffReason: c?.handoffReason ?? null,
      lastInboundAt: m.at,
      updatedAt: new Date(),
    });
    this.messages.push({ waId: m.waId, author: "customer", body: m.body, wamid: m.wamid, createdAt: new Date(), sendError: null });
    return true;
  }

  async recordOutbound(waId: string, author: "bot" | "agent", body: string, wamid: string | null, sendError: string | null = null) {
    this.messages.push({ waId, author, body, wamid, createdAt: new Date(), sendError });
    const c = this.conversations.get(waId);
    if (c) c.updatedAt = new Date();
  }

  async getConversation(waId: string) {
    const c = this.conversations.get(waId);
    const last = this.messages.filter((m) => m.waId === waId).at(-1);
    return c ? { ...c, lastMessage: last?.body ?? "", lastMessageFailed: Boolean(last?.sendError) } : null;
  }

  async history(waId: string, limit: number) {
    return this.messages
      .filter((m) => m.waId === waId)
      .slice(-limit)
      .map(({ author, body, createdAt, sendError }) => ({ author, body, createdAt, sendError }));
  }

  async setMode(waId: string, mode: Mode, reason: string | null = null) {
    const c = this.conversations.get(waId);
    if (c) Object.assign(c, { mode, handoffReason: mode === "human" ? reason : null, updatedAt: new Date() });
  }

  async listConversations() {
    const all = await Promise.all([...this.conversations.keys()].map((k) => this.getConversation(k)));
    return (all as Conversation[]).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }
}

export class PgStore implements Store {
  constructor(private pool: pg.Pool) {}

  async recordInbound(m: { wamid: string; waId: string; name: string; body: string; at: Date }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into conversations (wa_id, name, last_inbound_at) values ($1, $2, $3)
         on conflict (wa_id) do update set
           name = coalesce(nullif(excluded.name, ''), conversations.name),
           last_inbound_at = greatest(conversations.last_inbound_at, excluded.last_inbound_at),
           updated_at = now()`,
        [m.waId, m.name, m.at],
      );
      const inserted = await client.query(
        `insert into messages (wa_id, author, body, wamid) values ($1, 'customer', $2, $3)
         on conflict (wamid) do nothing`,
        [m.waId, m.body, m.wamid],
      );
      await client.query("commit");
      return inserted.rowCount === 1;
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  async recordOutbound(waId: string, author: "bot" | "agent", body: string, wamid: string | null, sendError: string | null = null) {
    await this.pool.query(`insert into messages (wa_id, author, body, wamid, send_error) values ($1, $2, $3, $4, $5)`, [
      waId,
      author,
      body,
      wamid || null,
      sendError,
    ]);
    await this.pool.query(`update conversations set updated_at = now() where wa_id = $1`, [waId]);
  }

  private static row(r: any): Conversation {
    return {
      waId: r.wa_id,
      name: r.name,
      mode: r.mode,
      handoffReason: r.handoff_reason,
      lastInboundAt: r.last_inbound_at,
      updatedAt: r.updated_at,
      lastMessage: r.last_message ?? "",
      lastMessageFailed: r.last_failed ?? false,
    };
  }

  private static readonly select = `
    select c.*, last.body as last_message, last.send_error is not null as last_failed
    from conversations c
    left join lateral (select body, send_error from messages m where m.wa_id = c.wa_id order by id desc limit 1) last on true`;

  async getConversation(waId: string) {
    const { rows } = await this.pool.query(`${PgStore.select} where c.wa_id = $1`, [waId]);
    return rows[0] ? PgStore.row(rows[0]) : null;
  }

  async history(waId: string, limit: number) {
    const { rows } = await this.pool.query(
      `select author, body, created_at, send_error from
         (select * from messages where wa_id = $1 order by id desc limit $2) recent
       order by id`,
      [waId, limit],
    );
    return rows.map((r) => ({ author: r.author, body: r.body, createdAt: r.created_at, sendError: r.send_error }));
  }

  async setMode(waId: string, mode: Mode, reason: string | null = null) {
    await this.pool.query(
      `update conversations set mode = $2, handoff_reason = $3, updated_at = now() where wa_id = $1`,
      [waId, mode, mode === "human" ? reason : null],
    );
  }

  async listConversations() {
    const { rows } = await this.pool.query(`${PgStore.select} order by c.updated_at desc limit 200`);
    return rows.map(PgStore.row);
  }
}
