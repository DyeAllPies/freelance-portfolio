"use client";

import { use, useEffect, useState } from "react";
import { formatBRL, type OrderStatus } from "@/lib/orders";

type View = {
  status: OrderStatus;
  method: "pix" | "card";
  amountCents: number;
  pixCopyPaste: string | null;
  pixQrBase64: string | null;
  checkoutUrl: string | null;
};

const labels: Record<OrderStatus, string> = {
  pending: "Aguardando pagamento",
  paid: "Pagamento confirmado",
  failed: "Pagamento recusado",
  expired: "Pedido expirado",
  refunded: "Pagamento estornado",
};

// Polls the order until a webhook settles it. The page never decides that a
// payment went through: only the verified webhook moves the status.
export default function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [order, setOrder] = useState<View | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let stop = false;
    async function load() {
      const res = await fetch(`/api/orders/${id}`, { cache: "no-store" });
      if (res.ok && !stop) {
        const next: View = await res.json();
        setOrder(next);
        if (next.status !== "pending") stop = true;
      }
      if (!stop) setTimeout(load, 3000);
    }
    load();
    return () => {
      stop = true;
    };
  }, [id]);

  if (!order) return <p className="muted">Carregando pedido...</p>;

  return (
    <div className="card">
      <h1>{labels[order.status]}</h1>
      <p className="price">{formatBRL(order.amountCents)}</p>
      {order.status === "pending" && order.method === "pix" && order.pixQrBase64 && (
        <>
          <p>Escaneie o QR code no app do seu banco ou use o PIX copia e cola. Ele vale 30 minutos.</p>
          <img alt="QR code PIX" width={240} height={240} src={`data:image/png;base64,${order.pixQrBase64}`} />
          <textarea readOnly rows={4} value={order.pixCopyPaste ?? ""} />
          <button
            onClick={() => {
              navigator.clipboard.writeText(order.pixCopyPaste ?? "");
              setCopied(true);
            }}
          >
            {copied ? "Copiado" : "Copiar código"}
          </button>
        </>
      )}
      {order.status === "pending" && order.method === "card" && order.checkoutUrl && (
        <a className="button" href={order.checkoutUrl}>
          Voltar ao pagamento
        </a>
      )}
      {order.status === "pending" && <p className="muted">Esta página atualiza sozinha.</p>}
    </div>
  );
}
