import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "Loja Dev · checkout PIX e cartão" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <header>
          <a href="/">Loja Dev</a>
          <span className="badge">modo de teste</span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
