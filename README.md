# Hearth

A self-hosted household finance app for two, built the way a financial planner would want it to work. It runs on a computer in your home, syncs your banks read-only through SimpleFIN, and gives both partners their own login with shared household totals.

**What sets it apart from typical budgeting apps**

- **Cash flow is counted correctly.** Credit card payments are transfers, not spending. Moving money to savings or investments counts as savings. Refunds reduce their category instead of showing up as income. Reimbursable expenses are excluded. Splits, pending-to-posted updates, and duplicates are all handled.
- **Flex budgeting with sinking funds.** Fixed bills, one "flex" number for day-to-day spending, and monthly set-asides for annual or irregular costs (insurance, holidays, car repairs), so those costs never blow up the month they land in.
- **An honest savings rate.** Paycheck modeling includes pre-tax 401(k), HSA, and employer match, which never appear in your bank account.
- **Made for couples moving from separate finances to joint.** Shared expenses get split 50/50, by income, or a custom share, with a settle-up balance between you. A merge-plan checklist and a "% spent through joint accounts" metric track the transition. Each partner's personal fun money stays private: the other sees only the total.
- **Planning, not just tracking.** A financial health scorecard, net worth change split into "what we saved" vs "what the markets did", a 60-day cash forecast with low-balance warnings, debt payoff (avalanche vs snowball), goals with ETAs, a retirement/FI projection, and a tax packet.
- **A monthly close ritual.** A guided "money date": review, reconcile, settle up, explain variances, fund sinking funds, plan next month, then lock the month.

> Benchmarks and projections in the app are common rules of thumb, labeled as such. They aren't personal financial advice.

---

## Quick start (Docker, recommended)

You need an always-on machine at home: a mini PC, NAS (Synology, Unraid, TrueNAS), Raspberry Pi 4/5, or an old laptop running Docker.

```bash
git clone <this repo> hearth && cd hearth
cp .env.example .env
# Put a long random value in APP_SECRET:
openssl rand -base64 48
nano .env
docker compose up -d --build
```

Open `http://<server>:3000`. The first visit walks you through:

