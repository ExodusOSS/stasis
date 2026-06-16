<?php

namespace App\Providers;

class BroadcastServiceProvider
{
    public function boot()
    {
        // Laravel path helpers resolve relative to the project root; the
        // framework require()s these files internally.
        require base_path('routes/channels.php');
        $config = require config_path('broadcasting.php');
    }
}
