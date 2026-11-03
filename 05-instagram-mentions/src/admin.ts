import type { StoredMention } from "./store.js";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const when = (d: Date | null) =>
  d ? new Date(d).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "";

// Only web links are rendered as a link or an image; anything else a stored
// value might hold (javascript:, data:) is dropped.
const isWebUrl = (u: string | null): u is string => u !== null && /^https?:\/\//i.test(u);

const kindLabel = (m: StoredMention) => (m.kind === "comment" ? "comentário" : "legenda");
const who = (m: StoredMention) => (m.username ? `@${m.username}` : "autor não informado pela API");

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
.muted{color:var(--muted)}.tag{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--line)}
.msg{max-width:80%;padding:8px 12px;border-radius:10px;margin:6px 0;white-space:pre-wrap;border:1px solid var(--line)}
.mention{background:var(--in)}.reply{background:var(--out);margin-left:auto}
.failed{border:1px dashed var(--warn);opacity:.85}.failed-note{color:var(--warn);font-size:13px;margin-top:4px}
img{max-width:100%;border-radius:8px;border:1px solid var(--line)}
textarea{width:100%;min-height:80px;padding:8px;background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:8px}
button{padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}
</style></head><body><main>${body}</main></body></html>`;
}

export function listPage(mentions: StoredMention[]): string {
  const rows = mentions
    .map(
      (m) => `<tr>
  <td><a href="/admin/m/${m.id}">${escapeHtml(who(m))}</a></td>
  <td><span class="tag">${kindLabel(m)}</span></td>
  <td>${m.fetchError ? `<span class="failed-note">Não lida: </span>` : ""}${escapeHtml(m.text.slice(0, 80))}</td>
  <td class="muted">${when(m.postedAt ?? m.receivedAt)}</td>
  <td class="muted">${m.replies.length}</td>
</tr>`,
    )
    .join("");
  return page(
    "Menções",
    `<h1>Menções</h1>
<table><thead><tr><th>Quem</th><th>Tipo</th><th>Texto</th><th>Quando</th><th>Respostas</th></tr></thead>
<tbody>${rows || `<tr><td colspan="5" class="muted">Nenhuma menção ainda.</td></tr>`}</tbody></table>`,
  );
}

export function mentionPage(m: StoredMention, error = ""): string {
  const replies = m.replies
    .map(
      (r) =>
        `<div class="msg reply${r.sendError ? " failed" : ""}"><div class="muted">resposta · ${when(r.createdAt)}</div>${escapeHtml(r.body)}${
          r.sendError ? `<div class="failed-note">Não entregue: ${escapeHtml(r.sendError)}</div>` : ""
        }</div>`,
    )
    .join("");
  return page(
    `Menção de ${who(m)}`,
    `<p><a href="/admin">← Menções</a></p>
<h1>${escapeHtml(who(m))} <span class="tag">${kindLabel(m)}</span></h1>
<p class="muted">${when(m.postedAt ?? m.receivedAt)}${
      isWebUrl(m.permalink) ? ` · <a href="${escapeHtml(m.permalink)}" rel="noopener noreferrer">ver no Instagram</a>` : ""
    }</p>
${m.fetchError ? `<p class="failed-note">Não foi possível ler a menção: ${escapeHtml(m.fetchError)}</p>` : ""}
${m.text ? `<div class="msg mention">${escapeHtml(m.text)}</div>` : ""}
${isWebUrl(m.mediaUrl) ? `<p><img src="${escapeHtml(m.mediaUrl)}" alt="Mídia da menção"></p>` : ""}
${replies}
${error ? `<p style="color:var(--warn)">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/admin/m/${m.id}/reply"><textarea name="body" required maxlength="2200" placeholder="Responder à menção"></textarea>
<div class="row"><button type="submit">Responder</button></div></form>`,
  );
}
