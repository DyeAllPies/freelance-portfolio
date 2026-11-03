"use client";

import { useState, type FormEvent } from "react";

export default function CheckoutForm({ productId }: { productId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, email: form.get("email"), method: form.get("method") }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.redirect) {
      setError(body.error ?? "Não foi possível criar o pedido. Tente de novo.");
      setBusy(false);
      return;
    }
    window.location.href = body.redirect;
  }

  return (
    <form onSubmit={submit}>
      <label htmlFor="email">Seu email</label>
      <input id="email" name="email" type="email" required />
      <fieldset>
        <legend>Forma de pagamento</legend>
        <label>
          <input type="radio" name="method" value="pix" defaultChecked /> PIX (Mercado Pago)
        </label>
        <label>
          <input type="radio" name="method" value="card" /> Cartão (Stripe)
        </label>
      </fieldset>
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={busy}>
        {busy ? "Criando pedido..." : "Pagar"}
      </button>
    </form>
  );
}
