<?php

// An extensionless include that resolves to a directory rather than a file.
// The loader must skip it (EISDIR) instead of crashing.
require __DIR__ . '/lib';
