<?php

require_once __DIR__ . '/Shared.php';

class A
{
    public function foo(): int
    {
        return Shared::value();
    }
}
