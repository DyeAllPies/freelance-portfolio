<?php
declare(strict_types=1);

namespace BRCE\Tests;

use BRCE\Cpf;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class CpfTest extends TestCase
{
    /** @return array<string,array{string}> */
    public static function valid(): array
    {
        // Generated test numbers, not real people.
        return [
            'masked' => ['529.982.247-25'],
            'digits only' => ['52998224725'],
            'with spaces' => [' 529 982 247 25 '],
            'another number' => ['111.444.777-35'],
            'leading zero, first check digit 0' => ['039.053.344-02'],
        ];
    }

    /** @return array<string,array{string}> */
    public static function invalid(): array
    {
        return [
            'wrong first check digit' => ['529.982.247-35'],
            'wrong second check digit' => ['529.982.247-26'],
            'repeated digits' => ['111.111.111-11'],
            'all zeros' => ['000.000.000-00'],
            'too short' => ['529.982.247-2'],
            'too long' => ['529.982.247-255'],
            'empty' => [''],
            'letters' => ['abc.def.ghi-jk'],
        ];
    }

    #[DataProvider('valid')]
    public function testAcceptsValidCpf(string $cpf): void
    {
        self::assertTrue(Cpf::isValid($cpf));
    }

    #[DataProvider('invalid')]
    public function testRejectsInvalidCpf(string $cpf): void
    {
        self::assertFalse(Cpf::isValid($cpf));
    }

    public function testFormatsElevenDigits(): void
    {
        self::assertSame('529.982.247-25', Cpf::format('52998224725'));
        self::assertSame('529.982.247-25', Cpf::format('529.982.247-25'));
    }

    public function testLeavesOtherInputAlone(): void
    {
        self::assertSame('123', Cpf::format('123'));
    }
}
