# Operations

Status 2026-10-23 (v2). Owner: Simon Klimaszyk. How to run v2 on the host `intra-ai`: the worker (polling, market snapshots, the Claude check, alert email), the server (deletion endpoint), the web console and the ops CLI. Background: [environments and secrets](../planning/environments-and-secrets.md), ADRs [0015](../adr/0015-job-execution-idempotency-and-delivery.md), [0018](../adr/0018-claude-data-flow-and-residency.md), [0029](../adr/0029-ci-cd-and-deploy.md), [0035](../adr/0035-alert-email-over-smtp.md), [0037](../adr/0037-products-as-data.md) to [0040](../adr/0040-market-value-from-asking-prices.md).

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

`ops` runs the ops CLI in a one-off container of the `migrate` service (owner role, audited edits as `system:cli`, the same checks and call plan as the console). `dc` is used in the sections below.

## 1. Deploy

### Install a new `ebay-deploy` first

The installed script never replaces itself (ADR 0029). When a merged change touches `infra/host/ebay-deploy` (v2 does: the web step and new `.env` checks), install it by hand before deploying that SHA:

```sh
new=<40-character merged SHA>
git -C /opt/ebay-sniper/repo fetch --quiet origin main
git -C /opt/ebay-sniper/repo merge-base --is-ancestor "$new" origin/main && echo "on main"
git -C /opt/ebay-sniper/repo show "$new:infra/host/ebay-deploy" >/root/ebay-deploy.new
diff -u /usr/local/sbin/ebay-deploy /root/ebay-deploy.new | less   # read every line
install -m 755 -o root -g root /root/ebay-deploy.new /usr/local/sbin/ebay-deploy && rm /root/ebay-deploy.new
```

Log the install (date, SHA, "diff read") in the host runbook.

### Before the first v2 deploy

`.env` must have these names (check names only: `grep -c '^NAME=' /opt/ebay-sniper/.env` prints 1):

- From the MVP: `POSTGRES_WORKER_PASSWORD`, `POSTGRES_DASHBOARD_PASSWORD` (still set by the migrate step, for a rollback to Release 0), `ITEM_KEY_V1`, `ALERT_TO`, and the five SMTP names all set or all absent (section 6).
- New in v2: `POSTGRES_WEB_PASSWORD` (`openssl rand -hex 32`), `AUTH_KEY` (`openssl rand -base64 32`; keep a copy in the password manager), `AUTH_BOOTSTRAP_ADMINS=info@intra-ai.de`, `PUBLIC_ORIGIN=https://deals.intra-ai.de`, and the five `LOGIN_SMTP_*` names all set or all absent (section 6, sign-in mail). Without them only `ops auth code` signs people in.
- Remove `CLAUDE_MODEL`: the model is the `claude.model` setting now. `ebay-deploy` warns while the line is there.
- Optional: `ANTHROPIC_API_KEY`, `CLAUDE_DAILY_CALL_LIMIT=40`, `CLAUDE_DAILY_SPEND_LIMIT_USD=2`. In v2 these are ceilings: the Settings page can set lower values, never higher.

`stat -c '%U:%G %a' /opt/ebay-sniper/.env` must print `root:root 600`. Check disk (`df -h /var/lib/docker`, 10 GB free) and memory (`free -m`, `docker stats --no-stream`): at least 600 MB available, 400 MB for the worker and 192 MB for `web` (its `mem_limit`). With less, stop and lower the limits in a follow-up PR first.

### Deploy and check

```sh
ebay-deploy <sha>
```

The order: build, Postgres config, migrate (sets the `app`, `worker`, `dashboard` and `web` passwords and checks each role, adds the bootstrap admins while no active admin exists, installs the pg-boss schema and queues; the log shows `pgboss_installed` with version 46 and the four `*_role_check_passed` lines), then the **server** (rolled back on a failed `/healthz`), then **web** (its `/healthz` on `127.0.0.1:3141` must report the SHA within 60 s; a failure puts the previous server and web back and leaves the worker alone), then the **worker** with a 90 s health wait (a failure puts the previous release back). A service the previous release does not have is stopped. Without a previous release, everything is stopped.

Then, from outside (your machine):

