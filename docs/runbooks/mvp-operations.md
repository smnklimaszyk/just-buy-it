# MVP operations

Status 2026-10-21. Owner: Simon Klimaszyk. How to run the MVP on the host `intra-ai`: the worker (polling, Claude screening, alert email), the server with its internal dashboard, and the ops CLI. Background: [environments and secrets](../planning/environments-and-secrets.md), ADRs [0015](../adr/0015-job-execution-idempotency-and-delivery.md), [0018](../adr/0018-claude-data-flow-and-residency.md), [0029](../adr/0029-ci-cd-and-deploy.md), [0035](../adr/0035-alert-email-over-smtp.md).

Every command below runs on the host as root unless it says otherwise. Never print a value from `/opt/ebay-sniper/.env`, never `source` it, and never paste a secret into a chat, an issue, a PR or a log. Record numbers only (counts, codes, times, costs); no listing text, item IDs or URLs.

## 0. Shell setup

Compose commands need the running release's file and the `.env`. In a root shell on the host:

```sh
cd /
sha="$(cat /opt/ebay-sniper/state/running)"
dc() { GIT_SHA="$sha" docker compose -p ebay-sniper --env-file /opt/ebay-sniper/.env \
  -f "/opt/ebay-sniper/releases/$sha/infra/docker-compose.yml" "$@"; }
ops() { dc run --rm --no-deps -T migrate node dist/main.js "$@"; }
```

`ops` runs the ops CLI in a one-off container of the `migrate` service (owner role, audited edits). `dc` is used in the sections below.

## 1. Deploy

### Install a new `ebay-deploy` first

The installed script never replaces itself (ADR 0029). When a merged change touches `infra/host/ebay-deploy` (the MVP does: worker step and new `.env` checks), install it by hand before deploying that SHA:

```sh
new=<40-character merged SHA>
git -C /opt/ebay-sniper/repo fetch --quiet origin main
git -C /opt/ebay-sniper/repo merge-base --is-ancestor "$new" origin/main && echo "on main"
git -C /opt/ebay-sniper/repo show "$new:infra/host/ebay-deploy" >/root/ebay-deploy.new
diff -u /usr/local/sbin/ebay-deploy /root/ebay-deploy.new | less   # read every line
install -m 755 -o root -g root /root/ebay-deploy.new /usr/local/sbin/ebay-deploy && rm /root/ebay-deploy.new
```

Log the install (date, SHA, "diff read") in the host runbook.

### Before the first MVP deploy

`.env` must have these names (check names only: `grep -c '^NAME=' /opt/ebay-sniper/.env` prints 1):

- `POSTGRES_WORKER_PASSWORD`, `POSTGRES_DASHBOARD_PASSWORD`: one `openssl rand -hex 32` each.
- `ITEM_KEY_V1`: `openssl rand -base64 32` (44 characters). Keep an offline copy: losing it breaks the item keys.
- `ALERT_TO`, and the five SMTP names all set or all absent (section 6).
- Optional: `ANTHROPIC_API_KEY`, `CLAUDE_DAILY_CALL_LIMIT=40`, `CLAUDE_DAILY_SPEND_LIMIT_USD=2`.

