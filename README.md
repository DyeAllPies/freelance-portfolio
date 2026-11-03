# freelance-portfolio

Small, runnable projects built around the work that small businesses in Brazil
hire out most: automations, WhatsApp and AI bots, payment checkouts and website
fixes. Each folder is self-contained, starts with `docker compose up`, and has
its own README with what it does, how to run it and what it shows.

| # | Project | Stack |
|---|---|---|
| 02 | [PIX and Stripe checkout](02-pix-stripe-checkout/) | Next.js, Supabase, Mercado Pago PIX, Stripe Checkout |
| 03 | [WhatsApp AI support bot](03-whatsapp-ai-bot/) | Node.js, TypeScript, WhatsApp Cloud API, Claude API, PostgreSQL |
| 04 | [WordPress and WooCommerce: BR Checkout Essentials](04-wordpress-woocommerce/) | PHP, WordPress plugin, WooCommerce, PHPUnit, Docker |
| 05 | [Instagram mentions](05-instagram-mentions/) | Node.js, TypeScript, Instagram Graph API, webhooks, PostgreSQL |

## Ground rules

- Official APIs only. No scraping, and no unofficial WhatsApp libraries that
  break WhatsApp's terms.
- Every external service runs in sandbox or test mode. No real money moves.
- Secrets never enter the repository: they live in a local `.env` (with an
  `.env.example` beside it) or in the tool's own credential store.

## Author

Dennis Alves Pedersen ([DyeAllPies](https://github.com/DyeAllPies)).
