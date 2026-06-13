<?php

require __DIR__ . '/vendor/autoload.php';

use App\Service;

$service = new Service();
echo $service->run();
