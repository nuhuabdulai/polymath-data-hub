#!/usr/bin/env bash
# Refuse to start from a tree that cannot run.
#
# Why this exists: "a single syntax error takes the whole storefront down" is not
# fixed by splitting the file — Node parses every module it loads at boot, so one bad
# character anywhere stops the process. The fix is to find it BEFORE the restart,
# with the old process still serving customers. This script is that gate, and it is
# called by scripts/deploy.sh before anything is stopped.
#
# Checks, in order (cheapest first):
#   1. every .js file parses  (node --check)
#   2. the app's own modules load and export what server.js imports from them
#   3. dependencies are present
#   4. .env exists and is not world-readable, if the service expects one
#
# Usage: bash scripts/preflight.sh [<repo-root>]
set -euo pipefail

ROOT="${1:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
cd "$ROOT"
fail=0
say()  { printf '  %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=1; }
good() { printf '  ok    %s\n' "$*"; }

echo "preflight: $ROOT"

echo
echo "== 1. every JavaScript file parses"
count=0
while IFS= read -r f; do
  count=$((count + 1))
  if ! err=$(node --check "$f" 2>&1); then
    bad "$f"
    printf '%s\n' "$err" | sed 's/^/        /'
  fi
done < <(find server public/js scripts test -name '*.js' -not -path '*/node_modules/*' -not -path 'test/run*' 2>/dev/null | sort)
[ "$fail" -eq 0 ] && good "$count files parse"

echo
echo "== 2. the app's modules load and export what server.js imports"
# Deliberately NOT loading server.js: requiring it binds the port and starts the
# scheduled jobs, which is not something a preflight should do (it hung the first
# time this script was written). The modules are loaded on their own instead, and the
# exports server.js destructures are checked one by one — a missing export is a
# ReferenceError on the first request that needs it, and this catches it here.
if node -e '
const path = require("path");
const root = process.argv[1];
const expect = {
  config: ["cfg", "dataPath", "publicPath"],
  store: ["loadOrders", "saveOrders", "loadUsers", "saveUsers", "loadTopups", "saveTopups",
          "loadBlocked", "saveBlocked", "isBlocked", "maintenanceState", "saveMaintenance",
          "maintenanceAllows", "autoApproveState", "saveAutoApprove", "loadJson", "saveJson"],
  alerts: ["activity", "alertAdmin", "loadAlerts", "collapseDuplicateAlerts", "warnIfBelowCost"],
  pricing: ["priceFor", "bothPrices", "loadPricing", "savePricing", "promoLive", "savePercent", "round2"],
  orders: ["newOrder", "orderProgress", "publicOrder", "trackingOrder", "recentOrderForNumber",
           "expireUnpaid", "watchStuckOrders", "startOrderJobs", "requireTermsAgreed", "ensureTrackCodes"],
};
let bad = 0;
for (const [mod, names] of Object.entries(expect)) {
  const m = require(path.join(root, "server", "lib", mod + ".js"));
  for (const n of names) {
    if (typeof m[n] === "undefined") { console.error(`  missing export: ${mod}.${n}`); bad = 1; }
  }
}
// The one import that is easy to typo and painful to debug at 2am.
const { cfg, dataPath } = require(path.join(root, "server", "lib", "config.js"));
if (!/\/data\/orders\.json$/.test(dataPath("orders.json"))) { console.error("  dataPath() does not resolve to .../data/"); bad = 1; }
if (typeof cfg("___NOPE___", "defaulted") !== "string") { console.error("  cfg() is not returning strings"); bad = 1; }
process.exit(bad ? 1 : 0);
' "$ROOT"; then
  good "all modules load and export what server.js destructures"
else
  bad "a module fails to load or is missing an export"
fi

echo "== 3. dependencies"
if [ -d node_modules/express ] || [ -d server/node_modules/express ]; then
  good "express is installed"
else
  bad "express is not installed (run: npm install)"
fi

echo
echo "== 4. configuration"
if [ -f server/.env ]; then
  good "server/.env exists"
  perms=$(stat -c '%a' server/.env 2>/dev/null || echo "?")
  case "$perms" in
    600|640|400|440) good "server/.env permissions are $perms" ;;
    *) bad "server/.env is mode $perms — it holds the supplier and payment keys. Run: chmod 600 server/.env" ;;
  esac
else
  printf '  note  no server/.env — the service will run with defaults (mock supplier off, admin NOT configured)\n'
fi

echo
echo "== 5. accessibility (colour contrast)"
if [ -f scripts/check-contrast.js ]; then
  if out=$(node scripts/check-contrast.js 2>&1); then
    good "every text/background pair meets WCAG AA"
  else
    printf '%s\n' "$out" | sed 's/^/        /'
    bad "contrast check failed — a colour token was changed to something unreadable"
  fi
else
  printf '  note  scripts/check-contrast.js is missing — skipping the contrast gate\n'
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "preflight PASSED — safe to restart"
else
  echo "preflight FAILED — do NOT restart the running server; the old one is still serving" >&2
fi
exit "$fail"
