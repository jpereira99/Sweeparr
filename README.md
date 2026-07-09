# Sweeparr

![CI](https://github.com/jpereira99/Sweeparr/actions/workflows/ci.yml/badge.svg)

**Close the loop on your media library.** Request → Acquire → Watch → Age → **Warn → Remove.**

Sweeparr is a single, lightweight, self-hosted microservice that watches your Jellyfin / Jellyseerr /
Sonarr / Radarr stack and *schedules* stale media for removal — visibly, reversibly, and on a grace
period — instead of silently nuking files. It never touches the filesystem directly; every deletion
goes through the Sonarr/Radarr APIs so your `*arr` state stays consistent.

> **Rules start disabled.** Create a rule, use the live preview to see what would match, then turn it
> on when you're ready. A global **System** toggle in Settings can pause all evaluation and deletions
> without touching individual rules.

---

## Design tenets

- **Visible before destructive.** Everything appears on an *Upcoming Removals* board with a countdown
  and a one-tap **Keep** long before anything is deleted. The grace period *is* the safety model — no
  approval-gate friction, just an easy veto window.
- **Two speeds of veto.** Admins choose whether household members can **request to keep** (admin
  approves), self-service **delay** the removal by a fixed number of days (automatic, no queue, capped
  per item), or both — whatever fits how hands-off you want to be.
- **Preview before enable.** Rules are created **off**. The condition builder shows a live preview
  (full match list) with no side effects until you explicitly enable a rule.
- **One system switch.** Pause the whole engine from Settings — no rules evaluate and nothing deletes
  while the system is paused.
- **Never touch the filesystem.** Deletions flow through Radarr/Sonarr (unmonitor → delete files →
  verify), with optional import-list exclusion so nothing silently re-downloads.
- **Auditable.** Every state transition, keep, and deletion is written to an append-only audit log.
- **Idempotent jobs.** The scheduler can crash, restart, and re-run without double-deleting.
- **One container, one volume.** SQLite (WAL) at `/config`. No external database, broker, or cache.

## Architecture

| Layer      | Tech |
|------------|------|
| Backend    | FastAPI · Uvicorn · SQLAlchemy 2 (async) · APScheduler · httpx · Pydantic v2 |
| Storage    | SQLite (WAL, single-writer) at `/config/sweeparr.db` |
| Frontend   | React 18 · Vite · Tailwind · TanStack Query · Recharts |
| Deploy     | One multi-stage Docker image, one `/config` volume |

The React SPA is built into `backend/static/spa` and served by the same FastAPI process, so there is
exactly one thing to run.

```
Jellyfin ─┐
Jellyseerr┤   adapters (retry · backoff · rate-limit · circuit-breaker)
Sonarr   ─┤ ─────────────►  sync jobs ──► SQLite ──► rule engine ──► lifecycle
Radarr   ─┘         │                            │                          │
                    │                            ▼                          ▼
              UserData / IDs              watch facts              SCHEDULED (grace)
                                                                         │
                                                          execute_deletions (paranoid path)
```

### Lifecycle states

`ACTIVE → SCHEDULED → DELETING → DELETED`, with `KEPT` (vetoed) and `ERROR` as off-ramps. TV is
handled at **season** granularity; movies as a whole.

### Sync jobs

| Job | Interval | What it does |
|-----|----------|--------------|
| `sync_radarr` | 45 min | Upsert movies from Radarr; refresh disk-usage gauges |
| `sync_sonarr` | 45 min | Upsert series/seasons from Sonarr; refresh disk gauges |
| `sync_jellyfin` | 45 min | Link Jellyfin IDs; pull per-user watch stats (`UserData`) |
| `sync_jellyseerr` | 30 min | Ingest request metadata |
| `aggregate_playback` | 15 min | Roll up playback sessions into watch facts |
| `evaluate_rules` | 8 h | Match enabled rules against the library |
| `execute_deletions` | 1 h | Delete units past grace (when system is on) |
| `notify` | 1 h | Reminder notifications |
| `sync_leaving_collection` | 1 h | Jellyfin "leaving soon" collection |
| `housekeeping` | 24 h | Prune old playback events |

On first boot with an empty library, Sweeparr automatically runs library syncs when Sonarr or Radarr
are configured. Saving an integration in **Settings** also triggers the relevant sync jobs
immediately.

## Quick start (Docker)

Using the prebuilt image from GHCR (fastest — no build step):

```bash
cp .env.example .env      # set session secret + admin password at minimum
docker compose -f docker-compose.ghcr.yml up -d
```

Or build from source:

```bash
cp .env.example .env      # set session secret + admin password at minimum
docker compose up -d --build
```

Open <http://localhost:8000>.

1. Sign in with the **local admin** credentials from `.env` (`SWEEPARR_ADMIN_USERNAME` /
   `SWEEPARR_ADMIN_PASSWORD`).
2. Go to **Settings → Connections** and enter your Jellyfin, Sonarr, Radarr, and Jellyseerr URLs and
   API keys. Click **Save** on each service — this probes the connection and runs an initial library
   sync.
3. Create rules under **Rules**, preview matches, then toggle a rule **on** when satisfied.

You can also sign in with **Jellyfin administrator** credentials once Jellyfin is configured.

## Local development

```bash
# from repo root — copy and edit env first
cp .env.example .env

# backend
cd backend
python3.12 -m venv ../.venv && ../.venv/bin/pip install -r requirements.txt
set -a && source ../.env && set +a
../.venv/bin/uvicorn app.main:app --reload --port 8000

# frontend (separate terminal; proxies /api to :8000)
cd frontend && npm install && npm run dev
```

Build the SPA into the backend static folder for production-like testing:

```bash
cd frontend && npm run build
```

## Configuration

### Environment variables (bootstrap only)

See [`.env.example`](.env.example). These are read at startup:

| Variable | Default | Purpose |
|----------|---------|---------|
| `SWEEPARR_TIMEZONE` | `America/New_York` | Schedule + countdown timezone |
| `SWEEPARR_SESSION_SECRET` | — | Signs session cookies (set a long random value) |
| `SWEEPARR_ADMIN_USERNAME` | `admin` | Local admin username (created on first boot only) |
| `SWEEPARR_ADMIN_PASSWORD` | `admin` | Local admin password (change after first login) |
| `SWEEPARR_{JELLYFIN,JELLYSEERR,SONARR,RADARR}_{URL,API_KEY}` | — | Optional: seed integrations into DB on first boot |
| `SWEEPARR_NTFY_URL` / `_TOPIC` | — | Optional: seed ntfy notification settings |

Integration URLs and API keys are stored in the **database** after first boot. The Settings UI is
the source of truth — env values only seed missing entries once. API keys are never returned in full
by the API (only `has_key: true`).

### Settings UI (runtime)

Managed in the admin **Settings** page and persisted in the `settings` table:

- **Connections** — Jellyfin, Jellyseerr, Sonarr, Radarr, ntfy (test + save per service)
- **System** — global on/off (`system_enabled`); when paused, no rules evaluate and nothing deletes
- **Keep & delay options** — toggle household **keep requests** and self-service **delay**
  independently, and set how many days each delay adds (`delay_days`) and how many times a single
  item can be delayed (`delay_max_count`)
- **Automatic protections** — independently toggle each *system* protection (Jellyfin favorites,
  airing series, the `sweeparr-keep` arr tag) and the recently-requested window
  (`request_protection_days`, in days; `0` disables it). These are the conditions that can push a
  matched unit to **KEPT** without any admin action — see [Safety model](#safety-model-in-one-paragraph).
- **Job schedules** — view next run time and manually trigger any sync or lifecycle job
- **Account** — change local admin password

## Authentication

| Method | Who | Notes |
|--------|-----|-------|
| Local admin | Username + password from `.env` | Bootstrapped on first run; password changeable in Settings |
| Jellyfin pass-through | Jellyfin admin users | Uses `/Users/AuthenticateByName`; requires Jellyfin configured |

The admin console is the only authenticated UI. Household members can still **request to keep** or
**self-delay** media via magic links (`/keep/:token`) surfaced in Jellyfin inject banners — no
separate login required. Which of those two actions are offered (and for how many days) is controlled
per-instance in **Settings → Keep & delay options**.

## Rules

Rules are **off by default**. Workflow:

1. **Create** — pick a preset (stale movies, never-played requests, etc.) or start blank
2. **Build** — condition tree with live preview (click preview to see the full match list)
3. **Enable** — schedules matching units for deletion after the grace period
4. **Disable** — reverts scheduled units back to `ACTIVE`
5. **Delete** — removes the rule and reverts its scheduled units

The rule engine evaluates against materialized **watch facts** (plays, last watched, completion %,
requester activity, disk pressure, tags, etc.). See `GET /api/v1/rules/catalog` for the full field
list.

## In-Jellyfin integration

- **"Leaving Soon" collection** — surfaced natively via the Jellyfin API.
- **Pills & banners** — drop the versioned inject script into your Jellyfin web client:

  ```html
  <script src="http://<sweeparr-host>:8000/static/inject/sweeparr.js"></script>
  ```

  It reads only public-safe fields from the cached `/flags` endpoint, renders a "Leaving <date>" pill
  plus a dismissible banner with **Request to keep** and/or **Delay N days** buttons (shown based on
  what's enabled in Settings), and fails silently on any Jellyfin DOM change. Delaying is instant — no
  admin approval, and no keep-request queue entry is created — while keep still routes through the
  admin approval queue.

## Safety model in one paragraph

Nothing is deleted the instant a rule matches. An **enabled** rule promotes matches to **SCHEDULED**
with a grace countdown visible on the dashboard, in Jellyfin, and via notifications. Two levers act on
a scheduled item, and they live on different layers:

- **Keep** is a protection-layer veto: an admin (directly, or by approving a household keep request)
  moves the unit to **KEPT** indefinitely, taking it out of the rule pipeline entirely. It stays kept
  until an admin **releases** it, which returns it to `ACTIVE` for normal evaluation. A *pending* keep
  request pauses deletion (execution hold) until the admin decides; a denied request simply leaves the
  item on its existing schedule.
- **Delay** is a scheduling-layer nudge: one capped, floor-setting mechanism shared by admins and
  Jellyfin users (no approval). It pushes `delete_at` out by `delay_days`, up to `delay_max_count`
  times, and the rule engine's disk-pressure logic can never pull a delayed item earlier than its
  floor. A delayed item stays **SCHEDULED**, so if it gets watched and the rule stops matching, the
  daily reconciliation self-heals it back to `ACTIVE`.

Only after the grace period — and only while the **system is running** — does `execute_deletions`
re-verify protections and call Radarr/Sonarr. The whole path is logged, including every keep, release,
and delay. Disabling a rule or pausing the system stops new scheduling; existing scheduled items can
still be kept, delayed, or manually unscheduled.

**KEPT isn't always an admin decision.** A matched unit can also land in KEPT because it currently
trips one of the *system* protections — a Jellyfin favorite, the latest season of an airing show, the
`sweeparr-keep` tag in Sonarr/Radarr, or a recent Jellyseerr request — each independently toggleable in
**Settings → Automatic protections**. Whenever this happens, every reason is written to the
`protection` table (not just logged) so the **Keeps** page can show exactly which condition(s) are
holding an item, distinguishing it from an indefinite admin keep. An hourly `lift_protections` job
re-checks every system-protected KEPT unit from scratch: the moment none of its reasons still apply
(unfavorited, tag removed, request window passed, series ended), it's automatically returned to
`ACTIVE` and the cleared reasons are written to the audit log. Admin keeps are never touched by this —
they're indefinite until explicitly **released**.

## API surface (selected)

```
GET  /healthz                          liveness + integration health + system state
GET  /api/v1/dashboard                 gauges, leaving-this-week, bytes-freed, health
GET  /api/v1/schedule                  upcoming removals board
POST /api/v1/units/{type}/{id}/keep    admin veto → KEPT (indefinite)
POST /api/v1/units/{type}/{id}/release admin unkeep → ACTIVE (re-enters evaluation)
POST /api/v1/units/{type}/{id}/restore undo: replay a unit's prior lifecycle snapshot
POST /api/v1/units/{type}/{id}/delay   admin delay (capped, sets floor; stays SCHEDULED)
GET  /api/v1/kept                      all KEPT units + full protection list per unit (admin or system)
POST /api/v1/keep-requests             household keep request (admin approves → indefinite keep)
POST /api/v1/delay/{token}             public, token-authed self-service delay (no approval, capped)
GET  /api/v1/rules · POST /rules/preview   rules CRUD + stateless preview
POST /api/v1/rules/{id}/enable|disable     turn a rule on or off
GET  /api/v1/rules/{id}/qc             rule quality-control diffs
GET  /api/v1/media                     library explorer (sortable columns)
GET  /api/v1/settings · PUT /settings  connections, system toggle, integrations
POST /api/v1/settings/test/{service}   probe a single integration
POST /api/v1/jobs/{name}/run           manually run a scheduled job
GET  /api/v1/history                   append-only audit log
GET  /flags?ids=...                    public, cache-friendly pill data for Jellyfin
GET  /api/v1/events                    SSE stream for live UI updates
POST /api/v1/auth/login                local admin or Jellyfin admin login
POST /api/v1/auth/change-password      update local admin password
```

## Project layout

```
backend/
  app/
    adapters/     jellyfin · jellyseerr · sonarr · radarr (base: retry/backoff/breaker)
    api/          dashboard · schedule · rules · media · keep · jobs · settings · flags · events · auth
    rules/        pure rule engine + field catalog
    services/     lifecycle · facts · sync · scheduler · notify · integrations · runtime · events
    models.py     SQLAlchemy schema      config.py  bootstrap settings      db.py  async engine + migrations
  static/
    spa/          built React app (generated)
    inject/       sweeparr.js  Jellyfin pill/banner script
frontend/
  src/pages/      Dashboard · Upcoming · Rules · QC · Explorer · KeepRequests · History · Settings · Login
  src/pages/user/ KeepDeepLink (magic-link keep flow)
  src/components/ StatusPill · Shell · Popover · Drawer · Toast · ui
design/          design doc, original spec export, decode helpers (dev-only)
.github/workflows/  CI (lint + build check) · publish (build & push to GHCR)
Dockerfile · docker-compose.yml · docker-compose.ghcr.yml · .env.example · LICENSE
```

## Upgrading

Sweeparr runs lightweight SQLite migrations on startup (`db.py`). Existing databases from older
versions are migrated automatically — legacy `CANDIDATE` units become `ACTIVE`, armed rules become
`enabled`, removed columns (`status`, `dry_run_since`) are dropped, and `delay_until`/`delay_count`
columns are added to media items and seasons to back the self-service delay feature (self-service
delay itself stays off — `delay_enabled: false` — until an admin turns it on in Settings).

## License

MIT — see [`LICENSE`](LICENSE).

## Credits

Favicon uses the broom graphic from [Twemoji](https://github.com/twitter/twemoji) (Copyright 2020
Twitter, Inc and other contributors), licensed under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/).
