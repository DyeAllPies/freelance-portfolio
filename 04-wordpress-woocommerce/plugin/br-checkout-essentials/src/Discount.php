<?php
declare(strict_types=1);

namespace BRCE;

final class Discount
{
    /** A typo in the settings (500 instead of 5.00) must not give the store away. */
    public const MAX_PERCENT = 50.0;

    public static function clampPercent(float $percent): float
    {
        return max(0.0, min(self::MAX_PERCENT, $percent));
    }

    /**
     * The discount in reais for a cart subtotal, rounded to centavos.
     * Shipping is not discounted: the subtotal passed in excludes it.
     */
    public static function amount(float $subtotal, float $percent): float
    {
        if ($subtotal <= 0) {
            return 0.0;
        }
        return round($subtotal * self::clampPercent($percent) / 100, 2);
    }
}
