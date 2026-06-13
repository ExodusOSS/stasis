#!/usr/bin/env bash
_self="${BASH_SOURCE[0]}"
LIB_DIR="$(cd "$(dirname "$_self")/../lib" && pwd)"

# shellcheck source=../lib/config.sh
source "${LIB_DIR}/config.sh"