```sh
infra/host/smoke https://deals.intra-ai.de <sha>
```

It checks the deletion endpoint as before, that `/`, `/products`, `/deals`, `/settings`, `/people` and the old dashboard paths are 303 to `/login` without a session, that `/login` and `/privacy` send the content security policy and `/login` sends `X-Frame-Options: DENY`, and that port 3142 takes no connection on the public address. The console paths pass only once the v2 Traefik file is installed (step 7 below). On the host:

```sh
/opt/ebay-sniper/releases/$sha/infra/host/live-check
```

`live-check` checks: worker container healthy; web's `/healthz` on `127.0.0.1:3141` reports the running SHA; `pgboss.version` is 46; worker heartbeat under 1 minute old; the last finished poll of every enabled search that is not retired is `ok` and within its longer interval plus 5 minutes (35 minutes for a slow search at night); no stale `running` poll row in the last hour; no listing content older than 6 h 15 min; no delivery in `sending` past its lease; today's Claude use within the `.env` ceilings. Exit 0 means all passed.

### The first v2 deploy, step by step

1. Add the new `.env` names above; remove `CLAUDE_MODEL`.
2. Install the new `ebay-deploy` (above).
3. `ebay-deploy <sha v2>`: migrations 0007 to 0011, then server, web and worker. No product is active yet, so no alert goes out until step 6.
4. `ops products import-legacy`: writes today's six products as drafts from `app.segment_rule` and `app.feed` (same keys, same prices, normal speed, price-drop check on) and prints them. It refuses when any product exists. Check the printed drafts.
5. Sign in over an SSH tunnel, before the public route exists: `ssh -L 3141:127.0.0.1:3141 intra-ai`, then `http://127.0.0.1:3141/login` with `info@intra-ai.de`. Without sign-in mail, read the code with `ops auth code` (section 5).
6. For each draft (section 2): rename it, write the description for the Claude check, add the exclude words from the manual test guide, check the market value, choose the speed, activate it. Watch the first polls, one candidate and one alert. Expect under an hour without alerts.
7. Install the v2 Traefik file (`infra/traefik/ebay-sniper.yml` of the release) as `/opt/traefik/dynamic/ebay-sniper.yml`; keep the old one next to it as `/root/ebay-sniper.yml.release0`. Run `smoke` from outside and the proxy test: six `curl -H 'X-Forwarded-For: 1.2.3.4' -X POST https://deals.intra-ai.de/login` within 15 minutes; the sixth is limited whatever the header says, and the deletion challenge still reaches the server.

### Rollback

Migrations only add (no contract migration in v2), so an older release runs on the newer schema.

| From | To | How |
|---|---|---|
| v2 | Release 0 (530d6fa) | `ebay-deploy <sha of Release 0>`, then put the old Traefik file back: `install -m 644 /root/ebay-sniper.yml.release0 /opt/traefik/dynamic/ebay-sniper.yml` |
| Release 0 | MVP | `ebay-deploy <sha MVP>`, only before any v2 deploy |

What a rollback from v2 to Release 0 leaves behind:

- The deploy stops `web`. Until the old Traefik file is back, every path other than `/healthz`, `/privacy` and `/ebay/account-deletion` gives 502; the deletion endpoint keeps working by router priority.
- Release 0 polls from `app.feed` and `app.segment_rule`, which v2 never changed. Product edits made in v2 do not flow back.
- Rows v2 wrote carry product keys (`p_...` or the imported keys) in `segment` and, in `feed_id`, the search id (`s<n>`) for a poll or the product key for a sweep, on `seen_item`, `listing`, `candidate`, `poll_run` and `price_sample`. Release 0's dashboard shows them raw; a pending candidate of a product added in v2 (`p_...`) expires with `unknown_segment`, and the decisions `wrong_product` and `held` show raw.
- `poll` and `sweep` jobs v2 left queued carry v2 payloads (`searchId`, `productKey`). Each fails Release 0's payload check once and lands in `poll.dead` or `sweep.dead`. That is harmless: no retry, no eBay call. Jobs on queues Release 0 has no handler for (`market-snapshot`, `market-nightly`, `category-suggest`, `held-requeue`) are not worked.
- Release 0's purge does not know `ebay_live.market_preview`, which holds eBay titles for 6 hours (spec 2.4). Empty it once after the rollback deploy: `dc exec -T postgres psql -U ebay_sniper -d ebay_sniper -c 'TRUNCATE ebay_live.market_preview'`. The next v2 snapshot fills it again.
- Rolling forward again is `ebay-deploy <sha v2>` and the v2 Traefik file; the products, people and settings are still in the database.

