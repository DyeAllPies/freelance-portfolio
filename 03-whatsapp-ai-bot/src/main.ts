import { readFileSync } from "node:fs";
import pg from "pg";
import { createApp } from "./app.js";
import { ClaudeBot, type Bot } from "./bot.js";
import { OllamaBot } from "./ollama.js";
import { MemoryStore, PgStore, type Store } from "./store.js";
import { CloudApiSender } from "./whatsapp.js";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}; see .env.example`);
  return value;
}

const knowledge = readFileSync(new URL("../src/knowledge.md", import.meta.url), "utf8");

let store: Store;
let pool: pg.Pool | null = null;
if (process.env.DATABASE_URL) {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  store = new PgStore(pool);
} else {
  console.warn("DATABASE_URL is not set: conversations are kept in memory and lost on restart");
  store = new MemoryStore();
}

// The reply model: Claude by default, or a local open-source model through Ollama.
const provider = process.env.LLM_PROVIDER || "claude";
let bot: Bot;
if (provider === "claude") {
  bot = new ClaudeBot(knowledge, process.env.CLAUDE_MODEL || "claude-opus-5-5");
} else if (provider === "ollama") {
  bot = new OllamaBot(knowledge, process.env.OLLAMA_MODEL || "qwen2.5:1.5b", process.env.OLLAMA_URL || "http://localhost:11434");
} else {
  throw new Error(`unknown LLM_PROVIDER "${provider}"; use "claude" or "ollama"`);
}

const { app, idle } = createApp({
  store,
  sender: new CloudApiSender(
    env("WHATSAPP_TOKEN"),
    env("WHATSAPP_PHONE_NUMBER_ID"),
    undefined,
    process.env.WHATSAPP_GRAPH_URL || undefined,
  ),
  bot,
  config: {
    verifyToken: env("WHATSAPP_VERIFY_TOKEN"),
    appSecret: env("WHATSAPP_APP_SECRET"),
    adminUser: env("ADMIN_USER"),
    adminPassword: env("ADMIN_PASSWORD"),
  },
});

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => console.log(`listening on :${port}; dashboard at /admin`));

// Finish the replies already started before exiting.
process.on("SIGTERM", () => {
  server.close(async () => {
    await idle();
    await pool?.end();
    process.exit(0);
  });
});
