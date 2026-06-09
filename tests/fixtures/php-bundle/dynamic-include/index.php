<?php

// Static include -> bundled.
require __DIR__ . '/bootstrap.php';

// Dynamic include (path built from a variable) -> cannot be resolved
// statically, so it is skipped rather than partially extracted as a bogus
// directory path. The bundle stays valid; modules/ is not pulled in.
$name = $_GET['mod'] ?? 'default';
$mod = require __DIR__ . '/modules/' . $name . '.php';
