<?php
declare(strict_types=1);

namespace BRCE;

/**
 * Wires the three features into WordPress and WooCommerce. The rules live in
 * Cpf, Discount and WhatsApp, which have no WordPress dependency and are
 * unit-tested on their own.
 *
 * Both checkouts are covered: the classic (shortcode) one through its form
 * hooks, and the block one through the Additional Checkout Fields API and
 * the Store API.
 */
final class Plugin
{
    public const CPF_META = '_billing_cpf';
    public const BLOCK_CPF_FIELD = 'brce/cpf';
    public const BLOCK_UPDATE_NAMESPACE = 'brce-payment-method';

    public function register(): void
    {
        (new Settings())->register();

        if (Settings::cpfEnabled()) {
            add_filter('woocommerce_billing_fields', [$this, 'addCpfField']);
            add_action('woocommerce_after_checkout_validation', [$this, 'validateCpf'], 10, 2);
            add_action('woocommerce_checkout_create_order', [$this, 'saveCpf'], 10, 2);
            add_action('woocommerce_admin_order_data_after_billing_address', [$this, 'showCpfInAdmin']);
            add_filter('woocommerce_email_order_meta_fields', [$this, 'addCpfToEmails'], 10, 3);
            add_action('woocommerce_init', [$this, 'registerBlockCpfField']);
            add_action('woocommerce_set_additional_field_value', [$this, 'saveBlockCpf'], 10, 4);
        }

        add_action('woocommerce_cart_calculate_fees', [$this, 'applyPixDiscount']);
        add_action('woocommerce_init', [$this, 'registerPaymentMethodUpdate']);
        add_action('woocommerce_store_api_checkout_update_order_from_request', [$this, 'syncPixDiscountOnOrder']);
        add_shortcode('br_whatsapp', [$this, 'whatsappShortcode']);
        add_action('wp_footer', [$this, 'floatingWhatsapp']);
        add_action('wp_enqueue_scripts', [$this, 'enqueue']);
    }

    /** @param array<string,array<string,mixed>> $fields */
    public function addCpfField(array $fields): array
    {
        $fields['billing_cpf'] = [
            'label' => __('CPF', 'br-checkout-essentials'),
            'required' => true,
            'class' => ['form-row-wide'],
            'priority' => 25,
            'custom_attributes' => ['inputmode' => 'numeric', 'maxlength' => '14', 'autocomplete' => 'off'],
        ];
        return $fields;
    }

    /** @param array<string,mixed> $data */
    public function validateCpf(array $data, \WP_Error $errors): void
    {
        $cpf = (string) ($data['billing_cpf'] ?? '');
        // An empty field is already reported by WooCommerce as a required field.
        if ($cpf !== '' && !Cpf::isValid($cpf)) {
            $errors->add('validation', __('O CPF informado não é válido.', 'br-checkout-essentials'));
        }
    }

    /**
     * The block checkout's CPF. WooCommerce renders it, marks it required,
     * shows it on the admin order and in emails, and stores it under its own
     * meta key; saveBlockCpf copies it to CPF_META as well.
     */
    public function registerBlockCpfField(): void
    {
        if (!function_exists('woocommerce_register_additional_checkout_field')) {
            return;
        }
        woocommerce_register_additional_checkout_field([
            'id' => self::BLOCK_CPF_FIELD,
            'label' => __('CPF', 'br-checkout-essentials'),
            'location' => 'contact',
            'type' => 'text',
            'required' => true,
            'attributes' => ['autocomplete' => 'off', 'maxLength' => 14],
            'sanitize_callback' => static fn ($value): string => Cpf::format(trim((string) $value)),
            'validate_callback' => static function ($value) {
                if (!Cpf::isValid((string) $value)) {
                    return new \WP_Error('brce_invalid_cpf', __('O CPF informado não é válido.', 'br-checkout-essentials'));
                }
                return true;
            },
        ]);
    }

    /** @param mixed $value */
    public function saveBlockCpf(string $key, $value, string $group, \WC_Data $object): void
    {
        if ($key === self::BLOCK_CPF_FIELD && $object instanceof \WC_Order && (string) $value !== '') {
            $object->update_meta_data(self::CPF_META, Cpf::format((string) $value));
        }
    }

    /** @param array<string,mixed> $data */
    public function saveCpf(\WC_Order $order, array $data): void
    {
        if (!empty($data['billing_cpf'])) {
            $order->update_meta_data(self::CPF_META, Cpf::format((string) $data['billing_cpf']));
        }
    }

    public function showCpfInAdmin(\WC_Order $order): void
    {
        // WooCommerce already shows a block checkout order's CPF with its other fields.
        if ($this->hasBlockCpf($order)) {
            return;
        }
        $cpf = (string) $order->get_meta(self::CPF_META);
        if ($cpf !== '') {
            printf('<p><strong>%s:</strong> %s</p>', esc_html__('CPF', 'br-checkout-essentials'), esc_html($cpf));
        }
    }

    /**
     * @param array<string,array<string,string>> $fields
     * @return array<string,array<string,string>>
     */
    public function addCpfToEmails(array $fields, bool $sentToAdmin, \WC_Order $order): array
    {
        $cpf = (string) $order->get_meta(self::CPF_META);
        if ($cpf !== '' && !$this->hasBlockCpf($order)) {
            $fields['brce_cpf'] = ['label' => __('CPF', 'br-checkout-essentials'), 'value' => $cpf];
        }
        return $fields;
    }

