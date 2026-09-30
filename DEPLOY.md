# Running this in production

One small VPS, nginx in front, systemd underneath, JSON files on disk. This is the
setup the code assumes: the app binds `127.0.0.1` and trusts a proxy on loopback only,
so it must not be exposed directly.

Everything below is written for the failure that has actually happened here twice —
**a deploy that took the storefront down** — because that is the expensive one: while
the site is down, customers see an error at the moment they are trying to pay.

## 1. First-time setup

```bash
sudo adduser --system --group --home /opt/polymath-data-hub polymath
sudo -u polymath git clone <repo> /opt/polymath-data-hub
cd /opt/polymath-data-hub
sudo -u polymath npm install --omit=dev

sudo -u polymath cp server/.env.example server/.env
sudo -u polymath chmod 600 server/.env
sudo -u polymath "$EDITOR" server/.env     # ADMIN_USER, ADMIN_PASS, iDATA + Paystack keys
```

`server/.env` holds the supplier key, the payment key and the admin credentials. Mode
`600`, owned by the service user, backed up (it is inside the nightly archive — see
below). The app loads it from its own directory, so it does not matter which directory
the process starts in.

**Check the three settings that turn a real storefront into a fake one**, all visible
at `https://<host>/api/health`:

| Setting | Must be | Otherwise |
|---|---|---|
| `IDATAGH_USE_MOCK` | `0` or unset | orders are "delivered" by a stub and nothing reaches a customer |
| `IDATAGH_API_KEY` | set | no catalogue, no sales |
| `IDATAGH_WEBHOOK_SECRET` | set | delivery updates are refused (`supplierWebhook: "unsigned"`); statuses only move when you move them |
| `ADMIN_USER` / `ADMIN_PASS` | set | admin sign-in answers 503 |

## 2. systemd

```bash
sudo cp deploy/polymath-data-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now polymath-data-hub
systemctl status polymath-data-hub --no-pager
journalctl -u polymath-data-hub -n 50 --no-pager
```

The unit restarts the process if it dies, and stops trying after ten failures in five
minutes rather than spinning (a restart storm hides the real error). It also runs with
`ProtectSystem=strict` and can write exactly two things: `data/` and `server/.env`.

If you edit the paths, edit them in **both** the unit and this document — the unit has
`ReadWritePaths` that must match the working directory.

## 3. nginx and TLS

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/polymath-data-hub
sudo tee /etc/nginx/proxy_params_polymath >/dev/null <<'PARAMS'
proxy_http_version 1.1;
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_read_timeout 30s;
proxy_connect_timeout 5s;
PARAMS
sudo ln -s /etc/nginx/sites-available/polymath-data-hub /etc/nginx/sites-enabled/
sudo sed -i 's/bundles.example.com/YOUR.DOMAIN/g' /etc/nginx/sites-available/polymath-data-hub
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d YOUR.DOMAIN
```

Then set `PUBLIC_BASE_URL=https://YOUR.DOMAIN` in `server/.env`. It is the canonical
public origin: Paystack redirects the customer there after payment, and every HTML page
ships with `https://bundles.example.com` hard-coded in its `<link rel=canonical>`,
`og:url`, `og:image` and structured data. The server swaps that placeholder for
`PUBLIC_BASE_URL` as it serves each page, and does the same for `sitemap.xml` and
`robots.txt`.

Get it wrong and the failure is quiet but expensive: shared links point at a domain that
does not exist, so WhatsApp shows no preview picture, and search engines index the
placeholder. Check it after a deploy with:

```bash
curl -s https://YOUR.DOMAIN/ | grep -E 'canonical|og:url|og:image'
curl -s https://YOUR.DOMAIN/robots.txt
```

If either still says `bundles.example.com`, `PUBLIC_BASE_URL` is empty or unset.

The two webhook locations are in their own `location =` blocks on purpose. Their
signatures are computed over the exact bytes of the body, so nothing in nginx may
compress, buffer into a different shape, or rewrite them.

## 4. Deploying a change

**Never `git pull && systemctl restart`.** That is the command that has taken this shop
down. Use the gate:

```bash
cd /opt/polymath-data-hub
sudo -u polymath git pull
sudo bash scripts/deploy.sh
```

