import { NextResponse } from "next/server";
import { getOrder } from "@/lib/db";

// What the order page polls. Only the fields the buyer needs: no provider ids.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "pedido inválido" }, { status: 400 });
  const order = await getOrder(id);
  if (!order) return NextResponse.json({ error: "pedido não encontrado" }, { status: 404 });
  return NextResponse.json({
    status: order.status,
    method: order.method,
    amountCents: order.amount_cents,
    pixCopyPaste: order.status === "pending" ? order.pix_copy_paste : null,
    pixQrBase64: order.status === "pending" ? order.pix_qr_base64 : null,
    checkoutUrl: order.status === "pending" ? order.checkout_url : null,
  });
}
