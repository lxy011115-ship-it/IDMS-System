#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /srv/idms/app
export PATH=/srv/idms/node-v24.20.0-linux-x64/bin:/usr/sbin:/sbin:/usr/bin:/bin
test "$(id -u)" = 0
test -f .local/cloud-bootstrap-complete.json
test ! -e /etc/systemd/system/idms-pilot.service
if docker container inspect idms-keycloak >/dev/null 2>&1; then
  echo 'IDMS identity container already exists; inspect before resuming.' >&2; exit 1
fi
docker image inspect quay.io/keycloak/keycloak:26.8.1 >/dev/null
docker run -d --name idms-keycloak --restart unless-stopped \
  --label app=idms --network host --memory=576m --cpus=0.75 --pids-limit=128 \
  --env-file /srv/idms/private/keycloak.env quay.io/keycloak/keycloak:26.8.1 start
ready=false
for attempt in {1..300}; do
  if curl -fsS --max-time 3 http://127.0.0.1:8084/realms/master/.well-known/openid-configuration >/dev/null; then ready=true; break; fi
  sleep 2
done
$ready || { echo 'Keycloak startup not ready; inspect owned container.' >&2; exit 1; }
node deploy/configure-identity.mjs
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

