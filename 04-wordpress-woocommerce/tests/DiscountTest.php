<?php
declare(strict_types=1);

namespace BRCE\Tests;

use BRCE\Discount;
use PHPUnit\Framework\TestCase;

final class DiscountTest extends TestCase
{
    public function testTakesThePercentOfTheSubtotal(): void
    {
        self::assertSame(5.0, Discount::amount(100.0, 5));
        self::assertSame(12.45, Discount::amount(249.0, 5));
    }

    public function testRoundsToCentavos(): void
    {
        // 59.90 * 7.5% = 4.4925
        self::assertSame(4.49, Discount::amount(59.90, 7.5));
    }

    public function testCapsATypoedPercent(): void
    {
        self::assertSame(50.0, Discount::amount(100.0, 500));
        self::assertSame(50.0, Discount::clampPercent(500));
    }

    public function testNeverAddsMoney(): void
    {
        self::assertSame(0.0, Discount::amount(100.0, -10));
        self::assertSame(0.0, Discount::amount(0.0, 10));
        self::assertSame(0.0, Discount::amount(-20.0, 10));
    }
}
