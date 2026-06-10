<?php

// Static include -> bundled.
require __DIR__ . '/bootstrap.php';

// Dynamic include: the file name comes from a variable, so the exact target is
// only known at runtime. Its static directory prefix is modules/, so every
// modules/*.php is bundled as a candidate (non-.php files are not).
$name = $_GET['mod'] ?? 'default';
$mod = require __DIR__ . '/modules/' . $name . '.php';
