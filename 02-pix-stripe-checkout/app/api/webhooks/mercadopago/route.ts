import { NextResponse } from "next/server";
import { applyEvent } from "@/lib/db";
import { env } from "@/lib/env";
import { getPayment, mapPaymentStatus, verifyWebhookSignature } from "@/lib/mercadopago";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const body = await req.json().catch(() => ({}));
  if ((url.searchParams.get("type") ?? body?.type) !== "payment") return new NextResponse(null, { status: 200 });

  const dataId = url.searchParams.get("data.id") ?? String(body?.data?.id ?? "");
  const ok = verifyWebhookSignature({
    xSignature: req.headers.get("x-signature"),
    xRequestId: req.headers.get("x-request-id"),
    dataId,
    secret: env("MP_WEBHOOK_SECRET"),
  });
  if (!ok) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  const payment = await getPayment(env("MP_ACCESS_TOKEN"), dataId, process.env.MP_API_BASE || undefined);
  const status = mapPaymentStatus(payment.status);
  if (!status || !payment.orderId) return new NextResponse(null, { status: 200 });

  // One payment can notify several times on its way to approved, so the
  // event id carries the status it reports.
  const result = await applyEvent({
    provider: "mercadopago",
    eventId: `${dataId}:${payment.status}`,
    orderId: payment.orderId,
    status,
    payload: { notification: body, payment },
  });
  console.log(`mercadopago payment ${dataId} ${payment.status}: ${result}`);
  return new NextResponse(null, { status: 200 });
}
