#!/usr/bin/env bash
# Restart the storefront, but only onto code that has already proved it can run.
#
# The failure this is built for: editing server.js, restarting, and taking the shop
# down with a typo — twice, per the README. Node parses every module at boot, so
# splitting files does not prevent that; a gate does. The order here is:
#
#   preflight (old process still serving)  ->  restart  ->  health check
#        ->  if the health check fails, put the previous revision back and restart
#
# Nothing is stopped until preflight passes, so the common case (a typo) costs
# nothing at all: the running server never blinks.
#
# Usage:
#   sudo bash scripts/deploy.sh                 # preflight, restart, verify, rollback
#   bash scripts/deploy.sh --check-only         # preflight + health of what is running
#   sudo bash scripts/deploy.sh --rollback      # go back one revision, on purpose
set -euo pipefail

ROOT="${POLYMATH_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
cd "$ROOT"
SERVICE="${POLYMATH_SERVICE:-polymath-data-hub}"
PORT="${PORT:-4000}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
HEALTH_TIMEOUT="${POLYMATH_HEALTH_TIMEOUT:-25}"

say()  { printf '\n== %s\n' "$*"; }
good() { printf '   ok    %s\n' "$*"; }
bad()  { printf '   FAIL  %s\n' "$*" >&2; }

health_ok() {
  # The endpoint reports mode/mocks/webhook state as well as ok:true, so this is a
  # check of the configuration, not only of "is a process listening".
  body=$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null) || return 1
  printf '%s' "$body" | grep -q '"ok":true' || return 1
  echo "$body"
}

wait_for_health() {
  local waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    if body=$(health_ok); then printf '%s\n' "$body"; return 0; fi
    sleep 1; waited=$((waited + 1))
  done
  return 1
}

restart_service() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl restart "$SERVICE"
  else
    bad "systemctl is not available; restart the service yourself and re-run --check-only"
    return 1
  fi
}

say "what is running now"
if body=$(health_ok); then good "current instance answers: $body"; else printf '   note  nothing answering at %s yet\n' "$HEALTH_URL"; fi

say "preflight on the tree we are about to run"
if ! bash scripts/preflight.sh "$ROOT"; then
  bad "preflight failed — NOT restarting. The server that is up is still serving."
  exit 1
fi

if [ "${1:-}" = "--check-only" ]; then
  say "check-only: no restart was made"
  body=$(health_ok) && good "running instance is healthy: $body" || bad "the running instance is NOT healthy"
  exit 0
fi

if [ "${1:-}" = "--rollback" ]; then
  say "rollback: moving to the previous revision"
  if [ ! -d .git ]; then bad "not a git checkout, so there is nothing to roll back to"; exit 1; fi
  git log --oneline -3
  git rev-parse HEAD > /tmp/polymath-failed-rev
  if ! git revert --no-edit HEAD; then bad "automatic revert hit a conflict — resolve it by hand"; exit 1; fi
  bash scripts/preflight.sh "$ROOT" || { bad "the reverted tree does not even pass preflight"; exit 1; }
  restart_service && wait_for_health >/dev/null && { good "rolled back and healthy again"; exit 0; }
  bad "still unhealthy after rollback — check: journalctl -u $SERVICE -n 80"
  exit 1
fi

previous_rev=""
if [ -d .git ]; then previous_rev=$(git rev-parse HEAD); fi

say "restarting $SERVICE"
restart_service || exit 1

say "waiting for the health check (up to ${HEALTH_TIMEOUT}s)"
if body=$(wait_for_health); then
  good "healthy: $body"
  say "deployed"
  [ -n "$previous_rev" ] && printf '   previous revision was %s (use --rollback to return)\n' "${previous_rev:0:7}"
  exit 0
fi

bad "the new code did not become healthy"
printf '   last 20 journal lines:\n'
command -v journalctl >/dev/null 2>&1 && journalctl -u "$SERVICE" -n 20 --no-pager | sed 's/^/      /' || true

if [ -n "$previous_rev" ] && [ -d .git ]; then
  say "rolling back to ${previous_rev:0:7}"
  git reset --hard "$previous_rev" >/dev/null 2>&1 || true
  bash scripts/preflight.sh "$ROOT" >/dev/null 2>&1 || true
  if restart_service && wait_for_health >/dev/null; then
    good "rolled back and healthy"
    printf '   the bad revision is still in reflog; fix it, then deploy again\n'
    exit 1
  fi
  bad "rollback also failed — the shop is DOWN. Restore from backup, or fix forward."
else
  bad "not a git checkout, so no automatic rollback. The shop may be DOWN."
fi
exit 1
