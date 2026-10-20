#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /srv/idms/app
export PATH=/srv/idms/node-v24.20.0-linux-x64/bin:/usr/sbin:/sbin:/usr/bin:/bin
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
# Public dependency code must be readable by the separate service user.
chmod -R a+rX node_modules
node deploy/bootstrap.mjs
if [ "${IDMS_PREPARE_PHASE:-all}" = database ]; then
  echo 'IDMS_DATABASE_PREPARED; finish-host.sh remains pending'
  exit 0
fi
exec bash deploy/finish-host.sh
