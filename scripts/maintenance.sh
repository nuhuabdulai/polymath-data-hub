#!/usr/bin/env bash
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DATA="$ROOT/data"
FLAG="$DATA/maintenance.json"
ACTION="${1:-}"
usage() { printf 'Usage: %s on|off|status\n' "$0"; exit 2; }
case "$ACTION" in
  on)
    mkdir -p "$DATA"
    umask 077
    tmp="$FLAG.tmp.$$"
    printf '{"on":true,"updatedAt":"%s","updatedBy":"cli"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"
    mv -f "$tmp" "$FLAG"
    printf 'Store maintenance is ON\n'
    ;;
  off)
    rm -f "$FLAG"
    printf 'Store maintenance is OFF\n'
    ;;
  status)
    if [ -f "$FLAG" ] && python3 -c 'import json,sys; raise SystemExit(0 if json.load(open(sys.argv[1])).get("on") is True else 1)' "$FLAG" 2>/dev/null; then
      printf 'Store maintenance is ON\n'
    else
      printf 'Store maintenance is OFF\n'
    fi
    ;;
  *) usage ;;
esac
