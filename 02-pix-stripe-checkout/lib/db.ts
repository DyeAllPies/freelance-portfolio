import { createClient } from "@supabase/supabase-js";
import { env } from "./env";
import { nextStatus, type OrderStatus, type PaymentMethod } from "./orders";

export type Product = { id: string; name: string; description: string; price_cents: number };
export type Order = {
  id: string;
  product_id: string;
  amount_cents: number;
  customer_email: string;
  method: PaymentMethod;
  status: OrderStatus;
  provider_ref: string | null;
  pix_copy_paste: string | null;
  pix_qr_base64: string | null;
  checkout_url: string | null;
};

// Server only: the service-role key bypasses RLS and must never reach a browser.
function db() {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

function must<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}

export async function listProducts(): Promise<Product[]> {
  return must(await db().from("products").select("*").order("price_cents"));
}

export async function getProduct(id: string): Promise<Product | null> {
  return must(await db().from("products").select("*").eq("id", id).maybeSingle());
}

export async function createOrder(product: Product, email: string, method: PaymentMethod): Promise<Order> {
  return must(
    await db()
      .from("orders")
      .insert({ product_id: product.id, amount_cents: product.price_cents, customer_email: email, method })
      .select()
      .single(),
  );
}

export async function attachPayment(orderId: string, fields: Partial<Order>): Promise<void> {
  must(await db().from("orders").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", orderId));
}

export async function getOrder(id: string): Promise<Order | null> {
  return must(await db().from("orders").select("*").eq("id", id).maybeSingle());
}

// Records a provider event once and moves the order if the transition is
// allowed. Returns what happened, for the webhook's log line.
export async function applyEvent(args: {
  provider: "mercadopago" | "stripe";
  eventId: string;
  orderId: string;
  status: OrderStatus;
  payload: unknown;
}): Promise<"duplicate" | "unknown-order" | "ignored" | "applied"> {
  const client = db();
  const order = must(await client.from("orders").select("id,status").eq("id", args.orderId).maybeSingle()) as
    | Pick<Order, "id" | "status">
    | null;

  const inserted = await client.from("payment_events").insert({
    provider: args.provider,
    event_id: args.eventId,
    order_id: order ? order.id : null,
    status: args.status,
    payload: args.payload,
  });
  if (inserted.error?.code === "23505") return "duplicate";
  if (inserted.error) throw new Error(inserted.error.message);
  if (!order) return "unknown-order";

  const to = nextStatus(order.status, args.status);
  if (!to) return "ignored";
  // The status guard makes the update a compare-and-set, so two events
  // racing for the same order cannot both apply.
  must(
    await client
      .from("orders")
      .update({ status: to, updated_at: new Date().toISOString() })
      .eq("id", order.id)
      .eq("status", order.status),
  );
  return "applied";
}
