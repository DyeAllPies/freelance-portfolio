import type { Conversation, StoredMessage } from "./store.js";
import { withinServiceWindow } from "./whatsapp.js";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const when = (d: Date | null) =>
  d ? new Date(d).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "";

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#f6f7f8;--card:#fff;--text:#1b1c20;--muted:#646675;--line:#e2e3e8;--in:#ffffff;--out:#d9fdd3;--warn:#b54708}
@media (prefers-color-scheme:dark){:root{--bg:#121316;--card:#1c1d22;--text:#ececf1;--muted:#a1a2ae;--line:#2d2e36;--in:#22232a;--out:#1f4d3a;--warn:#f79009}}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--text)}
main{max-width:760px;margin:0 auto;padding:16px}a{color:inherit}
table{width:100%;border-collapse:collapse;background:var(--card)}td,th{padding:10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.muted{color:var(--muted)}.tag{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--line)}.human{border-color:var(--warn);color:var(--warn)}
.msg{max-width:80%;padding:8px 12px;border-radius:10px;margin:6px 0;white-space:pre-wrap;border:1px solid var(--line)}
.customer{background:var(--in)}.bot,.agent{background:var(--out);margin-left:auto}
.failed{border:1px dashed var(--warn);opacity:.85}.failed-note{color:var(--warn);font-size:13px;margin-top:4px}
textarea{width:100%;min-height:80px;padding:8px;background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:8px}
button{padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}
</style></head><body><main>${body}</main></body></html>`;
}

export function listPage(conversations: Conversation[]): string {
  const rows = conversations
    .map(
      (c) => `<tr>
  <td><a href="/admin/c/${encodeURIComponent(c.waId)}">${escapeHtml(c.name || c.waId)}</a><div class="muted">+${escapeHtml(c.waId)}</div></td>
  <td>${c.lastMessageFailed ? `<span class="failed-note">Não entregue: </span>` : ""}${escapeHtml(c.lastMessage.slice(0, 80))}</td>
  <td><span class="tag ${c.mode}">${c.mode === "human" ? "atendente" : "bot"}</span></td>
  <td class="muted">${when(c.updatedAt)}</td>
</tr>`,
    )
    .join("");
  return page(
    "Conversas",
    `<h1>Conversas</h1>
<table><thead><tr><th>Cliente</th><th>Última mensagem</th><th>Quem responde</th><th>Atualizada</th></tr></thead>
<tbody>${rows || `<tr><td colspan="4" class="muted">Nenhuma conversa ainda.</td></tr>`}</tbody></table>`,
  );
}

export function conversationPage(c: Conversation, messages: StoredMessage[], error = "", now = new Date()): string {
  const open = withinServiceWindow(c.lastInboundAt, now);
  const bubbles = messages
    .map(
      (m) =>
        `<div class="msg ${m.author}${m.sendError ? " failed" : ""}"><div class="muted">${{ customer: "cliente", bot: "bot", agent: "atendente" }[m.author]} · ${when(m.createdAt)}</div>${escapeHtml(m.body)}${
          m.sendError ? `<div class="failed-note">Não entregue: ${escapeHtml(m.sendError)}</div>` : ""
        }</div>`,
    )
    .join("");
  const id = encodeURIComponent(c.waId);
  return page(
    c.name || c.waId,
    `<p><a href="/admin">← Conversas</a></p>
<h1>${escapeHtml(c.name || c.waId)} <span class="tag ${c.mode}">${c.mode === "human" ? "atendente" : "bot"}</span></h1>
${c.mode === "human" && c.handoffReason ? `<p class="muted">Motivo da transferência: ${escapeHtml(c.handoffReason)}</p>` : ""}
${bubbles}
${error ? `<p style="color:var(--warn)">${escapeHtml(error)}</p>` : ""}
${
  open
    ? `<form method="post" action="/admin/c/${id}/reply"><textarea name="body" required placeholder="Responder como atendente"></textarea>
<div class="row"><button type="submit">Enviar</button></div></form>`
    : `<p class="muted">Passaram mais de 24 horas desde a última mensagem do cliente. O WhatsApp só aceita um modelo aprovado agora.</p>`
}
<form method="post" action="/admin/c/${id}/mode" class="row">
<input type="hidden" name="mode" value="${c.mode === "human" ? "bot" : "human"}">
<button type="submit">${c.mode === "human" ? "Devolver ao bot" : "Assumir conversa"}</button></form>`,
  );
}
