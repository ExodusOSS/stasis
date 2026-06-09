<?php

namespace App\Unused;

// Resolvable via PSR-4 (App\ -> src/), but only ever `use`-imported, never
// referenced -- so it must NOT end up in the bundle.
class Ghost
{
    public static function boo(): string
    {
        return 'boo';
    }
}