## 2. Products (the form)

Products are rows in `app.product`, edited in the console under **Products** (admins and editors). Every save goes through one audited transaction: it writes the product, a revision and an audit row, rebuilds the eBay searches and refuses a plan over 2,500 Browse calls a day, naming the numbers and the cheapest fix that fits. Two people editing the same product: the later save is refused with who changed it and when, and nothing is saved.

- **Add product** (`/products/new`) saves a **draft**. Drafts are not polled; saving one starts one market snapshot (section 3). **Activate product** on the product page starts polling.
- Core fields: name, the description for the Claude check (say what it is and what it is not), search words, must contain (one group per line, alternatives with commas), must not contain (`word*` matches the start, `~word` a near match, phrases allowed, no other symbols), eBay category, conditions, the price rule (a fixed max price, or a percentage below the typical asking price with a "never above" cap), and the people who get the alert in Bcc next to `ALERT_TO`.
- **Advanced**: speed (fast, normal, slow), the hourly price-drop check, floor, poll price ceiling, price per GB with the minimum and largest kit size, warning words, junk rule exceptions, the accessory check, candidates per day (10 for a new product, 20 for an imported one), buyer profile, and "Only alert after Claude has checked it" (without it, an alert Claude could not check goes out marked "Not checked by Claude").
- **Test a title** on the form shows the outcome and the rule that fired, without an eBay call.
- The cost box shows what a save adds to the plan before you save. `/budget` shows the plan by line against 2,500, the searches with their last poll, the quota and today's Claude calls per product. One product may use at most half of the day's Claude calls.
- Pause, resume and archive are in the row menu. A paused product records sightings and makes no candidates; a candidate of a product paused or archived mid-way ends `expired`.

The same from the CLI (audited as `system:cli`, same checks and plan):

```sh
ops products list
ops products show <key>
ops products set <key> max_cents 52000      # field names as in the form, in snake case; values are JSON
ops products pause <key>                    # resume, archive
ops products pause-all                      # stops every active product at once
ops searches list
ops plan                                    # the call plan by line
```

Prices are integer cents, compared with the landed price (price plus shipping to DE). When a product is first activated, and whenever its search words, category or conditions change, listings created before that moment record a **baseline** and never alert; later listings do. Edits to must, exclude, price or alert fields keep the baseline.

## 3. Market value and limits

The worker reads the asking prices of each product's listings once a night (03:00 to 05:00 Berlin) and on demand, and computes a typical asking price per condition group it watches (method `mv-1`, ADR 0040). Only listings that pass the product's own rules count, fixed price, landed price with known shipping, at most 30 days old, newer ones weighted more.

- The product page's market box shows, per condition group: the typical asking price with the listing count and time, your limit, how sure (Reliable, Rough, Not enough listings, Out of date after 48 h), the listings under your limit right now with eBay links, and the details (middle half, precision, what was removed and why).
- **Check market value** asks for a snapshot now (about 1 eBay call; 5 per person a day, 20 extra snapshots a day in total). While it runs the box says "Checking".
- In "below the typical asking price" mode the limit is that percentage below the newest reliable value, never above your cap. With no reliable value from the last 7 days the limit is the cap, and the list, the product page and the email say "using your cap". In fixed mode the box says what share of the typical asking price your max is.
- Market snapshots stop before polls when the eBay quota runs low: the nightly run stops at 3,000 used units, extra snapshots at 2,500, polls at 3,500.
- For the imported drafts: compare each max with the typical asking price before activating, and switch to "below the typical asking price" where that fits better.

## 4. Category check

Normally from the form: **Suggest category** next to the category field runs one Browse search with the search words (about 1 eBay call, counted like an extra snapshot) and offers the top 5 categories with their names and match counts. The chosen name is stored on the product.