`scripts/deploy.sh` does, in this order:

1. **Preflight** — every `.js` file is parsed (`node --check`), every module is loaded
   and its exports checked, dependencies and `.env` permissions verified. *The running
   server is still serving customers while this happens.* A typo costs nothing.
2. **Restart**, only if preflight passed.
3. **Health check** — polls `/api/health` for up to 25s.
4. **Rollback** — if the new code never becomes healthy, it resets to the previous
   revision, preflights that, restarts, and verifies. If the rollback also fails it
   says so in those words, because that is the moment to restore from backup.

Run it with `--check-only` any time to see whether the tree and the live service are
healthy without changing anything. `--rollback` reverses the last revision on purpose.

CI runs the same preflight plus both test suites on every push
(`.github/workflows/ci.yml`), so a syntax error is normally caught before it is even on
the server.

## 5. Backups

```bash
sudo bash scripts/install-backup.sh      # installs the script + a 03:17 daily cron
sudo /usr/local/sbin/polymath-backup.sh --verify
sudo /usr/local/sbin/polymath-backup.sh --list
```

Each run writes `/var/backups/polymath/polymath-<utc>.tar.gz` (mode `600`) containing
`data/` **and `server/.env`** — restoring orders without the supplier keys leaves a shop
that cannot sell — plus a `.sha256`. It keeps 14 days, and copies to
`/mnt/polymath-backup` when that drive is plugged in. A backup on the same disk as the
data is not a backup; plug the drive in.

**Restore drill (do this once, on a scratch box, before you need it):**

```bash
sudo systemctl stop polymath-data-hub
sudo tar -xzf /var/backups/polymath/polymath-<stamp>.tar.gz -C /opt/polymath-data-hub
sudo chown -R polymath:polymath /opt/polymath-data-hub/data /opt/polymath-data-hub/server/.env
sudo chmod 600 /opt/polymath-data-hub/server/.env
sudo systemctl start polymath-data-hub
curl -s localhost:4000/api/health
```

An untested restore is a hope, not a backup.

## 6. Watching it

| What | Where | Act when |
|---|---|---|
| Alerts that need a human | admin dashboard → Alerts, and `data/alerts.json` | any "send unconfirmed", "refund owed", "order was PAID and the automatic send FAILED" |
| Every webhook arrival | `journalctl -u polymath-data-hub \| grep paystack` | nothing for an hour while card sales are happening means the webhook is misconfigured |
| Health | `curl -s localhost:4000/api/health` | `mock: true` on a live site, or `supplierWebhook: "unsigned"` |
| Supplier balance | admin dashboard → iDATA wallet | below one day of sales; the app alerts at `SUPPLIER_LOW_GHS` |
| Disk | `df -h /opt` | 80% — the JSON stores grow and backups live beside them |
| Log growth | `journalctl --disk-usage` | cap it: `sudo journalctl --vacuum-size=500M`, or set `SystemMaxUse=500M` in `/etc/systemd/journald.conf` |

The app writes one line per order, alert and webhook to stdout, so journald is the log;
there is no file to rotate. If you would rather have a file:
`StandardOutput=append:/var/log/polymath.log` in the unit, plus a logrotate entry with
`copytruncate`, `daily`, `rotate 14`.

## 7. When something is wrong

| Symptom | First move |
|---|---|
| 502 from nginx | `systemctl status polymath-data-hub`; if it is restart-looping, `journalctl -n 80` — usually a syntax error or a bad `.env` line |
| Site up, nothing delivered | admin → Orders, filter "Send unconfirmed"; check `/api/health` for `mock: true` |
| Card paid, no order released | `journalctl \| grep paystack` — no arrival means the webhook URL or the key is wrong; the 60s reconciler still releases the order, so check `data/orders.json` for `pending_payment` |
| "This bundle is temporarily out of stock" for everything | the supplier wallet is below the bundle cost — top up at iDATA |
| Locked out of admin | the per-IP lock clears in 15 minutes (`ADMIN_LOCK_MS`); the password is in `server/.env` — edit it and restart |
| Suspect a double-charge | admin → the order → check `sendClaimedAt`, `providerRef`, `sendAttempts`; the order's `providerMessage` and the alerts both name the supplier reference to quote |