    /**
     * Adds a negative fee when the buyer has picked the PIX gateway. WooCommerce
     * recalculates fees on every checkout refresh, and checkout.js triggers one
     * when the payment method changes. Before the buyer has chosen, it counts
     * the first available method, which the block checkout selects by default.
     */
    public function applyPixDiscount(\WC_Cart $cart): void
    {
        if (is_admin() && !wp_doing_ajax()) {
            return;
        }
        $percent = Settings::pixPercent();
        $chosen = WC()->session ? (string) WC()->session->get('chosen_payment_method') : '';
        if ($chosen === '' && WC()->payment_gateways()) {
            $chosen = (string) array_key_first(WC()->payment_gateways()->get_available_payment_gateways());
        }
        if ($percent <= 0 || $chosen !== Settings::pixGateway()) {
            return;
        }
        $amount = Discount::amount((float) $cart->get_subtotal(), $percent);
        if ($amount > 0) {
            $cart->add_fee($this->pixLabel(), -$amount, false);
        }
    }

    /**
     * The block checkout keeps the chosen payment method in the browser, so
     * checkout-blocks.js sends each change here; storing it in the session
     * lets applyPixDiscount add or drop the discount on the returned totals.
     */
    public function registerPaymentMethodUpdate(): void
    {
        if (!function_exists('woocommerce_store_api_register_update_callback')) {
            return;
        }
        woocommerce_store_api_register_update_callback([
            'namespace' => self::BLOCK_UPDATE_NAMESPACE,
            'callback' => static function (array $data): void {
                if (WC()->session) {
                    WC()->session->set('chosen_payment_method', sanitize_key((string) ($data['payment_method'] ?? '')));
                }
            },
        ]);
    }

    /**
     * A block checkout order takes its fees from the cart, which follows what
     * the browser last reported. The order's own payment method decides: the
     * discount is redone from it, so a buyer who reports PIX and pays another
     * way does not keep the discount.
     */
    public function syncPixDiscountOnOrder(\WC_Order $order): void
    {
        $label = $this->pixLabel();
        foreach ($order->get_fees() as $id => $fee) {
            if ($fee->get_name() === $label) {
                $order->remove_item($id);
            }
        }
        $percent = Settings::pixPercent();
        if ($percent > 0 && $order->get_payment_method() === Settings::pixGateway()) {
            $amount = Discount::amount((float) $order->get_subtotal(), $percent);
            if ($amount > 0) {
                $fee = new \WC_Order_Item_Fee();
                $fee->set_name($label);
                $fee->set_amount((string) -$amount);
                $fee->set_total((string) -$amount);
                $fee->set_tax_status('none');
                $order->add_item($fee);
            }
        }
        $order->calculate_totals(false);
    }

    /** @param array<string,string>|string $atts */
    public function whatsappShortcode($atts): string
    {
        $atts = shortcode_atts(['texto' => __('Fale conosco no WhatsApp', 'br-checkout-essentials'), 'mensagem' => ''], (array) $atts);
        $link = WhatsApp::link(Settings::whatsappNumber(), $atts['mensagem'] !== '' ? $atts['mensagem'] : $this->pageMessage());
        if ($link === '') {
            return '';
        }
        return sprintf(
            '<a class="brce-whatsapp-link" href="%s" target="_blank" rel="noopener">%s</a>',
            esc_url($link),
            esc_html($atts['texto'])
        );
    }

    public function floatingWhatsapp(): void
    {
        if (!Settings::whatsappFloating() || is_admin()) {
            return;
        }
        $link = WhatsApp::link(Settings::whatsappNumber(), $this->pageMessage());
        if ($link === '') {
            return;
        }
        printf(
            '<a class="brce-whatsapp-float" href="%s" target="_blank" rel="noopener" aria-label="%s"><svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.7a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .1-1.3c0-.1-.2-.2-.4-.3Z"/></svg></a>',
            esc_url($link),
            esc_attr__('Fale conosco no WhatsApp', 'br-checkout-essentials')
        );
    }

    public function enqueue(): void
    {
        $base = plugin_dir_url(BRCE_FILE) . 'assets/';
        wp_enqueue_style('brce', $base . 'brce.css', [], BRCE_VERSION);
        if (!function_exists('is_checkout') || !is_checkout()) {
            return;
        }
        if (has_block('woocommerce/checkout')) {
            wp_enqueue_script('brce-checkout-blocks', $base . 'checkout-blocks.js', ['wp-data', 'wc-blocks-checkout'], BRCE_VERSION, true);
            wp_add_inline_script(
                'brce-checkout-blocks',
                'var brceBlocks = ' . wp_json_encode(['pixGateway' => Settings::pixGateway(), 'pixLabel' => $this->pixLabel()]) . ';',
                'before'
            );
        } else {
            wp_enqueue_script('brce-checkout', $base . 'checkout.js', ['jquery', 'wc-checkout'], BRCE_VERSION, true);
        }
    }

    private function pixLabel(): string
    {
        return sprintf(__('Desconto PIX (%s%%)', 'br-checkout-essentials'), wc_format_localized_decimal(Settings::pixPercent()));
    }

    /** True for an order placed through the block checkout's CPF field. */
    private function hasBlockCpf(\WC_Order $order): bool
    {
        return $order->get_meta('_wc_other/' . self::BLOCK_CPF_FIELD) !== '';
    }

    /** On a product page the message names the product; elsewhere it is a plain greeting. */
    private function pageMessage(): string
    {
        if (function_exists('is_product') && is_product()) {
            $product = wc_get_product(get_the_ID());
            if ($product) {
                return WhatsApp::productMessage($product->get_name(), (string) get_permalink($product->get_id()));
            }
        }
        return __('Olá! Vim pelo site da loja.', 'br-checkout-essentials');
    }
}
