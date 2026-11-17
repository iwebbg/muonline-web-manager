#!/bin/sh
# Trusted bootstrap only: no request data or credentials are interpreted by this shell.
set -eu
. /etc/os-release
[ "$ID" = ubuntu ]
[ "$VERSION_ID" = 24.04 ]
if ! command -v python3 >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y python3
fi
