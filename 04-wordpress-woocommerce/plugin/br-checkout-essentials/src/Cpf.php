<?php
declare(strict_types=1);

namespace BRCE;

/**
 * CPF, the Brazilian individual taxpayer number: 11 digits, the last two
 * of which are check digits over the first nine and ten.
 */
final class Cpf
{
    public static function digits(string $value): string
    {
        return preg_replace('/\D/', '', $value) ?? '';
    }

    public static function isValid(string $value): bool
    {
        $d = self::digits($value);
        // Repeated digits (000.000.000-00 and so on) pass the arithmetic but are not issued.
        if (strlen($d) !== 11 || preg_match('/^(\d)\1{10}$/', $d)) {
            return false;
        }
        for ($pos = 9; $pos <= 10; $pos++) {
            $sum = 0;
            for ($i = 0; $i < $pos; $i++) {
                $sum += (int) $d[$i] * ($pos + 1 - $i);
            }
            if ((int) $d[$pos] !== ($sum * 10) % 11 % 10) {
                return false;
            }
        }
        return true;
    }

    /** 52998224725 becomes 529.982.247-25; anything else is returned as given. */
    public static function format(string $value): string
    {
        $d = self::digits($value);
        if (strlen($d) !== 11) {
            return $value;
        }
        return sprintf('%s.%s.%s-%s', substr($d, 0, 3), substr($d, 3, 3), substr($d, 6, 3), substr($d, 9, 2));
    }
}
