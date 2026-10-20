#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /srv/idms/app
export PATH=/srv/idms/node-v24.20.0-linux-x64/bin:/usr/sbin:/sbin:/usr/bin:/bin
test "$(id -u)" = 0
test -f .local/cloud-bootstrap-complete.json
test ! -e /etc/systemd/system/idms-pilot.service
docker inspect --format '{{.Config.Labels.app}} {{.Image}} {{.HostConfig.NetworkMode}}' idms-keycloak | grep -qx 'idms sha256:817e41712252d6d3a2a61ac5d2a011be561d7942cee8227ee418ababa5f52b9a host'
docker inspect --format '{{.Name}} {{.Config.Labels.app}}' idms-postgres | grep -qx '/idms-postgres idms'
curl -fsS --max-time 10 http://127.0.0.1:8084/realms/master/.well-known/openid-configuration >/dev/null
if [ ! -f .local/identity-ready.json ]; then
  node deploy/configure-identity.mjs
fi

# Public package code is readable; private runtime/deployment files keep their own modes.
chmod -R a+rX node_modules
# The business process receives only runtime/session keys, never deployment passwords.
chgrp idms .local
chmod 750 .local
chgrp idms .local/postgres-business.json
chmod 640 .local/postgres-business.json
find .local/auth-session-stores -type d -exec chgrp idms {} + -exec chmod 750 {} +
find .local/auth-session-stores -type f \( -name runtime.json -o -name keys.json \) -exec chgrp idms {} + -exec chmod 640 {} +
chown idms:idms .demo-data
chmod 700 .demo-data
install -m 644 deploy/idms-pilot.service /etc/systemd/system/idms-pilot.service
systemctl daemon-reload
systemctl enable --now idms-pilot.service
ready=false
for attempt in {1..60}; do
  if curl -fsS --max-time 3 http://127.0.0.1:4011/api/v1/health >/dev/null; then ready=true; break; fi
  sleep 1
done
$ready || { echo 'IDMS startup not ready; inspect service journal.' >&2; exit 1; }
echo 'IDMS_INTERNAL_PILOT_READY; ICP_PENDING; NO_PUBLIC_PROXY_INSTALLED'

