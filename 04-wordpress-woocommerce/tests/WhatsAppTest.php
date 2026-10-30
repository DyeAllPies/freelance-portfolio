<?php
declare(strict_types=1);

namespace BRCE\Tests;

use BRCE\WhatsApp;
use PHPUnit\Framework\TestCase;

final class WhatsAppTest extends TestCase
{
    public function testAddsBrazilsCountryCode(): void
    {
        self::assertSame('5519999990000', WhatsApp::normalize('(19) 99999-0000'));
        self::assertSame('551933330000', WhatsApp::normalize('19 3333-0000'));
    }

    public function testKeepsAnInternationalNumber(): void
    {
        self::assertSame('5519999990000', WhatsApp::normalize('+55 19 99999-0000'));
        self::assertSame('5519999990000', WhatsApp::normalize('0055 19 99999-0000'));
    }

    public function testRejectsWhatCannotBeAPhone(): void
    {
        self::assertSame('', WhatsApp::normalize(''));
        self::assertSame('', WhatsApp::normalize('99999-0000'));
        self::assertSame('', WhatsApp::link('abc', 'oi'));
    }

    public function testBuildsAClickToChatLinkWithTheMessageEncoded(): void
    {
        self::assertSame('https://wa.me/5519999990000', WhatsApp::link('(19) 99999-0000'));
        self::assertSame(
            'https://wa.me/5519999990000?text=Ol%C3%A1%21%20Pizza%20%26%20refri%3F',
            WhatsApp::link('(19) 99999-0000', 'Olá! Pizza & refri?')
        );
    }

    public function testNamesTheProductInTheMessage(): void
    {
        self::assertSame(
            "Olá! Tenho interesse no produto: Caneca Dev\nhttps://loja.example/caneca",
            WhatsApp::productMessage('Caneca Dev', 'https://loja.example/caneca')
        );
    }
}
