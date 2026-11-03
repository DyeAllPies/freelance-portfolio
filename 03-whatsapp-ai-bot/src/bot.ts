import Anthropic from "@anthropic-ai/sdk";

export type Turn = { author: "customer" | "bot" | "agent"; body: string };
export type BotReply = { kind: "text"; text: string } | { kind: "handoff"; reason: string; text: string | null };

export interface Bot {
  reply(history: Turn[]): Promise<BotReply>;
}

// A customer asking for a person skips the model entirely: it is cheaper,
// and the request is honoured even if the API is down.
// "pessoa" alone is left out: "serve quantas pessoas?" is a menu question.
const HUMAN = /\b(atendente|humano|gerente)\b|falar com (algu[eé]m|uma pessoa)/i;
export function wantsHuman(text: string): boolean {
  return HUMAN.test(text);
}

export const HANDOFF_TOOL_NAME = "handoff_to_human";
export const HANDOFF_TOOL_DESCRIPTION =
  "Pass the conversation to a human attendant. Use it for complaints, refunds, cancellations, " +
  "large event orders, anything the business information does not answer, or when the customer is upset.";

const HANDOFF_TOOL: Anthropic.Beta.BetaTool = {
  name: HANDOFF_TOOL_NAME,
  description: HANDOFF_TOOL_DESCRIPTION,
  input_schema: {
    type: "object",
    properties: { reason: { type: "string", description: "One short sentence for the attendant, in Portuguese." } },
    required: ["reason"],
    additionalProperties: false,
  },
  strict: true,
};

export function systemPrompt(knowledge: string): string {
  return `You answer WhatsApp messages for a small business in Brazil. Write in Brazilian Portuguese, in a friendly, short way: two to four sentences, no markdown headings or tables, since WhatsApp shows them as raw symbols.

Answer only from the business information below. When it does not cover the question, or the customer has a complaint, wants a refund or cancellation, or asks for a person, call handoff_to_human instead of guessing, and write one short sentence telling the customer an attendant will reply soon.

Never invent prices, hours, addresses or promises.

<business_information>
${knowledge}
</business_information>`;
}

// The stored conversation becomes Messages API turns. The API wants the
// first turn from the user, so anything the bot said before the customer's
// first message is dropped.
export function toMessages(history: Turn[]): Anthropic.Beta.BetaMessageParam[] {
  const first = history.findIndex((t) => t.author === "customer");
  if (first < 0) return [];
  return history.slice(first).map((t) => ({
    role: t.author === "customer" ? ("user" as const) : ("assistant" as const),
    content: t.body,
  }));
}

export function readReply(response: Anthropic.Beta.BetaMessage): BotReply {
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  // A declined request is handed to a person rather than answered with nothing.
  if (response.stop_reason === "refusal") return { kind: "handoff", reason: "o modelo recusou responder", text: null };

  const handoff = response.content.find(
    (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === "handoff_to_human",
  );
  if (handoff) {
    const input = handoff.input as { reason?: unknown };
    return { kind: "handoff", reason: String(input.reason ?? ""), text: text || null };
  }
  if (!text) return { kind: "handoff", reason: "resposta vazia do modelo", text: null };
  return { kind: "text", text };
}

export class ClaudeBot implements Bot {
  private client: Anthropic;
  private system: string;

  constructor(
    knowledge: string,
    private model = "claude-opus-5-5",
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic();
    this.system = systemPrompt(knowledge);
  }

  async reply(history: Turn[]): Promise<BotReply> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 2000,
      // Chat is a low-effort route: short answers from a fixed text.
      output_config: { effort: "low" },
      // If a safety classifier declines, the API retries on a fallback model
      // within the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // The system prompt is identical on every call, so it is cached.
      system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
      tools: [HANDOFF_TOOL],
      tool_choice: { type: "auto" },
      messages: toMessages(history.slice(-20)),
    });
    return readReply(response);
  }
}
