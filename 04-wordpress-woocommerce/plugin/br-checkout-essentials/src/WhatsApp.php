<?php
declare(strict_types=1);

namespace BRCE;

final class WhatsApp
{
    /**
     * Normalizes a Brazilian number to the international digits wa.me wants:
     * "(19) 99999-0000" becomes 5519999990000. Returns '' when it cannot be a phone number.
     */
    public static function normalize(string $phone): string
    {
        $d = preg_replace('/\D/', '', $phone) ?? '';
        $d = ltrim($d, '0');
        // DDD + number, 10 or 11 digits, gets Brazil's country code.
        if (strlen($d) === 10 || strlen($d) === 11) {
            $d = '55' . $d;
        }
        return (strlen($d) >= 12 && strlen($d) <= 15) ? $d : '';
    }

    /** A click-to-chat link with the message already typed in. */
    public static function link(string $phone, string $message = ''): string
    {
        $number = self::normalize($phone);
        if ($number === '') {
            return '';
        }
        $url = 'https://wa.me/' . $number;
        return $message === '' ? $url : $url . '?text=' . rawurlencode($message);
    }

    public static function productMessage(string $productName, string $productUrl): string
    {
        return sprintf("Olá! Tenho interesse no produto: %s\n%s", $productName, $productUrl);
    }
}