`stat -c '%U:%G %a' /opt/ebay-sniper/.env` must print `root:root 600`. Check disk (`df -h /var/lib/docker`, 10 GB free) and memory (`free -m`, `docker stats --no-stream`: at least 400 MB available for the worker; with less, the worker's `mem_limit` goes to 192m in a follow-up PR first, together with `NODE_OPTIONS: --max-old-space-size=120` in its environment).

### Deploy and check

```sh
ebay-deploy <sha>
```

The order: build, Postgres config, migrate (sets the `app`, `worker` and `dashboard` passwords, installs the pg-boss schema and queues; the log shows `pgboss_installed` with version 46 and the three `*_role_check_passed` lines), then the **server** (rolled back on a failed `/healthz` as before), then the **worker** with a 90 s health wait. If the worker does not get healthy, both go back to the previous release; when the previous release has no worker, the worker container is stopped. Without a previous release, everything is stopped. A release without a worker is a server-only deploy.

Then, from outside (your machine):

```sh
infra/host/smoke https://deals.intra-ai.de <sha>
```

It also checks that `/candidates`, `/alerts`, `/prices` and `/rejections` are 404 on the public site and that port 3142 takes no connection on the public address. On the host:

```sh
/opt/ebay-sniper/releases/$sha/infra/host/live-check
```

`live-check` checks: worker container healthy; the dashboard's `/healthz` reports the running SHA; `pgboss.version` is 46; worker heartbeat under 1 minute old; the last finished poll of every enabled feed is `ok` and under 15 minutes old; no stale `running` poll row in the last hour; no listing content older than 6 h 15 min; no delivery in `sending` past its lease; today's Claude use within both caps. Exit 0 means all passed.

Rollback by hand: deploy an older SHA. Migrations only add, so the older release runs on the newer schema; it ignores the `pgboss` schema and the new tables. A release without a worker service stops the running worker container, so no worker polls eBay or sends email next to the older server.

## 2. Feeds and rules

Feeds are seeded **paused**. Changes write `app.audit_event`; `ops rules set` bumps the segment's `rule_version`; a change that breaks the call plan (over 2,500 Browse calls a day at worst) is refused.

```sh
ops feeds resume gpu          # or ram, pc
ops feeds pause gpu
ops feeds set ram category 170083
ops feeds set gpu day_interval_s 120      # fields: category, q, price_ceiling_cents, day_interval_s,
                                          # night_interval_s, overflow_pages_per_day
ops rules list
ops rules set gpu_3090 max_landed_cents 52000   # fields: max_landed_cents, floor_cents, max_cents_per_gb,
                                                # min_cents_per_gb, min_total_gb, sweep_q,
                                                # candidate_cap_per_day, enabled
```

Prices are integer cents, compared with the landed price (price plus shipping to DE). A feed's first poll after resume is a **baseline**: it records what it sees and makes no candidate, getItem, Claude call or alert. Listings it sees in band never alert later; listings it rejects (for example above the max) alert once a later price drop brings them into the band. A segment with `enabled false` makes no candidates in polls or sweeps. Sweeps of its segments wait for that baseline.

## 3. Price read and limits

The limits in `app.segment_rule` start at 80% (max) and 40% (floor) of assumed asking prices. Replace them from the market:

1. About 3 hours after the feeds are resumed, open `/prices` on the dashboard (section 5), window "since baseline".
2. For each segment with a suggestion: `ops rules set <segment> max_landed_cents <value>` (per-GB segments: `max_cents_per_gb`), then the floor field (`floor_cents`, or `min_cents_per_gb`). The suggestion is max = min(p25, 0.8 x p50) and floor = 0.4 x p50, rounded down to EUR 10 (EUR 0.10 per GB), from at least 20 listings with known shipping.
3. No suggestion (`n < 20`, or "raise the read ceiling" when p75 is at 90% of the feed's `price_ceiling_cents`): keep the values and read again at hour 24. For a cut-off read, raise the ceiling with `ops feeds set <feed> price_ceiling_cents <value>` first.
4. Report to the owner a table of numbers only: segment, n, p25, p50, p75, old max, new max, old floor, new floor.

## 4. Manual Browse call for a category check

One call per check, counted in the shared quota. Prints only the total and the category distribution; no listing content is printed or kept.

```sh
# 1. Reserve one unit; continue only on "ok".
dc exec -T postgres psql -U ebay_sniper -d ebay_sniper -tAc \
  "SELECT app.reserve_ebay_call('buy.browse','standard','contract',1500,now())"

# 2. Application token. The keyset goes to curl on stdin, never on the command line or the screen.
id="$(grep -E '^EBAY_CLIENT_ID=' /opt/ebay-sniper/.env | tail -n 1 | cut -d= -f2-)"
secret="$(grep -E '^EBAY_CLIENT_SECRET=' /opt/ebay-sniper/.env | tail -n 1 | cut -d= -f2-)"
token="$(printf 'user = "%s:%s"\n' "$id" "$secret" | curl -fsS -K - \
  -d grant_type=client_credentials --data-urlencode scope=https://api.ebay.com/oauth/api_scope \
  https://api.ebay.com/identity/v1/oauth2/token | jq -r .access_token)"
unset id secret

# 3. The search (q=ddr4 with category 170083, or q=rtx 4090 with category 179).
printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -fsS -K - --get \
  -H 'X-EBAY-C-MARKETPLACE-ID: EBAY_DE' --data-urlencode 'q=ddr4' -d category_ids=170083 \
  -d limit=1 -d fieldgroups=CATEGORY_REFINEMENTS https://api.ebay.com/buy/browse/v1/item_summary/search |
  jq '{total, categories: [.refinement.categoryDistributions[]? | {categoryId, categoryName, matchCount}]}'
unset token
```

Pass when the response names the expected category ("Arbeitsspeicher (RAM)", "Desktops & All-in-One-PCs") with `matchCount` above 0. Otherwise one more call without `category_ids` finds the dominant leaf; set it with `ops feeds set <feed> category <id>` before resuming that feed. `api_usage_hourly` shows the calls under purpose `contract`.

## 5. Dashboard

Internal only, no sign-in, read-only database role, never routed by Traefik. From your machine:

```sh
ssh -L 3142:127.0.0.1:3142 intra-ai
```

Then open `http://127.0.0.1:3142/`. Pages: `/` (worker heartbeat, feeds, last polls and sweeps, quota, Claude use, email, purge), `/candidates`, `/alerts`, `/blocked`, `/screenings`, `/rejections` (counts by reason code and the 6-hour title sample), `/prices`. Times are Europe/Berlin; pages refresh every 60 s.

Logs (counts, codes and IDs only; no listing content):

```sh
dc logs worker --since 1h | grep -c poll_run
dc logs worker --since 1h | grep -E '"event":"(quota_refused|screening_paused|smtp_paused)"'
```

## 6. Email (SMTP)

Set or change SMTP: write all five of `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `ALERT_FROM` in `.env` (the host's `ebay-set-smtp` helper does this), or remove all five. A partial set stops the worker and `ebay-deploy`, naming the missing names. `ALERT_FROM=Just-Buy-It <info@intra-ai.de>` is written unquoted; a partly quoted value makes Compose refuse the file. Then recreate the worker and send a test mail:

```sh
dc up -d --no-deps --wait --wait-timeout 90 worker
dc run --rm --no-deps worker node dist/main.js mail:test
```

`mail:test` prints the SMTP response code and the message ID; the test mail has no eBay content. Confirm in the mailbox that it arrived with sender "Just-Buy-It".

With SMTP unset, the worker runs and alerts stay `pending` (hold reason `smtp_not_configured`); once SMTP is set and the worker recreated, pending alerts under 6 hours old go out. At most 10 emails an hour and 60 a Berlin day; more wait with hold reason `rate_limit`.

The mailbox should delete alert mail after 30 days (ADR 0014, D-48): set a mailbox rule for subjects starting with `[Deal]`.

## 7. Claude screening

- **Switch off:** set `CLAUDE_DAILY_CALL_LIMIT=0` in `.env`, then `dc up -d --no-deps --wait --wait-timeout 90 worker`. Alerts then say "Not screened by Claude: cap_reached" and no getItem is made. Set it back to 40 the same way.
- **Rotate the key:** create a new key in the Anthropic Console, replace `ANTHROPIC_API_KEY` in `.env` and the password manager, recreate the worker as above, check `/screenings` for a `done` row, then delete the old key in the Console. Rotate after the live acceptance, and on any leak.
- Caps: 40 calls and USD 2 per Berlin day by default, checked before every call; the worst case is USD 2 a day. Recommended: a Console workspace limit of USD 75 a month for this key.
- The offline eval set runs on your machine only, never in CI: `ANTHROPIC_API_KEY=... pnpm --filter @ebay-sniper/llm eval` with the key from the password manager in the shell, never in a file.

## 8. When something goes wrong

| Sign | Meaning | Action |
|---|---|---|
| `/screenings` shows `auth_failed`; log `screening_paused` | Anthropic refused the key (401/403). Screening is paused 15 minutes for all listings; alerts go out as "Not screened by Claude: paused" | Check the key and the workspace in the Console; rotate it (section 7). The pause ends by itself |
| Log `smtp_paused`; deliveries held with `smtp_paused` | The mail server refused the login (535). All sends wait 15 minutes | Check `SMTP_USER` and `SMTP_PASSWORD`; fix `.env`, recreate the worker, run `mail:test`. Held deliveries under 6 h old go out after the pause |
| `poll_run` status `quota_refused`; log `quota_refused` | The eBay call reservation was refused; no request was made | Check the quota on `/`. The plan stays under 40% of 5,000 a day, so this means manual calls or a bug: pause the feeds (`ops feeds pause ...`) and compare `poll_run.calls` with `api_usage_hourly` |
| "error (stale)" on `/`; `live-check` reports stale rows | A poll or sweep was killed mid-run (crash, OOM, a kill during deploy) | `dc ps worker`, `dc logs worker --since 1h`, `docker stats --no-stream`. The feed is due again 5 minutes later; after 5 failed runs in a row it pauses 15 minutes by itself |
| Worker unhealthy | No heartbeat for 30 s: database not answering or pg-boss stopped | `dc logs worker --since 15m`; a pg-boss schema version error means a deploy mismatch: deploy the right SHA |
| Deliveries `failed` | 5xx from the mail server (for example 550), or 5 attempts used | Read `last_error_code` on `/alerts`; fix the cause; the alert itself is not re-sent |

## 9. Reminders

- **2027-01-15:** retention of `deletion_event` (1 y), `deletion_result_hourly` (90 d), `ebay_quota_window` (90 d), `api_usage_hourly` (1 y) and `audit_event` (1 y) is not built (ADR 0014 MVP note). The oldest rows are from 2026-10-19, so `ebay_quota_window` and `deletion_result_hourly` rows pass 90 days around 2027-01-17. Build that purge (Phase 1 S2) before then, or delete those rows by hand as the owner role and log it.
- After the live acceptance: rotate the Anthropic key; follow-up docs PR for `docs/compliance/gates.md` with the category IDs from section 4.
