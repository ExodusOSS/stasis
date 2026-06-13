<?php

require_once __DIR__ . '/B.php';

class A
{
    public function foo(): int
    {
        return B::bar();
    }
}
