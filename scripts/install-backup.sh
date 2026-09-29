#!/bin/bash
# Installs the v2 backup script and its daily cron job.
#
# Run this yourself, on the server, with:
#     sudo bash install-backup.sh
#
# It is safe to run more than once: it backs up the old script, replaces any existing
# cron line rather than adding a second one, and then runs a real backup and verifies it.
set -eu

SRC="$(cd "$(dirname "$0")" && pwd)/backup.sh"
DST=/usr/local/sbin/polymath-backup.sh
EXTERNAL_MOUNT=/mnt/polymath-backup
CRON_LINE='17 3 * * * /usr/local/sbin/polymath-backup.sh >/dev/null 2>&1'

[ -f "$SRC" ] || { echo "cannot find backup.sh next to this installer"; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "run this with sudo"; exit 1; }
bash -n "$SRC" || { echo "backup.sh has a syntax error, refusing to install"; exit 1; }

echo "== 1. install the script"
if [ -f "$DST" ] && ! cmp -s "$SRC" "$DST"; then
  cp -a "$DST" "$DST.v1-$(date +%F)"
  echo "   kept the old script as $DST.v1-$(date +%F)"
fi
install -m 755 -o root -g root "$SRC" "$DST"
echo "   installed $DST"

echo
echo "== 2. install the daily cron entry (03:17)"
tmpm=$(mktemp)
crontab -l 2>/dev/null | grep -v 'polymath-backup\.sh' >"$tmpm" || true
echo "$CRON_LINE" >>"$tmpm"
crontab "$tmpm"
rm -f "$tmpm"
echo "   root cron now:"
crontab -l | grep polymath-backup | sed 's/^/     /'

echo
echo "== 3. create the external backup mountpoint"
mkdir -p "$EXTERNAL_MOUNT"
echo "   $EXTERNAL_MOUNT ready (the drive is not there yet, which is fine)"

echo
echo "== 4. run a real backup now and verify it"
if "$DST"; then
  echo "   backup run: OK"
else
  echo "   backup run: FAILED - see /var/backups/polymath/backup.log" >&2
  exit 1
fi

echo
echo "== 5. verify the archive that was just written"
"$DST" --verify

echo
echo "Done. Nightly backups now cover the supplier/payment credentials too, and write a"
echo "verified archive + checksum. Plug in the external drive to add the second copy."
