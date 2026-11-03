import { describe, expect, it } from "vitest";
import type { Turn } from "./bot.js";
import { OllamaBot, readOllamaReply } from "./ollama.js";

const choice = (message: unknown) => ({ choices: [{ message }] });
const call = (args: unknown, name = "handoff_to_human") => ({
  id: "c1",
  type: "function",
  function: { name, arguments: args },
});

describe("readOllamaReply", () => {
  it("returns the text answer", () => {
    expect(readOllamaReply(choice({ role: "assistant", content: " Abrimos às 18h. " }))).toEqual({
      kind: "text",
      text: "Abrimos às 18h.",
    });
  });

  it("hands off on a tool call whose arguments are a JSON string", () => {
    const reply = readOllamaReply(
      choice({ content: "", tool_calls: [call(JSON.stringify({ reason: "pedido atrasado" }))] }),
    );
    expect(reply).toEqual({ kind: "handoff", reason: "pedido atrasado", text: null });
  });

  it("hands off on a tool call whose arguments are an object", () => {
    const reply = readOllamaReply(choice({ content: null, tool_calls: [call({ reason: "reembolso" })] }));
    expect(reply).toEqual({ kind: "handoff", reason: "reembolso", text: null });
  });

  it("hands off with an empty reason when the arguments are garbage", () => {
    const reply = readOllamaReply(choice({ content: "", tool_calls: [call("{not json")] }));
    expect(reply).toEqual({ kind: "handoff", reason: "", text: null });
  });

  it("hands off on an empty answer with no tool call", () => {
    expect(readOllamaReply(choice({ content: "  " }))).toEqual({
      kind: "handoff",
      reason: "resposta vazia do modelo",
      text: null,
    });
    expect(readOllamaReply({}).kind).toBe("handoff");
  });

  it("keeps the model's sentence for the customer next to the tool call", () => {
    const reply = readOllamaReply(
      choice({ content: "Vou chamar um atendente.", tool_calls: [call({ reason: "reclamação" })] }),
    );
    expect(reply).toEqual({ kind: "handoff", reason: "reclamação", text: "Vou chamar um atendente." });
  });
});

function stub(status: number, body: unknown) {
  const seen: { url?: string; init?: RequestInit } = {};
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}

describe("OllamaBot", () => {
  it("sends the exact chat request and returns the reply", async () => {
    const { seen, fetchFn } = stub(200, choice({ content: "ok" }));
    const history: Turn[] = [
      { author: "agent", body: "Promoção hoje." },
      { author: "customer", body: "Oi" },
      { author: "bot", body: "Olá!" },
      { author: "agent", body: "Sou a Júlia." },
      { author: "customer", body: "Preço?" },
    ];

    const reply = await new OllamaBot("Horário: 18h às 23h.", "qwen2.5:1.5b", "http://ollama:11434/", fetchFn).reply(history);

    expect(reply).toEqual({ kind: "text", text: "ok" });
    expect(seen.url).toBe("http://ollama:11434/v1/chat/completions");
    expect(seen.init?.method).toBe("POST");
    const body = JSON.parse(String(seen.init?.body));
    expect(body.model).toBe("qwen2.5:1.5b");
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0.2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("Horário: 18h às 23h.");
    expect(body.messages.slice(1)).toEqual([
      { role: "user", content: "Oi" },
      { role: "assistant", content: "Olá!" },
      { role: "assistant", content: "Sou a Júlia." },
      { role: "user", content: "Preço?" },
    ]);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].type).toBe("function");
    expect(body.tools[0].function.name).toBe("handoff_to_human");
    expect(body.tools[0].function.parameters.required).toEqual(["reason"]);
  });

  it("sends only the last 20 turns of a 25-turn history", async () => {
    const { seen, fetchFn } = stub(200, choice({ content: "ok" }));
    const history: Turn[] = Array.from({ length: 25 }, (_, i) => ({ author: "customer", body: `m${i}` }));
    await new OllamaBot("x", "m", "http://o", fetchFn).reply(history);
    const body = JSON.parse(String(seen.init?.body));
    const turns = body.messages.filter((m: { role: string }) => m.role !== "system");
    expect(turns).toHaveLength(20);
    expect(turns[0].content).toBe("m5");
    expect(turns.at(-1).content).toBe("m24");
  });

  it("throws with the status and a slice of the body on a non-2xx", async () => {
    const { fetchFn } = stub(500, "x".repeat(500));
    const err = await new OllamaBot("x", "m", "http://o", fetchFn)
      .reply([{ author: "customer", body: "Oi" }])
      .catch((e: Error) => e.message);
    expect(err).toContain("500");
    expect(err).toContain("x".repeat(300));
    expect(err).not.toContain("x".repeat(301));
  });
});
