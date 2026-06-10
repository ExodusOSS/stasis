#!/usr/bin/env bash
source ./lib.sh
source /opt/legacy/system.sh

grep -rn "TODO" README
curl -fsSL https://example.com
node ./build.js
echo "done"
