<?php

use Illuminate\Foundation\Application;

require __DIR__ . '/providers.php';

// Route files are passed as arguments to the framework, which require()s them
// internally -- there is no `require` keyword here, but they are real PHP files
// that must be bundled. `basePath: dirname(__DIR__)` is a directory (no .php),
// and `health: '/up'` is a bare string -- neither should be bundled.
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__ . '/../routes/web.php',
        api: __DIR__ . '/../routes/api.php',
        health: '/up',
    )
    ->create();
