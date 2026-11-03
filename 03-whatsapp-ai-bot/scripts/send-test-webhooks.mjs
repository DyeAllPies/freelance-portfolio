// Drives a running bot: signed webhooks, a duplicate, a forged one, and the
// dashboard, then prints what held. It works with the keyless stack
// (docker compose -f docker-compose.keyless.yml up -d --wait) and with dummy
// WhatsApp and Claude keys, where every conversation ends with an attendant,
// which also fills the dashboard for screenshots.
//   node scripts/send-test-webhooks.mjs
// Bruno's message goes through the local mock (MOCK_URL, default
// http://localhost:3100) when it answers, so its chat page shows both sides;
// otherwise it is posted straight to the bot. It then waits, polling every
// 500 ms up to BOT_WAIT_MS (default 120000), for the bot's answer.
// Reads WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, ADMIN_USER and
// ADMIN_PASSWORD from the environment; the defaults match a local test .env.
import { createHmac } from "node:crypto";

const base = process.env.BOT_URL || "http://localhost:3000";
const mockUrl = process.env.MOCK_URL || "http://localhost:3100";
const secret = process.env.WHATSAPP_APP_SECRET || "local-app-secret";
const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || "local-verify";
const auth =
  "Basic " + Buffer.from(`${process.env.ADMIN_USER || "admin"}:${process.env.ADMIN_PASSWORD || "local-pw"}`).toString("base64");
const now = Math.floor(Date.now() / 1000);

const payload = (from, name, id, body) =>
  JSON.stringify({
    entry: [{ changes: [{ value: {
      contacts: [{ wa_id: from, profile: { name } }],
      messages: [{ id, from, timestamp: String(now), type: "text", text: { body } }],
    } }] }],
  });

async function post(body, sig) {
  const res = await fetch(`${base}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig ?? "sha256=" + createHmac("sha256", secret).update(body).digest("hex") },
    body,
  });
  return res.status;
}

const out = {};
out.challenge = await (await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=abc`)).text();
out.forged = await post(payload("5519900000001", "X", "wamid.f", "oi"), "sha256=" + "0".repeat(64));
const handoff = payload("5519900000001", "Ana <b>", "wamid.live.1", "quero falar com um atendente <script>x</script>");
out.handoff = await post(handoff);
out.duplicate = await post(handoff);
// Through the mock when it is up, so its chat page shows Bruno's side too.
const mockUp = await fetch(`${mockUrl}/health`).then((r) => r.ok, () => false);
if (mockUp) {
  const res = await fetch(`${mockUrl}/mock/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "5519900000002", name: "Bruno", text: "Vocês abrem segunda?" }),
  });
  out.botPath = (await res.json()).status;
} else {
  out.botPath = await post(payload("5519900000002", "Bruno", "wamid.live.2", "Vocês abrem segunda?"));
}
// Poll until both numbers are listed and Bruno's conversation has a bot reply
// or has gone to an attendant; a small local model can take a while.
const admin = (path) => fetch(`${base}${path}`, { headers: { authorization: auth } }).then((r) => r.text());
const deadline = Date.now() + Number(process.env.BOT_WAIT_MS || 120000);
let list = "";
for (;;) {
  list = await admin("/admin");
  const bruno = await admin("/admin/c/5519900000002");
  const answered = bruno.includes('class="msg bot') || bruno.includes(">atendente</span>");
  if ((list.includes("5519900000001") && list.includes("5519900000002") && answered) || Date.now() >= deadline) break;
  await new Promise((r) => setTimeout(r, 500));
}
out.listShowsBoth = list.includes("5519900000001") && list.includes("5519900000002");
out.listEscapesName = list.includes("Ana &lt;b&gt;") && !list.includes("Ana <b>");
const conv = await (await fetch(`${base}/admin/c/5519900000001`, { headers: { authorization: auth } })).text();
out.convEscapesBody = conv.includes("&lt;script&gt;x&lt;/script&gt;");
out.noAuth = (await fetch(`${base}/admin`)).status;
console.log(JSON.stringify(out, null, 1));
