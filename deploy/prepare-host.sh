#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /srv/idms/app
export PATH=/srv/idms/node-v24.20.0-linux-x64/bin:/usr/bin:/bin
test "$(id -u)" = 0
test -x /srv/idms/node-v24.20.0-linux-x64/bin/node
test ! -e /srv/idms/private/postgres.env
test ! -e /etc/systemd/system/idms-pilot.service
if docker container inspect idms-postgres >/dev/null 2>&1 || docker container inspect idms-keycloak >/dev/null 2>&1; then
  echo 'An IDMS container already exists; inspect before resuming.' >&2; exit 1
fi
if ss -lnt | grep -Eq ':(4011|8084|55434|9004)[[:space:]]'; then
  echo 'An IDMS target port is already in use.' >&2; exit 1
fi
if getent passwd idms >/dev/null; then echo 'Unexpected existing idms user; inspect first.' >&2; exit 1; fi
useradd --system --home-dir /srv/idms --no-create-home --shell /sbin/nologin idms
chmod 755 /srv/idms
chmod -R a+rX /srv/idms/app
install -d -m 700 /srv/idms/private
printf 'POSTGRES_USER=idms_bootstrap\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=postgres\n' "$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')" > /srv/idms/private/postgres.env
docker volume create idms-postgres-data >/dev/null
docker run -d --name idms-postgres --restart unless-stopped \
  --label app=idms --memory=192m --cpus=0.5 --pids-limit=100 --shm-size=32m \
  --publish 127.0.0.1:55434:5432 --env-file /srv/idms/private/postgres.env \
  --volume idms-postgres-data:/var/lib/postgresql/data public.ecr.aws/docker/library/postgres:16 \
  -c shared_buffers=32MB -c max_connections=40 -c work_mem=2MB -c maintenance_work_mem=16MB
ready=false
for attempt in {1..60}; do
  if docker exec idms-postgres pg_isready -U idms_bootstrap >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
$ready || { echo 'PostgreSQL startup not ready; inspect owned container.' >&2; exit 1; }
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
node deploy/bootstrap.mjs
docker run -d --name idms-keycloak --restart unless-stopped \
  --label app=idms --network host --memory=512m --cpus=0.75 --pids-limit=128 \
  --env-file /srv/idms/private/keycloak.env quay.io/keycloak/keycloak:26.8.1 start
ready=false
for attempt in {1..120}; do
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

