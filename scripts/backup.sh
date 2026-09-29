#!/usr/bin/env bash
# Nightly backup of everything this business cannot re-create.
#
#   data/*.json      orders, customers, wallets, top-ups, activity, alerts
#   server/.env      the supplier key, the Paystack key, the admin password hash
#
# The .env file is IN the archive on purpose: restoring orders without the keys that
# talk to the supplier leaves a shop that cannot sell. The archive is therefore
# chmod 600 and must be stored like a credential.
#
# Installed to /usr/local/sbin/polymath-backup.sh by scripts/install-backup.sh, which
# also installs the daily cron entry. Run by hand any time:
#     sudo /usr/local/sbin/polymath-backup.sh
#     sudo /usr/local/sbin/polymath-backup.sh --verify      # check the newest archive
#     sudo /usr/local/sbin/polymath-backup.sh --list        # what is there, with sizes
set -euo pipefail

ROOT="${POLYMATH_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
DATA="$ROOT/data"
ENV_FILE="$ROOT/server/.env"
DEST="${POLYMATH_BACKUP_DIR:-/var/backups/polymath}"
EXTERNAL="${POLYMATH_BACKUP_EXTERNAL:-/mnt/polymath-backup}"
KEEP_DAYS="${POLYMATH_BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
ARCHIVE="$DEST/polymath-$STAMP.tar.gz"
LOG="$DEST/backup.log"

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG" >&2; }
die() { log "FAILED: $*"; exit 1; }

mode="${1:-backup}"

case "$mode" in
  --list|-l)
    [ -d "$DEST" ] || die "no backup directory at $DEST"
    ls -lh "$DEST"/*.tar.gz 2>/dev/null | awk '{print $5"\t"$9}' || echo "  (none)"
    exit 0
    ;;
  --verify|-v)
    newest=$(ls -1t "$DEST"/polymath-*.tar.gz 2>/dev/null | head -1 || true)
    [ -n "$newest" ] || die "no archive to verify in $DEST"
    log "verifying $newest"
    tar -tzf "$newest" >/dev/null || die "$newest is not a readable archive"
    if [ -f "$newest.sha256" ]; then
      ( cd "$(dirname "$newest")" && sha256sum -c "$(basename "$newest").sha256" >/dev/null ) || die "checksum mismatch for $newest"
      log "checksum ok"
    else
      log "warning: no checksum file beside $newest"
    fi
    # An archive that cannot be listed is worthless, but one that does not contain the
    # order book is worse: it looks fine until the day it is needed.
    tar -tzf "$newest" | grep -q 'data/orders.json' || die "archive does not contain data/orders.json"
    log "contents ok (data/orders.json present)"
    exit 0
    ;;
  backup|"") ;;
  *) die "unknown argument: $mode (use --verify, --list, or nothing)" ;;
esac

[ -d "$DATA" ] || die "no data directory at $DATA"
[ -f "$DATA/orders.json" ] || log "warning: data/orders.json does not exist yet — backing up anyway"

mkdir -p "$DEST"
chmod 700 "$DEST"

log "backing up $ROOT -> $ARCHIVE"
umask 077
items=()
[ -d "$DATA" ] && items+=("data")
[ -f "$ENV_FILE" ] && items+=("server/.env")
[ "${#items[@]}" -gt 0 ] || die "nothing to back up"

# --warning=no-file-changed: the storefront rewrites these files while it runs, and a
# file that changed mid-read is not a backup failure.
tar --warning=no-file-changed -czf "$ARCHIVE" -C "$ROOT" "${items[@]}" || {
  rc=$?
  # tar exits 1 for "some files changed while reading", which is normal here.
  [ "$rc" -eq 1 ] || die "tar failed with status $rc"
}
chmod 600 "$ARCHIVE"
( cd "$DEST" && sha256sum "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256" )

size=$(du -h "$ARCHIVE" | cut -f1)
log "wrote $ARCHIVE ($size)"

# Second copy on the external drive, if it is plugged in. A backup on the same disk
# as the data it protects is not a backup.
if mountpoint -q "$EXTERNAL" 2>/dev/null; then
  cp -a "$ARCHIVE" "$ARCHIVE.sha256" "$EXTERNAL/" && log "copied to $EXTERNAL (external, off-disk)"
else
  log "note: $EXTERNAL is not a mounted drive — only the on-disk copy exists today"
fi

# Retention. Keeps KEEP_DAYS days, never the last archive.
find "$DEST" -maxdepth 1 -name 'polymath-*.tar.gz' -type f -mtime "+$KEEP_DAYS" -print -delete | while read -r f; do log "pruned $(basename "$f")"; done
find "$DEST" -maxdepth 1 -name 'polymath-*.tar.gz.sha256' -type f -mtime "+$KEEP_DAYS" -delete

count=$(ls -1 "$DEST"/polymath-*.tar.gz 2>/dev/null | wc -l)
log "done. $count archive(s) held, keeping $KEEP_DAYS days"
