// Drives the running app and the running local mock providers against a local
// Supabase, end to end, with no provider account. Each row is
// { name, expected, actual }; the rows print as one JSON object and the exit
// code is 1 if any row differs.
//
// Start, in this order, from this folder:
//   1. npx supabase start && npx supabase db reset
//   2. npm run mock      (uses .env.local copied from .env.keyless.example)
//   3. npm run dev       (the app, on :3000)
// Then:
//   SR_KEY=<SERVICE_ROLE_KEY> ANON_KEY=<ANON_KEY> npm run keyless-check
// Both keys come from `npx supabase status -o env`. BASE (default
// http://localhost:3000) and MOCK (default http://localhost:4010) override the
// two addresses.

const base = (process.env.BASE || "http://localhost:3000").replace(/\/+$/, "");
const mock = (process.env.MOCK || "http://localhost:4010").replace(/\/+$/, "");
const rest = "http://127.0.0.1:54321/rest/v1";
const key = process.env.SR_KEY;
const anon = process.env.ANON_KEY;
if (!key || !anon) {
  console.error("SR_KEY and ANON_KEY are required (see `npx supabase status -o env`).");
  process.exit(2);
}

const db = (path, init = {}) =>
  fetch(`${rest}/${path}`, {
    ...init,
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", ...init.headers },
  }).then((r) => r.json());

const rows = [];
const row = (name, expected, actual) => rows.push({ name, expected, actual });

const products = await db("products?select=id,name,price_cents&order=price_cents");
const home = await (await fetch(base)).text();
row("home lists the three products", true, products.length === 3 && products.every((p) => home.includes(p.name)));

async function createOrder(method, email) {
  const res = await fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId: products[0].id, email, method }),
  });
  return { status: res.status, body: await res.json() };
}
const getOrder = async (id) => (await fetch(`${base}/api/orders/${id}`)).json();
const providerRef = async (id) => (await db(`orders?select=provider_ref&id=eq.${id}`))[0]?.provider_ref;
const eventCount = async (id, provider) => (await db(`payment_events?select=event_id&order_id=eq.${id}&provider=eq.${provider}`)).length;
const control = async (path) => (await fetch(`${mock}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: path.includes("/mp/") && path.includes("/status") ? JSON.stringify({ status: "approved" }) : undefined })).json();

// ---- PIX through the mock Mercado Pago ----
const pix = await createOrder("pix", "ana@example.com");
const pixId = pix.body.orderId;
row("PIX order returns the order page", `/orders/${pixId}`, pix.body.redirect);
const pixOrder = await getOrder(pixId);
row("PIX order is pending with a QR and a copy-paste", { status: "pending", qr: true, code: true }, {
  status: pixOrder.status,
  qr: Boolean(pixOrder.pixQrBase64),
  code: Boolean(pixOrder.pixCopyPaste),
});

const pixRef = await providerRef(pixId);
row("forged approval is refused by the app", { delivered: 401 }, await control(`/_mock/mp/payments/${pixRef}/status?bad=1`));
row("order stays pending after the forged approval", "pending", (await getOrder(pixId)).status);
row("signed approval is accepted", { delivered: 200 }, await control(`/_mock/mp/payments/${pixRef}/status`));
row("order becomes paid", "paid", (await getOrder(pixId)).status);
row("replayed approval is accepted", { delivered: 200 }, await control(`/_mock/mp/payments/${pixRef}/replay`));
row("replay leaves exactly one mercadopago event", 1, await eventCount(pixId, "mercadopago"));

// ---- Card through the mock Stripe Checkout ----
const card = await createOrder("card", "bia@example.com");
const cardId = card.body.orderId;
const cardRef = await providerRef(cardId);
row("card order returns the mock's checkout url", `${mock}/stripe/pay/${cardRef}`, card.body.redirect);
row("card order is pending", "pending", (await getOrder(cardId)).status);
row("signed completion is accepted", { delivered: 200 }, await control(`/_mock/stripe/sessions/${cardRef}/complete`));
row("card order becomes paid", "paid", (await getOrder(cardId)).status);
row("replayed completion is accepted", { delivered: 200 }, await control(`/_mock/stripe/sessions/${cardRef}/replay`));
row("replay leaves exactly one stripe event", 1, await eventCount(cardId, "stripe"));

const card2 = await createOrder("card", "caio@example.com");
const card2Id = card2.body.orderId;
const card2Ref = await providerRef(card2Id);
row("forged completion is refused by the app", { delivered: 400 }, await control(`/_mock/stripe/sessions/${card2Ref}/complete?bad=1`));
row("second card order stays pending", "pending", (await getOrder(card2Id)).status);

row("an expiry after payment is accepted", { delivered: 200 }, await control(`/_mock/stripe/sessions/${cardRef}/expire`));
row("expiry after paid leaves it paid", "paid", (await getOrder(cardId)).status);
row("a refund is accepted", { delivered: 200 }, await control(`/_mock/stripe/sessions/${cardRef}/refund`));
row("refund makes it refunded", "refunded", (await getOrder(cardId)).status);

const anonRows = await fetch(`${rest}/orders?select=id`, { headers: { apikey: anon, authorization: `Bearer ${anon}` } }).then((r) => r.json());
row("the anon key reads no orders", "rows=0", Array.isArray(anonRows) ? `rows=${anonRows.length}` : JSON.stringify(anonRows));

const differing = rows.filter((r) => JSON.stringify(r.expected) !== JSON.stringify(r.actual));
console.log(JSON.stringify({ ok: differing.length === 0, differing: differing.length, rows }, null, 1));
process.exit(differing.length ? 1 : 0);
