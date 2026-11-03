import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ClaudeBot, readReply, toMessages, wantsHuman, type Turn } from "./bot.js";

const message = (content: unknown[], stop_reason = "end_turn") =>
  ({ content, stop_reason }) as unknown as Anthropic.Beta.BetaMessage;

describe("wantsHuman", () => {
  it("catches requests for a person", () => {
    for (const t of ["Quero falar com um atendente", "HUMANO por favor", "posso falar com alguém?", "chama o gerente"]) {
      expect(wantsHuman(t), t).toBe(true);
    }
  });
  it("leaves menu questions to the bot", () => {
    for (const t of ["A pizza serve quantas pessoas?", "Vocês abrem segunda?", "Qual o preço da calabresa?"]) {
      expect(wantsHuman(t), t).toBe(false);
    }
  });
});

describe("toMessages", () => {
  it("starts at the customer's first message and maps authors to roles", () => {
    const history: Turn[] = [
      { author: "agent", body: "Olá! Promoção hoje." },
      { author: "customer", body: "Oi" },
      { author: "bot", body: "Olá!" },
      { author: "agent", body: "Sou a Júlia." },
      { author: "customer", body: "Preço?" },
    ];
    expect(toMessages(history)).toEqual([
      { role: "user", content: "Oi" },
      { role: "assistant", content: "Olá!" },
      { role: "assistant", content: "Sou a Júlia." },
      { role: "user", content: "Preço?" },
    ]);
    expect(toMessages([{ author: "bot", body: "x" }])).toEqual([]);
  });
});

describe("readReply", () => {
  it("returns the text answer", () => {
    expect(readReply(message([{ type: "text", text: "Abrimos às 18h." }]))).toEqual({ kind: "text", text: "Abrimos às 18h." });
  });

  it("hands off when the model calls the tool, keeping its sentence for the customer", () => {
    const reply = readReply(
      message(
        [
          { type: "text", text: "Vou chamar um atendente." },
          { type: "tool_use", id: "t1", name: "handoff_to_human", input: { reason: "pedido atrasado" } },
        ],
        "tool_use",
      ),
    );
    expect(reply).toEqual({ kind: "handoff", reason: "pedido atrasado", text: "Vou chamar um atendente." });
  });

  it("hands off on a refusal or an empty answer instead of sending nothing", () => {
    expect(readReply(message([], "refusal")).kind).toBe("handoff");
    expect(readReply(message([{ type: "thinking", thinking: "" }])).kind).toBe("handoff");
  });
});

describe("ClaudeBot", () => {
  it("sends the cached system prompt, the handoff tool and the recent history", async () => {
    let params: any;
    const client = {
      beta: {
        messages: {
          create: async (p: unknown) => {
            params = p;
            return message([{ type: "text", text: "ok" }]);
          },
        },
      },
    } as unknown as Anthropic;
    const history: Turn[] = Array.from({ length: 30 }, (_, i) => ({ author: "customer", body: `m${i}` }));

    const reply = await new ClaudeBot("Horário: 18h às 23h.", "claude-opus-5-5", client).reply(history);

    expect(reply).toEqual({ kind: "text", text: "ok" });
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(params.fallbacks).toBe("default");
    expect(params.system[0].text).toContain("Horário: 18h às 23h.");
    expect(params.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(params.tools.map((t: any) => t.name)).toEqual(["handoff_to_human"]);
    expect(params.messages).toHaveLength(20);
    expect(params.messages.at(-1)).toEqual({ role: "user", content: "m29" });
  });
});
