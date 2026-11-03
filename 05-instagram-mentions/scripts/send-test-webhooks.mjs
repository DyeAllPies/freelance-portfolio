// Drives a running stack (docker compose up, or the app plus the mock started by
// hand): the webhook handshake, a forged webhook, a comment mention and a caption
// mention emitted by the Graph mock, the same webhook delivered twice, a reply
// through the dashboard form, and the dashboard itself. Then it prints what held.
//   node scripts/send-test-webhooks.mjs
// Reads the same variables docker-compose.yml does; the defaults are the local
// test values the keyless run uses.
import { createHmac } from "node:crypto";

const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const mockUrl = (process.env.MOCK_URL || "http://localhost:4010").replace(/\/$/, "");
const secret = process.env.INSTAGRAM_APP_SECRET || "mock-app-secret";
const verifyToken = process.env.INSTAGRAM_VERIFY_TOKEN || "local-verify";
const igUserId = process.env.MOCK_IG_USER_ID || "17841400000000001";
const auth =
  "Basic " + Buffer.from(`${process.env.ADMIN_USER || "admin"}:${process.env.ADMIN_PASSWORD || "local-pw"}`).toString("base64");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sign = (body) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

const webhook = (mediaId, commentId) =>
  JSON.stringify({
    object: "instagram",
    entry: [
      {
        id: igUserId,
        time: Math.floor(Date.now() / 1000),
        changes: [{ field: "mentions", value: { media_id: mediaId, ...(commentId ? { comment_id: commentId } : {}) } }],
      },
    ],
  });

async function postToApp(body, signature) {
  const res = await fetch(`${appUrl}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature },
    body,
  });
  return res.status;
}

async function emit(payload) {
  const res = await fetch(`${mockUrl}/__mock/mentions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

const admin = async (path, init = {}) =>
  fetch(`${appUrl}/admin${path}`, { redirect: "manual", ...init, headers: { authorization: auth, ...init.headers } });
const listHtml = async () => (await admin("")).text();

// The dashboard fills in after the webhook is acknowledged, so wait for it.
async function waitFor(needle) {
  for (let i = 0; i < 40; i++) {
    const html = await listHtml();
    if (html.includes(needle)) return html;
    await sleep(250);
  }
  return listHtml();
}

const rowOf = (html, needle) => html.split("<tr>").find((row) => row.includes(needle)) ?? "";
const idOf = (row) => /href="\/admin\/m\/(\d+)"/.exec(row)?.[1];
const rowCount = (html) => (html.match(/href="\/admin\/m\/\d+"/g) ?? []).length;

const out = {};
out.challenge = await (await fetch(`${appUrl}/webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=abc`)).text();
out.forged = await postToApp(webhook("1", "2"), "sha256=" + "0".repeat(64));

const commentText = "Amei o produto <script>alert(1)</script> @loja";
const comment = await emit({ kind: "comment", username: "ana", text: commentText });
const caption = await emit({ kind: "media", username: "bruno <i>", text: "olha o que eu comprei @loja <script>alert(2)</script>" });
out.emitted = { comment: comment.delivered, caption: caption.delivered };

let list = await waitFor("olha o que eu comprei");
list = await waitFor("Amei o produto");
out.listShowsBoth = list.includes("Amei o produto") && list.includes("olha o que eu comprei");
out.escapes =
  list.includes("&lt;script&gt;alert(1)&lt;/script&gt;") &&
  list.includes("bruno &lt;i&gt;") &&
  !list.includes("<script>alert") &&
  !list.includes("bruno <i>");

// Meta delivers a webhook more than once; the identical signed body again must
// not store a second mention.
const before = rowCount(list);
const again = webhook(comment.mediaId, comment.commentId);
out.duplicate = [await postToApp(again, sign(again)), await postToApp(again, sign(again))];
await sleep(1500);
out.storedOnce = rowCount(await listHtml()) === before;

const commentRow = rowOf(list, "Amei o produto");
const captionRow = rowOf(list, "olha o que eu comprei");
const commentPage = await (await admin(`/m/${idOf(commentRow)}`)).text();
const captionPage = await (await admin(`/m/${idOf(captionRow)}`)).text();
out.detailEscapes =
  commentPage.includes("&lt;script&gt;alert(1)&lt;/script&gt;") &&
  captionPage.includes("&lt;script&gt;alert(2)&lt;/script&gt;") &&
  !commentPage.includes("<script>alert") &&
  !captionPage.includes("<script>alert");
out.captionImage = captionPage.includes(`<img src="${mockUrl}/__mock/img/${caption.mediaId}.svg"`);

// Reply to the comment mention through the dashboard form (no Origin header).
const reply = await admin(`/m/${idOf(commentRow)}/reply`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ body: "Obrigada pela marcação!" }).toString(),
});
out.replyStatus = reply.status;
const replies = await (await fetch(`${mockUrl}/__mock/replies`)).json();
out.replySeenByMock = replies.some(
  (r) => r.message === "Obrigada pela marcação!" && r.commentId === comment.commentId && r.mediaId === comment.mediaId,
);

out.noAuth = (await fetch(`${appUrl}/admin`)).status;
console.log(JSON.stringify(out, null, 1));

const held =
  out.challenge === "abc" &&
  out.forged === 401 &&
  out.listShowsBoth &&
  out.escapes &&
  out.storedOnce &&
  out.detailEscapes &&
  out.replyStatus === 303 &&
  out.replySeenByMock &&
  out.noAuth === 401;
if (!held) process.exitCode = 1;
