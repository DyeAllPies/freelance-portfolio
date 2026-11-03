import { mentionKey, type Graph, type MentionEvent } from "./instagram.js";
import type { Store } from "./store.js";

// What the dashboard shows for a failed Graph call: the error, kept short.
export function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

// Handles one mention, start to finish. A mention Graph could not be read for
// is stored with the error, so the dashboard still shows it.
export async function handleMention(e: MentionEvent, deps: { store: Store; graph: Graph }): Promise<"duplicate" | "stored" | "fetch-failed"> {
  const { store, graph } = deps;
  if (await store.hasMention(mentionKey(e))) return "duplicate";

  let detail;
  try {
    detail = await graph.fetchMention(e);
  } catch (err) {
    console.error(`mention ${mentionKey(e)}: fetch failed`, err);
    return (await store.recordMention(e, null, errorText(err))) ? "fetch-failed" : "duplicate";
  }
  return (await store.recordMention(e, detail, null)) ? "stored" : "duplicate";
}
