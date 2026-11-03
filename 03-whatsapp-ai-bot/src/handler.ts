import { wantsHuman, type Bot } from "./bot.js";
import type { Store } from "./store.js";
import type { Inbound, Sender } from "./whatsapp.js";

export const MESSAGES = {
  handoff: "Certo! Vou chamar um atendente, que responde por aqui em breve.",
  textOnly: "Por enquanto consigo ler só mensagens de texto. Pode escrever sua dúvida?",
  error: "Tive um problema para responder agora. Já chamei um atendente para te ajudar.",
};

// What the dashboard shows for a refused send: the sender's error, kept short.
export function sendErrorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

// Handles one customer message, start to finish. Every branch stores what
// was sent, so the dashboard shows the whole conversation.
export async function handleInbound(msg: Inbound, deps: { store: Store; sender: Sender; bot: Bot }) {
  const { store, sender, bot } = deps;
  const body = msg.text ?? `[${msg.type}]`;
  const isNew = await store.recordInbound({ wamid: msg.wamid, waId: msg.waId, name: msg.name, body, at: msg.sentAt });
  if (!isNew) return "duplicate";

  const conversation = await store.getConversation(msg.waId);
  // An attendant owns the conversation: the bot stays quiet until handed back.
  if (conversation?.mode === "human") return "human";

  // A reply WhatsApp refuses is stored as failed and the conversation goes to
  // an attendant, so the dashboard shows the customer is still waiting.
  const send = async (text: string) => {
    try {
      const wamid = await sender.sendText(msg.waId, text);
      await store.recordOutbound(msg.waId, "bot", text, wamid);
    } catch (err) {
      console.error(`conversation ${msg.waId}: send failed`, err);
      await store.recordOutbound(msg.waId, "bot", text, null, sendErrorText(err));
      if ((await store.getConversation(msg.waId))?.mode !== "human") {
        await store.setMode(msg.waId, "human", "o WhatsApp recusou a resposta do bot");
      }
    }
  };

  if (msg.text === null) {
    await send(MESSAGES.textOnly);
    return "text-only";
  }
  if (wantsHuman(msg.text)) {
    await store.setMode(msg.waId, "human", "o cliente pediu um atendente");
    await send(MESSAGES.handoff);
    return "handoff";
  }

  try {
    // Replies the customer never got are left out of what the model reads.
    const history = (await store.history(msg.waId, 20)).filter((m) => !m.sendError);
    const reply = await bot.reply(history);
    if (reply.kind === "handoff") {
      await store.setMode(msg.waId, "human", reply.reason);
      await send(reply.text ?? MESSAGES.handoff);
      return "handoff";
    }
    await send(reply.text);
    return "answered";
  } catch (err) {
    console.error(`conversation ${msg.waId}: bot failed`, err);
    await store.setMode(msg.waId, "human", "erro ao gerar resposta");
    await send(MESSAGES.error);
    return "error";
  }
}
