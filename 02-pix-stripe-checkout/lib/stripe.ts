import Stripe from "stripe";
import type { OrderStatus } from "./orders";

export function stripeClient(secretKey: string, apiBase?: string) {
  if (!apiBase) return new Stripe(secretKey);
  let u: URL;
  try {
    u = new URL(apiBase);
  } catch {
    throw new Error(`STRIPE_API_BASE is not a valid URL: ${apiBase}`);
  }
  const https = u.protocol === "https:";
  return new Stripe(secretKey, {
    host: u.hostname,
    port: u.port || (https ? "443" : "80"),
    protocol: https ? "https" : "http",
  });
}

// A hosted Checkout page for one product. The order id rides on the session
// and on its PaymentIntent, so both checkout and refund events find the order.
export async function createCheckoutSession(
  stripe: Stripe,
  args: { orderId: string; amountCents: number; productName: string; email: string; appUrl: string },
) {
  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      customer_email: args.email,
      client_reference_id: args.orderId,
      metadata: { order_id: args.orderId },
      payment_intent_data: { metadata: { order_id: args.orderId } },
      line_items: [
        {
          quantity: 1,
          price_data: { currency: "brl", unit_amount: args.amountCents, product_data: { name: args.productName } },
        },
      ],
      success_url: `${args.appUrl}/orders/${args.orderId}`,
      cancel_url: `${args.appUrl}/orders/${args.orderId}`,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    },
    { idempotencyKey: `checkout-${args.orderId}` },
  );
  return { sessionId: session.id, url: session.url ?? "" };
}

export type OrderUpdate = { eventId: string; orderId: string; status: OrderStatus };

// Turns a verified Stripe event into an order update, or null for events
// this shop does not act on.
export function mapStripeEvent(event: Stripe.Event): OrderUpdate | null {
  const update = (orderId: string | undefined | null, status: OrderStatus) =>
    orderId ? { eventId: event.id, orderId, status } : null;

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const s = event.data.object;
      // Delayed methods (boleto) complete the session unpaid and settle later.
      return s.payment_status === "paid" ? update(s.metadata?.order_id, "paid") : null;
    }
    case "checkout.session.async_payment_failed":
      return update(event.data.object.metadata?.order_id, "failed");
    case "checkout.session.expired":
      return update(event.data.object.metadata?.order_id, "expired");
    case "charge.refunded": {
      const c = event.data.object;
      return c.refunded ? update(c.metadata?.order_id, "refunded") : null;
    }
    default:
      return null;
  }
}
