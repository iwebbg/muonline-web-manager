#!/bin/sh
# Fixed audited script. No user input is evaluated by this shell.
set -eu
umask 077
. /etc/os-release
[ "$ID" = ubuntu ]
[ "$VERSION_ID" = 24.04 ]
[ "$(cat /proc/1/comm)" = systemd ] || { echo 'Enable systemd in /etc/wsl.conf, terminate Ubuntu-24.04, then retry.' >&2; exit 1; }
apt-get update
apt-get install -y ca-certificates curl python3
install -m 0755 -d /etc/apt/keyrings
curl --fail --silent --show-error --location https://download.docker.com/linux/ubuntu/gpg --output /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
architecture=$(dpkg --print-architecture)
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n' "$architecture" > /etc/apt/sources.list.d/muonline-docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
# Runtime archives are private and Docker remains root controlled; no docker-group grant.
docker info >/dev/null
docker compose version
