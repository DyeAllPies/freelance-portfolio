import { notFound } from "next/navigation";
import { getProduct } from "@/lib/db";
import { formatBRL } from "@/lib/orders";
import CheckoutForm from "./CheckoutForm";

export const dynamic = "force-dynamic";

export default async function Checkout({ params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;
  const product = /^[0-9a-f-]{36}$/i.test(productId) ? await getProduct(productId) : null;
  if (!product) notFound();
  return (
    <div className="card">
      <h1>{product.name}</h1>
      <p className="price">{formatBRL(product.price_cents)}</p>
      <CheckoutForm productId={product.id} />
    </div>
  );
}
