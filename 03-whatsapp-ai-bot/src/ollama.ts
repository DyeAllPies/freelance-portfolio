import { HANDOFF_TOOL_DESCRIPTION, HANDOFF_TOOL_NAME, systemPrompt, type Bot, type BotReply, type Turn } from "./bot.js";

// A local open-source model served by Ollama, through its OpenAI-compatible
// chat endpoint. It answers through the same Bot interface as ClaudeBot, so the
// handoff and the refused-send marking behave the same.

type FetchFn = typeof fetch;

const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 120000;

// The chat messages after the system prompt: the first turn is the customer's,
// the bot's and the agent's earlier turns are the assistant's.
function chatMessages(history: Turn[]): { role: "user" | "assistant"; content: string }[] {
  const first = history.findIndex((t) => t.author === "customer");
  if (first < 0) return [];
  return history.slice(first).map((t) => ({
    role: t.author === "customer" ? ("user" as const) : ("assistant" as const),
    content: t.body,
  }));
}

function readReason(args: unknown): string {
  let value: unknown = args;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return "";
    }
  }
  if (value && typeof value === "object") {
    const reason = (value as { reason?: unknown }).reason;
    if (typeof reason === "string") return reason;
  }
  return "";
}

export function readOllamaReply(json: unknown): BotReply {
  const message = (json as any)?.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  const calls: unknown[] = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const handoff = calls.find((c: any) => c?.function?.name === HANDOFF_TOOL_NAME) as any;
  if (handoff) return { kind: "handoff", reason: readReason(handoff.function.arguments), text: content || null };
  if (!content) return { kind: "handoff", reason: "resposta vazia do modelo", text: null };
  return { kind: "text", text: content };
}

export class OllamaBot implements Bot {
  private system: string;

  constructor(
    knowledge: string,
    private model: string,
    private baseUrl: string,
    private fetchFn: FetchFn = fetch,
  ) {
    this.system = systemPrompt(knowledge);
  }

  async reply(history: Turn[]): Promise<BotReply> {
    const res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: this.model,
        stream: false,
        temperature: 0.2,
        messages: [{ role: "system", content: this.system }, ...chatMessages(history.slice(-20))],
        tools: [
          {
            type: "function",
            function: {
              name: HANDOFF_TOOL_NAME,
              description: HANDOFF_TOOL_DESCRIPTION,
              parameters: {
                type: "object",
                properties: { reason: { type: "string" } },
                required: ["reason"],
              },
            },
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return readOllamaReply(await res.json());
  }
}
