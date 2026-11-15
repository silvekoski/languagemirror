#!/usr/bin/env bash
# Deploy Language Mirror to the Hostinger VPS at https://languagemirror.bobs.build/
#   wikipediathroughtime/deploy/hostinger/deploy.sh [lens.sql]
# With a SQL file (mariadb-dump --dump-history of the lens_* tables) it also (re)loads the database.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; APP="$(cd "$HERE/../.." && pwd)"; H="$(cd "$APP/../infra/hostinger" && pwd)"
set -a; . "$H/secrets.env"; set +a
R=/docker/junction-languagemirror
ssh_vps() { ssh -i "$H/deploy_key" -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile="$H/known_hosts" "root@$VPS_IP" "$@"; }
ssh_vps "mkdir -p $R && rm -rf $R/src.new && mkdir $R/src.new"
(cd "$APP" && git ls-files -z -co --exclude-standard pyproject.toml uv.lock app wikitime web scripts deploy | tar --null -T - -czf -) | ssh_vps "tar -xzf - -C $R/src.new && rm -rf $R/src && mv $R/src.new $R/src"
ssh_vps "cat > $R/compose.yml" <"$HERE/compose.yml"
if [ -f "$APP/.env.hostinger" ]; then ssh_vps "cat > $R/.env.app" <"$APP/.env.hostinger"; else ssh_vps "touch $R/.env.app"; fi
ssh_vps "cd $R && docker compose up -d --build db app >.build.log 2>&1" || { ssh_vps "tail -30 $R/.build.log"; exit 1; }
if [ -n "${1:-}" ]; then
  echo "loading $1"
  gzip -c "$1" | ssh_vps "cat > $R/lens.sql.gz"
  ssh_vps "cd $R && until docker compose exec -T db healthcheck.sh --connect --innodb_initialized </dev/null; do sleep 3; done && gunzip -c lens.sql.gz | docker compose exec -T db mariadb -uroot -pwikitime wikitime && rm lens.sql.gz"
fi
for _ in $(seq 1 30); do c=$(curl -s -o /dev/null -w '%{http_code}' -m 10 https://languagemirror.bobs.build/ || true); [ "$c" = 200 ] && break; sleep 5; done
echo "https://languagemirror.bobs.build/ answers $c"
