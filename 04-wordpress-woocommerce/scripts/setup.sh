#!/bin/sh
# Builds a demo shop: WordPress, WooCommerce, this plugin, three products, a
# block or classic checkout page (CHECKOUT, block by default), bank transfer
# relabelled as PIX with 5% off, and a WhatsApp button. Safe to run again.
set -eu
cd /var/www/html

# The wordpress container copies WordPress into the volume on first start.
i=0
until [ -f wp-includes/version.php ] && wp db check >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "WordPress did not come up" >&2; exit 1; }
  sleep 2
done

if ! wp core is-installed 2>/dev/null; then
  wp core install --url=http://localhost:8080 --title="Loja Dev" \
    --admin_user=admin --admin_password=admin --admin_email=admin@example.com --skip-email
fi
wp language core install pt_BR --activate >/dev/null 2>&1 || true

wp plugin is-installed woocommerce || wp plugin install woocommerce
wp plugin activate woocommerce br-checkout-essentials

wp option update woocommerce_currency BRL
wp option update woocommerce_default_country "BR:SP"
wp option update woocommerce_price_decimal_sep ","
wp option update woocommerce_price_thousand_sep "."
wp option update woocommerce_coming_soon no
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json

# Bank transfer stands in for a PIX gateway in the demo.
wp option update woocommerce_bacs_settings '{"enabled":"yes","title":"PIX","description":"Pague com PIX e ganhe desconto.","instructions":"","account_details":""}' --format=json
wp option update woocommerce_cod_settings '{"enabled":"yes","title":"Pagamento na entrega","description":"","instructions":"","enable_for_methods":"","enable_for_virtual":"yes"}' --format=json

wp option update brce_cpf_enabled yes
wp option update brce_pix_discount 5
wp option update brce_pix_gateway bacs
wp option update brce_whatsapp_number "(19) 99999-0000"
wp option update brce_whatsapp_floating yes

if [ "$(wp wc product list --user=admin --format=count)" = "0" ]; then
  wp wc product create --user=admin --name="Caneca Dev" --regular_price=49.90 --virtual=true >/dev/null
  wp wc product create --user=admin --name="Camiseta Hello World" --regular_price=79.90 --virtual=true >/dev/null
  wp wc product create --user=admin --name="Kit de adesivos" --regular_price=19.90 --virtual=true >/dev/null
fi

# The plugin covers both checkouts; CHECKOUT picks which one the demo shows.
if [ "${CHECKOUT:-block}" = "classic" ]; then
  checkout_id=$(wp option get woocommerce_checkout_page_id)
  wp post update "$checkout_id" --post_content='<!-- wp:shortcode -->[woocommerce_checkout]<!-- /wp:shortcode -->' >/dev/null
  cart_id=$(wp option get woocommerce_cart_page_id)
  wp post update "$cart_id" --post_content='<!-- wp:shortcode -->[woocommerce_cart]<!-- /wp:shortcode -->' >/dev/null
else
  # Back from classic: WooCommerce recreates the pages with its default blocks.
  for page in checkout cart; do
    id=$(wp option get "woocommerce_${page}_page_id")
    if wp post get "$id" --field=post_content | grep -q '\[woocommerce_'; then
      wp post delete "$id" --force >/dev/null
      wp option delete "woocommerce_${page}_page_id" >/dev/null
    fi
  done
  wp wc tool run install_pages --user=admin >/dev/null
fi

wp rewrite structure '/%postname%/' --hard >/dev/null
echo "Shop ready at http://localhost:8080 (admin / admin)"
