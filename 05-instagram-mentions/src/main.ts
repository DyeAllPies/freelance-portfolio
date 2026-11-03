import { readFileSync } from "node:fs";
import pg from "pg";
import { createApp } from "./app.js";
import { GraphApiClient } from "./instagram.js";
import { MemoryStore, PgStore, type Store } from "./store.js";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}; see .env.example`);
  return value;
}

let store: Store;
let pool: pg.Pool | null = null;
if (process.env.DATABASE_URL) {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  store = new PgStore(pool);
} else {
  console.warn("DATABASE_URL is not set: mentions are kept in memory and lost on restart");
  store = new MemoryStore();
}

const { app, idle } = createApp({
  store,
  graph: new GraphApiClient(env("INSTAGRAM_ACCESS_TOKEN"), {
    baseUrl: process.env.GRAPH_BASE_URL || undefined,
    version: process.env.GRAPH_API_VERSION || undefined,
  }),
  config: {
    verifyToken: env("INSTAGRAM_VERIFY_TOKEN"),
    appSecret: env("INSTAGRAM_APP_SECRET"),
    adminUser: env("ADMIN_USER"),
    adminPassword: env("ADMIN_PASSWORD"),
  },
});

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => console.log(`listening on :${port}; dashboard at /admin`));

// Finish the mentions already started before exiting.
process.on("SIGTERM", () => {
  server.close(async () => {
    await idle();
    await pool?.end();
    process.exit(0);
  });
});