1. **Create the household** and your login.
2. **Turn on two-factor authentication** (required before connecting banks).
3. **Invite your partner.** Settings → Household creates a one-time link valid for 7 days.
4. **Connect banks.** Create an account at [SimpleFIN Bridge](https://beta-bridge.simplefin.org) (about $15/year), connect your banks there, create a setup token, and paste it in Settings → Bank connections. Then fix each account's **type and owner** on the Accounts page (mine / partner's / joint). Ownership drives the couple features.
5. **Add paychecks** (Settings → Paychecks) from a recent pay stub.
6. **Add manual accounts**: your home, cars, and any loan SimpleFIN can't see.
7. **Set up the budget**: sinking funds first, then fixed bills, then flex. The plan pre-fills from your history.

**Before paying for SimpleFIN**, check that each of your banks is supported. For banks it can't reach, use Import (CSV, OFX, or QFX); column mappings are remembered per account.

### Reaching it from your phones: Tailscale

Don't expose Hearth to the internet. Use [Tailscale](https://tailscale.com) (free for personal use):

1. Install Tailscale on the server and on both phones, signed into the same tailnet.
2. On the server: `tailscale serve --bg 3000`. This gives you `https://<machine>.<tailnet>.ts.net` with a real HTTPS certificate.
3. Set `COOKIE_SECURE=true` in `.env` and run `docker compose up -d`.
4. On each phone, open that URL and choose **Add to Home Screen**. It installs like an app.

The compose file binds port 3000 to `127.0.0.1` only. If you'd rather reach it on your LAN without Tailscale, change that to `"3000:3000"`, and understand that anyone on your Wi-Fi can then reach the login page.

---

## Data, backups, and security

- **Everything lives in `./data`.** SQLite database plus encrypted backups.
- **Nightly encrypted backups** at 2:30am to `./data/backups` (AES-256-GCM, 30 daily + 12 monthly kept). **Copy that folder off the machine**, or a disk failure takes your history with it. Options: Synology Hyper Backup, `rclone sync ./data/backups remote:hearth`, or Syncthing to another device.
- **Restore:**
  ```bash
  docker compose stop hearth
  docker compose run --rm hearth node scripts/restore.mjs /data/backups/hearth-YYYY-MM-DD.db.gz.enc
  docker compose start hearth
  ```
  The current database is moved aside, not deleted.
- **Keep `APP_SECRET` and `BACKUP_PASSPHRASE` in a password manager.** The SimpleFIN access URL and 2FA secrets are encrypted with `APP_SECRET`, and backups with `BACKUP_PASSPHRASE` (or `APP_SECRET` if that's unset).
- **Security model:** argon2id password hashes, required TOTP 2FA, httpOnly session cookies, login throttling, an audit log of every change, read-only bank access (SimpleFIN can't move money), and CSV exports protected against spreadsheet formula injection.
- **Export anytime** from Settings → Data: all transactions as CSV, or everything as JSON. Secrets are never included.

## How syncing works

- A daily sync runs at 6:15am in the household time zone. You can also click "Sync now" in Settings → Bank connections (limited to once an hour, because SimpleFIN caps daily requests and most banks only update once a day anyway).
- The first sync pulls 90 days. To go back further, import older statements; overlapping rows are flagged as possible duplicates, never silently dropped.
- Pending transactions are replaced when they post, and your edits carry over.
- Transfers between your accounts are matched automatically. Ambiguous matches (like partner-to-partner Venmo) show up as suggestions for you to confirm.
- Categorization runs in this order: your rules, then the last category you picked for that merchant, then the bank's category, then starter rules for common merchants.

## Using it well

- **Weekly (5 min):** each of you clears your own review queue (Transactions → To review).
- **Monthly (20 min, together):** Monthly close. Update the home and car values, settle up, talk through the variances, record sinking-fund set-asides, plan next month, then close.
- **Yearly:** audit subscriptions (Recurring page), check the IRS contribution limits in Settings → Data, and download the tax packet (Reports).

---

## Development

```bash
npm install
cp .env.example .env.local      # set APP_SECRET
npm run dev                     # http://localhost:3000
npm test                        # 62 unit + integration tests (accounting engine, sync pipeline, TOTP, backups)
npm run lint                    # type check

# Demo household with 12 months of realistic data:
DATA_DIR=./data-demo npm run seed:demo
DATA_DIR=./data-demo npm run dev   # login alex@demo.local / demo-password-123

# End-to-end browser test against a server on an EMPTY database:
DATA_DIR=/tmp/hearth-e2e DISABLE_JOBS=1 npm start -- -p 3200 &
BASE=http://localhost:3200 npm run test:e2e
```

**Architecture**

- `src/domain/`: pure TypeScript financial engine with no I/O: the ledger and classification, transfers, dedupe, rules, budget, sinking funds, couple/settle-up, recurring, forecast, debt, goals, net worth attribution, income/savings rate, scorecard, tax. It's fully unit-tested with hand-checked numbers.
- `src/server/`: auth, ingest pipeline, SimpleFIN sync, insights (composes the domain modules over DB data), alerts, scheduler, backups, server actions.
- `src/integrations/`: SimpleFIN client (per the [published protocol](https://github.com/simplefin/simplefin.github.com/blob/master/protocol.md)) and CSV/OFX parsers.
- `src/app/`: Next.js App Router pages (server-rendered, minimal client JS).
- `src/db/`: Drizzle schema for SQLite. Migrations live in `drizzle/` and run on startup.

**Known limitations**

- USD only.
- The SimpleFIN protocol doesn't define account types or investment holdings. Types are guessed from account names (you confirm them), and investment accounts are tracked by balance. Net-worth attribution splits investment contributions from market moves using transfer and contribution transactions.
- Retirement projection is deterministic (no Monte Carlo yet).
- Alerts show in the app. Email and push delivery aren't wired up yet.