By hand, when the console is down: one call per check, counted in the shared quota. Prints only the total and the category distribution; no listing content is printed or kept.

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

# 3. The search: the product's search words and the category to check.
printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -fsS -K - --get \
  -H 'X-EBAY-C-MARKETPLACE-ID: EBAY_DE' --data-urlencode 'q=<search words>' -d category_ids=<id> \
  -d limit=1 -d fieldgroups=CATEGORY_REFINEMENTS https://api.ebay.com/buy/browse/v1/item_summary/search |
  jq '{total, categories: [.refinement.categoryDistributions[]? | {categoryId, categoryName, matchCount}]}'
unset token
```

Pass when the response names the expected category with `matchCount` above 0. Otherwise one more call without `category_ids` finds the dominant leaf; set it with `ops products set <key> category_id '"<id>"'` (the plan check applies). `api_usage_hourly` shows the calls under purpose `contract`.

## 5. Web console and sign-in

The console is the `web` service, on `127.0.0.1:3141` behind Traefik at `https://deals.intra-ai.de`. Only approved people get in: they ask for a code by email on `/login`, type it on `/login/code`, and get a session (24 h idle, 7 days at most) and a device cookie (180 days). Roles: **admin** (everything) and **editor** (products, deals and the budget; settings read-only; no People or Activity). Pages: Overview (`/`, open deals of the last 24 h first, refreshes every 60 s), Deals, Products, Budget, Settings, People and Activity (admins), Account (own sessions, sign out everywhere). Times are Europe/Berlin.

Before the v2 Traefik file is installed, or when the route is broken, reach it over a tunnel: `ssh -L 3141:127.0.0.1:3141 intra-ai`, then `http://127.0.0.1:3141/`.

**People.** On `/people` an admin adds a person (address and role), changes a role, ends someone's sessions or disables them; each needs a sign-in in the last 15 minutes. Disabling ends all sessions, revokes all devices and closes open codes at once. The last active admin cannot be demoted or disabled. Each change sends a security mail to the admins. From the CLI:

```sh
ops auth users
ops auth user add <email> admin             # or editor
ops auth user disable <email>
ops auth user set-email <old> <new>
ops auth sessions end <email>               # or --all, after a lost laptop or a mailbox takeover
ops auth unlock <email>                     # clears the failed tries that block new browsers for that address
```

**Recovery: reading a sign-in code out.** When sign-in mail is off or does not arrive, the person asks for a code on `/login` as usual; the code page shows a 4-character reference (for example `K7QF`). Ask them for that reference, then:

```sh
ops auth code <their address> --ref <reference>
```

It finds their open attempt from the last 10 minutes, prints its time, IP and user agent, asks "Is this you? [y/N]", and only then prints a code. Read a code out only to a person who tells you the reference shown on their own screen, and only when the time, IP and user agent fit. Without `--ref` it refuses. Every use is audited (`login_code_cli`) and mailed to the admins.

**Locked out.** After 10 wrong codes in 24 h for one address, browsers without a device cookie get no code for it; the owner's own browser (with its device cookie) still signs in, and so does `ops auth code --ref`. `ops auth unlock <email>` clears it. If no active admin is left at all, `ops migrate` (and so the next deploy) makes the `AUTH_BOOTSTRAP_ADMINS` addresses admins again; it never adds them while an active admin exists.

Sign-in and security events: `/activity` (admins), or `auth.auth_event` in Postgres. Logs (counts, codes and IDs only; no listing content):

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

### Sign-in mail (`LOGIN_SMTP_*`, v2)

The `web` service sends sign-in codes and security mail from its own mailbox, `noreply@intra-ai.de`, never from the alert mailbox: `web` must never hold the `info@` password (ADR 0038). Its five names are `LOGIN_SMTP_HOST`, `LOGIN_SMTP_PORT`, `LOGIN_SMTP_USER`, `LOGIN_SMTP_PASSWORD` and `LOGIN_FROM`, all set or all absent; a partial set stops `web` and `ebay-deploy`. With none set, no sign-in mail goes out and people sign in with `ops auth code <email> --ref <reference>` only.

