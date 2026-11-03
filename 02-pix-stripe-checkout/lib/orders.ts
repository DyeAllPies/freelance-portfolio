export type OrderStatus = "pending" | "paid" | "failed" | "expired" | "refunded";
export type PaymentMethod = "pix" | "card";

// Which status an order may move to from where it is. Providers deliver
// webhooks out of order and more than once, so a late "pending" or a
// "failed" after "paid" must not undo a payment.
const allowed: Record<OrderStatus, OrderStatus[]> = {
  pending: ["paid", "failed", "expired"],
  paid: ["refunded"],
  // A rejected Mercado Pago payment or a failed Checkout Session is final;
  // the customer retries with a new order.
  failed: [],
  expired: [],
  refunded: [],
};

export function nextStatus(current: OrderStatus, incoming: OrderStatus): OrderStatus | null {
  return allowed[current].includes(incoming) ? incoming : null;
}

export function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
