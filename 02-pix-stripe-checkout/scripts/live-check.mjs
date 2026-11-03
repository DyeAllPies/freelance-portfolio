// Drives the running checkout app against a local Supabase. Provider calls
// fail on dummy keys (that path is tested too); Stripe webhooks are signed
// here with the test secret the app was started with (STRIPE_WEBHOOK_SECRET
// =whsec_local), so the order state machine and payment_events run against
// the real database. The app runs on :3100.
//   SR_KEY=<SERVICE_ROLE_KEY> ANON_KEY=<ANON_KEY> node scripts/live-check.mjs
// Both keys come from `npx supabase status -o env`.
import Stripe from "stripe";

const base = "http://localhost:3100";
const rest = "http://127.0.0.1:54321/rest/v1";
const key = process.env.SR_KEY;
const db = (path, init = {}) =>
  fetch(`${rest}/${path}`, { ...init, headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", prefer: "return=representation", ...init.headers } }).then((r) => r.json());

const stripe = new Stripe("sk_test_dummy");
async function stripeEvent(id, type, object) {
  const payload = JSON.stringify({ id, object: "event", type, data: { object } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_local" });
  const res = await fetch(`${base}/api/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload });
  return res.status;
}

const out = {};
const home = await (await fetch(base)).text();
out.homeListsProducts = ["Caneca Dev", "Camiseta Hello World", "Adesivos"].every((n) => home.includes(n));

const products = await db("products?select=id,name,price_cents&order=price_cents");
out.products = products.map((p) => `${p.name}=${p.price_cents}`);

// The browser tries to set its own price: ignored, and the dummy provider key fails the order.
const res = await fetch(`${base}/api/orders`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ productId: products[0].id, email: "ana@example.com", method: "pix", price_cents: 1 }),
});
out.createWithDeadProvider = `${res.status} ${JSON.stringify(await res.json())}`;
const [failed] = await db("orders?select=status,amount_cents&order=created_at.desc&limit=1");
out.thatOrderInDb = failed;
out.badEmail = (await fetch(`${base}/api/orders`, { method: "POST", body: JSON.stringify({ productId: products[0].id, email: "x", method: "pix" }) })).status;

// A pending order, as if the provider had accepted it.
const [order] = await db("orders", { method: "POST", body: JSON.stringify({ product_id: products[1].id, amount_cents: products[1].price_cents, customer_email: "bia@example.com", method: "card" }) });
const meta = { metadata: { order_id: order.id } };
out.forged = (await fetch(`${base}/api/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": "t=1,v1=00" }, body: "{}" })).status;
out.paid = await stripeEvent("evt_live_1", "checkout.session.completed", { ...meta, payment_status: "paid" });
out.paidAgain = await stripeEvent("evt_live_1", "checkout.session.completed", { ...meta, payment_status: "paid" });
out.lateExpiry = await stripeEvent("evt_live_2", "checkout.session.expired", meta);
out.statusAfterLateExpiry = (await (await fetch(`${base}/api/orders/${order.id}`)).json()).status;
out.refund = await stripeEvent("evt_live_3", "charge.refunded", { ...meta, refunded: true });
out.finalStatus = (await (await fetch(`${base}/api/orders/${order.id}`)).json()).status;
out.events = (await db(`payment_events?select=event_id,status&order_id=eq.${order.id}&order=received_at`)).map((e) => `${e.event_id}:${e.status}`);
out.unknownOrder = await stripeEvent("evt_live_4", "checkout.session.expired", { metadata: { order_id: "00000000-0000-0000-0000-000000000000" } });
out.anonKeyBlocked = await fetch(`${rest}/orders?select=id`, { headers: { apikey: process.env.ANON_KEY, authorization: `Bearer ${process.env.ANON_KEY}` } }).then((r) => r.json()).then((rows) => (Array.isArray(rows) ? `rows=${rows.length}` : JSON.stringify(rows)));
console.log(JSON.stringify(out, null, 1));