Set them by prompt, like `ebay-set-smtp`, so the password never reaches the shell history or the screen. Install the helper once as `/usr/local/sbin/ebay-set-login-smtp` (`install -m 755 -o root -g root`):

```bash
#!/usr/bin/env bash
# Asks for the sign-in mailbox (noreply@intra-ai.de) and writes LOGIN_SMTP_* and LOGIN_FROM to
# /opt/ebay-sniper/.env (root 600). Replaces earlier lines of these five. Values are not echoed.
set -euo pipefail
f=/opt/ebay-sniper/.env
tmp=$(mktemp /opt/ebay-sniper/.env.XXXXXX)
trap 'rm -f "$tmp"' EXIT
lower() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
alert_user=$(grep -E '^SMTP_USER=' "$f" | cut -d= -f2- || true)
grep -vE '^(LOGIN_SMTP_HOST|LOGIN_SMTP_PORT|LOGIN_SMTP_USER|LOGIN_SMTP_PASSWORD|LOGIN_FROM)=' "$f" >"$tmp" || true
for v in LOGIN_SMTP_HOST LOGIN_SMTP_PORT LOGIN_SMTP_USER LOGIN_SMTP_PASSWORD LOGIN_FROM; do
  read -r -s -p "$v: " x
  echo
  [[ -n "$x" ]] || { echo "$v is empty, nothing written" >&2; exit 1; }
  [[ "$x" != *'$'* ]] || { echo "$v contains \$, which Docker Compose would misread; nothing written" >&2; exit 1; }
  if [[ "$v" == LOGIN_SMTP_USER && -n "$alert_user" && "$(lower "$x")" == "$(lower "$alert_user")" ]]; then
    echo "LOGIN_SMTP_USER is the alert mailbox; web must never hold its password; nothing written" >&2
    exit 1
  fi
  printf '%s=%s\n' "$v" "$x" >>"$tmp"
done
chown root:root "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$f"
trap - EXIT
echo "saved to $f"
```

Run `ebay-set-login-smtp` as root and answer the five prompts: the provider's SMTP host, `587` (STARTTLS), `noreply@intra-ai.de`, that mailbox's password, and `Just-Buy-It <noreply@intra-ai.de>` (unquoted, as for `ALERT_FROM`). It refuses an empty value, a `$`, and the alert mailbox as user, and writes nothing then. Check the names only (`grep -c '^LOGIN_' /opt/ebay-sniper/.env` prints 5), then recreate `web` and test with your own address:

```sh
dc up -d --no-deps --wait --wait-timeout 60 web
```

Open the sign-in page, ask for a code for your own address, and confirm the mail "Just-Buy-It sign-in code" arrives from `noreply@intra-ai.de` with the reference shown on the page. A sign-in mail that fails for good (two tries, 30 s apart) is recorded with the SMTP response code, never the address:

```sh
dc exec -T postgres psql -U ebay_sniper -d ebay_sniper -c \
  "SELECT at, detail->>'response_code' AS smtp FROM auth.auth_event WHERE event = 'login_mail_failed' ORDER BY at DESC LIMIT 5"
dc logs web --since 10m | grep -c security_mail_failed
```

After the test the query lists no new row and the count is 0. To switch sign-in mail off, delete all five lines and recreate `web` the same way. On a leak: change the password at the mail provider, run the helper again, recreate `web`.

## 7. Claude check

