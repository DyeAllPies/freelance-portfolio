<?php
/**
 * Plugin Name:       BR Checkout Essentials
 * Description:       CPF no checkout, desconto para pagamento via PIX e botão de WhatsApp para lojas WooCommerce no Brasil.
 * Version:           1.0.0
 * Requires at least: 6.4
 * Requires PHP:      8.1
 * Requires Plugins:  woocommerce
 * Author:            Dennis Alves Pedersen
 * License:           MIT
 * Text Domain:       br-checkout-essentials
 */

declare(strict_types=1);

defined('ABSPATH') || exit;

define('BRCE_FILE', __FILE__);
define('BRCE_VERSION', '1.0.0');

require_once __DIR__ . '/src/Cpf.php';
require_once __DIR__ . '/src/Discount.php';
require_once __DIR__ . '/src/WhatsApp.php';
require_once __DIR__ . '/src/Settings.php';
require_once __DIR__ . '/src/Plugin.php';

// Declares that the plugin reads orders only through the WC_Order API, so it
// works with WooCommerce's custom order tables (HPOS).
add_action('before_woocommerce_init', static function (): void {
    if (class_exists(\Automattic\WooCommerce\Utilities\FeaturesUtil::class)) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', BRCE_FILE, true);
    }
});

add_action('plugins_loaded', static function (): void {
    if (!class_exists('WooCommerce')) {
        return;
    }
    (new \BRCE\Plugin())->register();
});
