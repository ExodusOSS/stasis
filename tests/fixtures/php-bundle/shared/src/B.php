<?php

require_once __DIR__ . '/Shared.php';

class B
{
    public function bar(): int
    {
        return Shared::value() + 1;
    }
}
