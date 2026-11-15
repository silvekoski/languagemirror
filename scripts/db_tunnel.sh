#!/usr/bin/env bash
# Laptop side: forward 127.0.0.1:3310 to the MariaDB job on chili (scripts/chili_db.sh).
exec ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:3310:100.73.11.93:3310 chili
