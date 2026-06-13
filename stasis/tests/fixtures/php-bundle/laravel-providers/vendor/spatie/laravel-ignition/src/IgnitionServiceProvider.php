<?php

namespace Spatie\LaravelIgnition;

class IgnitionServiceProvider
{
    public function boot(): void
    {
        $this->publishes([
            __DIR__ . '/../config/ignition.php' => config_path('ignition.php'),
            __DIR__ . '/../config/flare.php' => config_path('flare.php'),
        ]);
    }
}
