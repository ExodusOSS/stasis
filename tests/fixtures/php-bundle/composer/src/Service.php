<?php

namespace App;

use App\Repo\UserRepo;
use Vendor\Acme\Client;
use Legacy\Thing;
// Imported but never referenced below -- PHP loads nothing for an unused
// `use`, so the bundle must not pull App\Unused\Ghost in either.
use App\Unused\Ghost;

class Service
{
    public function run(): string
    {
        $repo = new UserRepo();
        $client = new Client();

        // Helper is in the same namespace (App) and needs no `use` import.
        return Helper::greet() . $repo->find() . $client->ping() . Thing::tag();
    }
}
