import { NextResponse } from "next/server";
import { applyEvent } from "@/lib/db";
import { env } from "@/lib/env";
import { mapStripeEvent, stripeClient } from "@/lib/stripe";

export async function POST(req: Request) {
  // The signature covers the raw bytes, so read the body as text, not JSON.
  const raw = await req.text();
  const stripe = stripeClient(env("STRIPE_SECRET_KEY"));
  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, req.headers.get("stripe-signature") ?? "", env("STRIPE_WEBHOOK_SECRET"));
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  const update = mapStripeEvent(event);
  if (!update) return new NextResponse(null, { status: 200 });
  const result = await applyEvent({ provider: "stripe", ...update, payload: event });
  console.log(`stripe ${event.type} ${event.id}: ${result}`);
  return new NextResponse(null, { status: 200 });
}
