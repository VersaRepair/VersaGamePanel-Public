#!/bin/sh
set -eu
umask 077
if [ "$(id -u)" = 0 ]; then
  socket_gid=$(node /app/deploy/container/initialize.js)
  exec setpriv --reuid=1000 --regid=1000 --groups="1000,$socket_gid" --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all node /app/deploy/container/bootstrap.js "$@"
fi
exec node /app/deploy/container/bootstrap.js "$@"
