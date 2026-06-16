<?php

namespace App;

// In the PSR-4 tree (App\ -> src/) AND listed in autoload_classmap.php, but
// referenced by nothing -- must NOT be bundled. The autoload maps are consulted
// to resolve referenced names, never enumerated to pull in every listed class.
class Orphan
{
    public static function nope(): string
    {
        return 'nope';
    }
}
