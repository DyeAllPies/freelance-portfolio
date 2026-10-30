<?php
declare(strict_types=1);

namespace BRCE;

/**
 * A "BR Essentials" tab under WooCommerce > Settings, built on WooCommerce's
 * settings API, which handles the nonce, the capability check and saving.
 */
final class Settings
{
    public const TAB = 'brce';

    public static function cpfEnabled(): bool
    {
        return get_option('brce_cpf_enabled', 'yes') === 'yes';
    }

    public static function pixPercent(): float
    {
        return Discount::clampPercent((float) get_option('brce_pix_discount', '0'));
    }

    public static function pixGateway(): string
    {
        return (string) get_option('brce_pix_gateway', 'bacs');
    }

    public static function whatsappNumber(): string
    {
        return (string) get_option('brce_whatsapp_number', '');
    }

    public static function whatsappFloating(): bool
    {
        return get_option('brce_whatsapp_floating', 'no') === 'yes';
    }

    public function register(): void
    {
        add_filter('woocommerce_settings_tabs_array', [$this, 'addTab'], 50);
        add_action('woocommerce_settings_tabs_' . self::TAB, [$this, 'render']);
        add_action('woocommerce_update_options_' . self::TAB, [$this, 'save']);
    }

    /** @param array<string,string> $tabs */
    public function addTab(array $tabs): array
    {
        $tabs[self::TAB] = __('BR Essentials', 'br-checkout-essentials');
        return $tabs;
    }

    public function render(): void
    {
        woocommerce_admin_fields($this->fields());
    }

    public function save(): void
    {
        woocommerce_update_options($this->fields());
    }

    /** @return list<array<string,mixed>> */
    private function fields(): array
    {
        $gateways = [];
        foreach (WC()->payment_gateways()->payment_gateways() as $id => $gateway) {
            $gateways[$id] = $gateway->get_title() . " ({$id})";
        }

        return [
            ['type' => 'title', 'id' => 'brce_section', 'title' => __('BR Checkout Essentials', 'br-checkout-essentials')],
            [
                'id' => 'brce_cpf_enabled',
                'type' => 'checkbox',
                'title' => __('CPF no checkout', 'br-checkout-essentials'),
                'desc' => __('Pedir e validar o CPF do comprador', 'br-checkout-essentials'),
                'default' => 'yes',
            ],
            [
                'id' => 'brce_pix_discount',
                'type' => 'number',
                'title' => __('Desconto no PIX (%)', 'br-checkout-essentials'),
                'desc' => sprintf(__('0 desliga. Máximo de %s%%.', 'br-checkout-essentials'), Discount::MAX_PERCENT),
                'default' => '0',
                'custom_attributes' => ['min' => '0', 'max' => (string) Discount::MAX_PERCENT, 'step' => '0.5'],
            ],
            [
                'id' => 'brce_pix_gateway',
                'type' => 'select',
                'title' => __('Forma de pagamento PIX', 'br-checkout-essentials'),
                'desc' => __('O desconto vale quando o comprador escolhe esta forma de pagamento.', 'br-checkout-essentials'),
                'options' => $gateways,
                'default' => 'bacs',
            ],
            [
                'id' => 'brce_whatsapp_number',
                'type' => 'text',
                'title' => __('WhatsApp da loja', 'br-checkout-essentials'),
                'desc' => __('Com DDD, por exemplo (19) 99999-0000.', 'br-checkout-essentials'),
                'default' => '',
            ],
            [
                'id' => 'brce_whatsapp_floating',
                'type' => 'checkbox',
                'title' => __('Botão flutuante', 'br-checkout-essentials'),
                'desc' => __('Mostrar o botão de WhatsApp em todas as páginas', 'br-checkout-essentials'),
                'default' => 'no',
            ],
            ['type' => 'sectionend', 'id' => 'brce_section'],
        ];
    }
}