- **Model, effort and caps** are settings: **Settings** in the console (admins), or `ops settings list` and `ops settings set <key> <json>` (`claude.model`, `claude.effort`, `claude.daily_call_limit`, `claude.daily_spend_limit_usd`). Only (model, effort) pairs that passed the offline eval for the current prompt version are offered. A change applies to the next candidate without a restart; a candidate keeps the prompt version, model and effort it was handed with.
- **Ceilings:** `CLAUDE_DAILY_CALL_LIMIT` and `CLAUDE_DAILY_SPEND_LIMIT_USD` in `.env` (defaults 40 and USD 2 per Berlin day). The settings can only be lower; a stored value above the ceiling is clamped when a call is reserved and shown with a warning on Overview.
- **Switch off:** set `claude.daily_call_limit` to 0, or `CLAUDE_DAILY_CALL_LIMIT=0` in `.env` and recreate the worker (`dc up -d --no-deps --wait --wait-timeout 90 worker`). Alerts then say "Not checked by Claude: cap_reached" and no getItem is made; a product with "Only alert after Claude has checked it" holds its candidates instead, and the worker queues held ones under 12 h old again at 00:05 Berlin.
- **Rotate the key:** create a new key in the Anthropic Console, replace `ANTHROPIC_API_KEY` in `.env` and the password manager, recreate the worker as above, check that the next deal shows a Claude verdict, then delete the old key in the Console. Rotate after the live acceptance, and on any leak.
- Recommended: a Console workspace limit of USD 75 a month for this key.
- The offline eval set runs on your machine only, never in CI: `ANTHROPIC_API_KEY=... pnpm --filter @ebay-sniper/llm eval` with the key from the password manager in the shell, never in a file. A prompt change gives a new prompt version, and Settings offers nothing until the eval has run again.

## 8. When something goes wrong

| Sign | Meaning | Action |
|---|---|---|
| Overview Banner "Claude checks are paused"; log `screening_paused` | Anthropic refused the key (401/403). The Claude check is paused 15 minutes for all listings; alerts go out as "Not checked by Claude: paused" | Check the key and the workspace in the Console; rotate it (section 7). The pause ends by itself |
| Overview Banner "Alert emails are paused"; log `smtp_paused` | The mail server refused the login (535). All sends wait 15 minutes | Check `SMTP_USER` and `SMTP_PASSWORD`; fix `.env`, recreate the worker, run `mail:test`. Held deliveries under 6 h old go out after the pause |
| `poll_run` status `quota_refused`; log `quota_refused` | The eBay call reservation was refused; no request was made | Check the quota on `/budget`. The plan stays at or under 2,500 of 5,000 a day, so this means manual calls or a bug: `ops products pause-all` and compare `poll_run.calls` with `api_usage_hourly` |
| A save is refused with the plan numbers | The save would put the plan over 2,500 calls a day | Take the cheapest fix the form names (slower speed, no price-drop check), or pause another product |
| "last poll failed" for a search on Overview; `live-check` reports stale rows | A poll or sweep was killed mid-run (crash, OOM, a kill during deploy) | `dc ps worker`, `dc logs worker --since 1h`, `docker stats --no-stream`. The search is due again 5 minutes later; after 5 failed runs in a row it pauses 15 minutes by itself |
| Worker unhealthy | No heartbeat for 30 s: database not answering or pg-boss stopped | `dc logs worker --since 15m`; a pg-boss schema version error means a deploy mismatch: deploy the right SHA |
| `web` unhealthy, or `live-check` fails at web `/healthz` | The console is down; the worker and the deletion endpoint are not affected | `dc logs web --since 15m`; a role check error at start means a wrong `POSTGRES_WEB_PASSWORD`: fix `.env` and deploy again |
| A person gets no sign-in code | Sign-in mail is off, failed (`login_mail_failed` in `auth.auth_event`) or the address is locked | Section 5: `ops auth code --ref`, or `ops auth unlock` |
| Deliveries `failed` | 5xx from the mail server (for example 550), or 5 attempts used | Read `last_error_code` in `app.alert_delivery`; fix the cause; the alert itself is not re-sent |

## 9. Reminders

- **2027-01-15:** retention of `deletion_event` (1 y), `deletion_result_hourly` (90 d), `ebay_quota_window` (90 d), `api_usage_hourly` (1 y) and `audit_event` (1 y) is not built (ADR 0014 MVP note). The oldest rows are from 2026-10-19, so `ebay_quota_window` and `deletion_result_hourly` rows pass 90 days around 2027-01-17. Build that purge (Phase 1 S2) before then, or delete those rows by hand as the owner role and log it.
- After the live acceptance: rotate the Anthropic key; follow-up docs PR for `docs/compliance/gates.md` with the category IDs from section 4.
- 7 days after the v2 deploy (spec V9): remove `ops products import-legacy`. 30 days after it, once a rollback to Release 0 is no longer wanted: a contract migration that drops `app.feed`, `app.segment_rule` and the `dashboard` role, and with it `POSTGRES_DASHBOARD_PASSWORD`.
