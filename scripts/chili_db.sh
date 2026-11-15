#!/usr/bin/env bash
# MariaDB for Wikipedia Through Time, as a Slurm job on chili (datadir on the 8 TB HDD /bulk).
#   cj run -n wt-db -c 6 -m 12G -t 3-00:00 --tag wikitime-db -- bash scripts/chili_db.sh
# Listens on chili's Tailscale address :3310. The laptop reaches it through an ssh tunnel on
# 127.0.0.1:3310 (scripts/db_tunnel.sh), so code and tools keep their defaults.
set -euo pipefail
DATA=/bulk/shared/wikitime/mysql
MEM=${SLURM_MEM_PER_NODE:-12288}m
CPUS=${SLURM_CPUS_PER_TASK:-6}
docker rm -f wikitime-db >/dev/null 2>&1 || true
exec docker run --rm --name wikitime-db --user "$(id -u):$(id -g)" \
  --memory="$MEM" --memory-swap="$MEM" --cpus="$CPUS" \
  -v "$DATA":/var/lib/mysql -p 100.73.11.93:3310:3306 \
  -e MARIADB_ROOT_PASSWORD=wikitime \
  docker.io/library/mariadb:12.3.3 \
  --max-allowed-packet=256M --innodb-buffer-pool-size=6G --mhnsw-max-cache-size=3G --mhnsw-ef-search=80 \
  --innodb-undo-log-truncate=ON --innodb-max-undo-log-size=64M \
  --character-set-server=utf8mb4 --collation-server=utf8mb4_uca1400_ai_ci
