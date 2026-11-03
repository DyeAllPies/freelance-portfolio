import { NextResponse } from "next/server";
import { attachPayment, createOrder, getProduct, type Order, type Product } from "@/lib/db";
import { env } from "@/lib/env";
import { createPixPayment } from "@/lib/mercadopago";
import { createCheckoutSession, stripeClient } from "@/lib/stripe";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const method = body?.method;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || (method !== "pix" && method !== "card")) {
    return NextResponse.json({ error: "email e forma de pagamento são obrigatórios" }, { status: 400 });
  }
  const product = typeof body?.productId === "string" ? await getProduct(body.productId) : null;
  if (!product) return NextResponse.json({ error: "produto não encontrado" }, { status: 404 });

  // The price comes from the database, never from the request.
  const order = await createOrder(product, email, method);
  try {
    const redirect = await startPayment(order, product);
    return NextResponse.json({ orderId: order.id, redirect });
  } catch (err) {
    // The provider refused or was unreachable: close the order instead of
    // leaving a pending one with nothing to pay.
    console.error(`order ${order.id}: payment provider error`, err);
    await attachPayment(order.id, { status: "failed" });
    return NextResponse.json({ error: "o provedor de pagamento falhou; tente de novo" }, { status: 502 });
  }
}

// Opens the payment with the chosen provider and returns where to send the buyer.
async function startPayment(order: Order, product: Product): Promise<string> {
  const appUrl = env("APP_URL");

  if (order.method === "pix") {
    const pix = await createPixPayment({
      accessToken: env("MP_ACCESS_TOKEN"),
      orderId: order.id,
      amountCents: order.amount_cents,
      description: product.name,
      payerEmail: order.customer_email,
      notificationUrl: `${appUrl}/api/webhooks/mercadopago`,
      apiBase: process.env.MP_API_BASE || undefined,
    });
    await attachPayment(order.id, {
      provider_ref: pix.paymentId,
      pix_copy_paste: pix.copyPaste,
      pix_qr_base64: pix.qrBase64,
    });
    return `/orders/${order.id}`;
  }

  const session = await createCheckoutSession(stripeClient(env("STRIPE_SECRET_KEY"), process.env.STRIPE_API_BASE || undefined), {
    orderId: order.id,
    amountCents: order.amount_cents,
    productName: product.name,
    email: order.customer_email,
    appUrl,
  });
  await attachPayment(order.id, { provider_ref: session.sessionId, checkout_url: session.url });
  return session.url;
}
