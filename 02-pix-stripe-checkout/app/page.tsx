import { listProducts } from "@/lib/db";
import { formatBRL } from "@/lib/orders";

export const dynamic = "force-dynamic";

export default async function Home() {
  const products = await listProducts();
  return (
    <>
      <h1>Produtos</h1>
      <div className="grid">
        {products.map((p) => (
          <div className="card" key={p.id}>
            <h3>{p.name}</h3>
            <p className="muted">{p.description}</p>
            <p className="price">{formatBRL(p.price_cents)}</p>
            <a className="button" href={`/checkout/${p.id}`}>
              Comprar
            </a>
          </div>
        ))}
      </div>
    </>
  );
}
