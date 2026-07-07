# Sweeparr — Media Lifecycle & Statistics Microservice
### Design Document / North Star — v1.1

> **v1.1 changes:** Name locked as **Sweeparr**. Per-season TV deletion promoted into v1. Confirmation model reworked: rules auto-schedule; the review surface is post-hoc QC, not an approval gate. Arr-tag mirroring confirmed as optional flag (off by default). Auth confirmed as Jellyfin credential pass-through (Jellyseerr-style) for all tiers.

---

## 1. Vision

A single, lightweight, self-hosted microservice that closes the loop on the media lifecycle:

**Request → Acquire → Watch → Age → Warn → Remove**

Jellyseerr handles *request*, Sonarr/Radarr handle *acquire*, Jellyfin handles *watch*. Nothing in the stack owns *age → warn → remove* holistically. Jellysweep, Maintainerr, and Jellystat each cover a slice; Sweeparr amalgamates the slices you actually want into one service tuned for your stack:

1. **Observe** — ingest Jellyseerr requests, Jellyfin playback activity, and Sonarr/Radarr library state into a local SQLite database (own your stats; no Jellystat dependency).
2. **Decide** — evaluate user-defined rules against that data to nominate content for removal.
3. **Schedule** — every nomination enters a visible, cancellable schedule with a grace period. Nothing is ever deleted as a surprise.
4. **Warn** — surface upcoming removals *inside Jellyfin* (banners/pills + a "Leaving Soon" collection) and via notifications.
5. **Remove** — execute deletions exclusively through Sonarr/Radarr APIs, fully audited, with dry-run as the default posture.

### Design tenets (the actual north star)

- **Nothing is deleted that wasn't visibly scheduled first.** The scheduler is the single gate; there is no code path from "rule matched" straight to "file gone."
- **Dry-run is the default state.** Deletion execution is opt-in per library and globally kill-switchable.
- **Never touch the filesystem.** All removals go through Sonarr/Radarr (`deleteFiles=true`), which respects their recycle-bin settings and keeps their state consistent. Jellyfin is only ever told to rescan.
- **One container, no sidecars.** FastAPI serves the API, runs the scheduler, and serves the built React SPA as static files. SQLite in WAL mode. No Redis, no Postgres, no worker containers — same resource-minimal philosophy as the Matcharr plugin decision.
- **Everything is auditable.** Every state transition (nominated, scheduled, protected, kept, deleted) is a row in an audit table with the rule and data snapshot that caused it.
- **Idempotent jobs.** Every scheduled job can crash mid-run and re-run safely. Sync jobs upsert; the deletion executor checks live state before acting.

### Non-goals (scope fences)

- Not a request manager (Jellyseerr stays), not a downloader/organizer (Sonarr/Radarr stay), not a full analytics suite (borrow Jellystat's *useful* stats, skip vanity dashboards).
- No Plex/Emby support. Jellyfin-only keeps every integration concrete.
- No multi-server federation, no Postgres option, no plugin marketplace. One homelab, one NAS, one DB file.
- Music/books out of scope for v1 (movies + series only).

---

## 2. Prior art — what to take, what to skip

| Project | Take | Skip |
|---|---|---|
| **Jellysweep** | Lifecycle model (mark → grace period → delete), per-library filters (age / last-stream / size / exclusion tags), disk-usage-adaptive grace periods, "Leaving Soon" Jellyfin collections, user keep-requests with admin approval, companion Jellyfin plugin that injects JS to badge marked items, dry-run-first culture | Go/templ stack, Sonarr/Radarr *tags as the state store* (state lives in your DB instead; tags become an optional mirror), Valkey/Redis cache layer |
| **Maintainerr** | The **rule builder** UX: composable condition groups (AND/OR) over cross-service fields, multiple independent rule sets per library, "collection as staging area" mental model | Plex orientation, NestJS + separate frontend container weight |
| **Jellystat** | Local playback-history ownership: record sessions yourself from Jellyfin so stats survive Jellyfin's own retention quirks; watch-time and last-played per item/user | Full analytics UI breadth, Postgres requirement |

Notably, Jellysweep already validates your banner idea: its companion plugin <cite index="2-1">adds an indicator to media items in Jellyfin when they're marked for deletion, and works by injecting custom JavaScript into Jellyfin's web interface</cite>. Section 8 designs the same mechanism against Sweeparr's API.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Sweeparr container                        │
│                                                              │
│  ┌──────────────┐   ┌───────────────────────────────────┐  │
│  │  React SPA   │   │  FastAPI                          │  │
│  │  (built by   │◄──┤   /api/v1/*     REST + SSE        │  │
│  │  Vite, served│   │   /flags        (Jellyfin plugin) │  │
│  │  as static)  │   │   /webhooks/*   (Jellyfin events) │  │
│  └──────────────┘   └───────┬───────────────────────────┘  │
│                             │                                │
│  ┌──────────────┐   ┌───────▼───────────┐  ┌────────────┐  │
│  │  APScheduler │──►│  Service layer    │◄─┤ Rule engine│  │
│  │  (async, in- │   │  sync / evaluate /│  └────────────┘  │
│  │  process)    │   │  notify / execute │                   │
│  └──────────────┘   └───────┬───────────┘                   │
│                             │                                │
│                    ┌────────▼────────┐                       │
│                    │ SQLite (WAL) +  │                       │
│                    │ SQLAlchemy      │                       │
│                    └────────┬────────┘                       │
└─────────────────────────────┼────────────────────────────────┘
                              │ httpx async clients (adapters)
        ┌──────────┬──────────┼──────────┬─────────────┐
        ▼          ▼          ▼          ▼             ▼
    Jellyfin   Jellyseerr   Sonarr    Radarr     ntfy/webhook
```

**Stack (fixed per your requirements):**

- **Backend:** FastAPI + Uvicorn, SQLAlchemy 2.x (async) + Alembic migrations, **APScheduler 3.x** (AsyncIOScheduler with SQLAlchemyJobStore so schedules survive restarts), httpx for all outbound calls, Pydantic v2 models everywhere (settings via pydantic-settings).
- **Database:** SQLite, WAL mode, `busy_timeout` set, single writer discipline (see §11).
- **Frontend:** React 18 + Vite + Tailwind. TanStack Query for server state, TanStack Table for grids, a lightweight chart lib (Recharts) for stats. Built output copied into the image and served by FastAPI `StaticFiles` — one port, one container, plays perfectly with a Cloudflare Tunnel subdomain.
- **Deploy:** single multi-stage Dockerfile (node build stage → python runtime stage), one volume for `/config` (SQLite DB + settings).

**Integration adapters** (one thin module each, uniform interface):

| Adapter | Reads | Writes |
|---|---|---|
| Jellyfin | Items, libraries, users, sessions (poll) or Webhook plugin events (push), item UserData (played/favorite) | Library refresh, collection create/update, item tag (optional) |
| Jellyseerr | Requests (`/api/v1/request`), users (for requester identity + notification email) | Nothing (read-only) |
| Sonarr | Series, episodes, episode files, tags, disk space, quality profiles | Delete series/episode files, unmonitor, add/remove tags |
| Radarr | Movies, movie files, tags, disk space | Delete movie (+files), unmonitor, add/remove tags |

Every adapter: bearer/X-Api-Key auth from settings, retry with exponential backoff + jitter, per-service rate limiting (semaphore), circuit breaker (mark integration unhealthy after N failures and surface in UI), and a `test()` method wired to a "Test connection" button.

---

## 4. Identity — the canonical media table

The hardest unglamorous problem: the *same movie* is a Radarr movie, a Jellyfin item, and a Jellyseerr request. Everything else in the system depends on stitching these together correctly.

**Join strategy, in priority order:**

1. **Provider IDs** — TMDB ID (movies, and Jellyseerr uses TMDB for both types), TVDB ID (series). Jellyfin exposes `ProviderIds` per item; Sonarr/Radarr expose `tvdbId`/`tmdbId`/`imdbId`; Jellyseerr requests carry `tmdbId`/`tvdbId`.
2. **IMDB ID** fallback.
3. **Path matching** (Radarr/Sonarr file path vs Jellyfin item path) as a last resort — flag these matches as `low_confidence` in the UI rather than silently trusting them.

Maintain a `media_item` table as the hub; all stats, requests, rules, and schedules reference `media_item.id`, never a service-specific ID directly. Items that exist in Jellyfin but not in Sonarr/Radarr (manually placed files) are tracked but marked `unmanaged` — rules can see them, but the executor refuses to delete them (nothing to delete them *through*).

**Series granularity — seasons are first-class in v1.** Whole-series removal is too blunt; the deletable unit for TV is the **season**. This shapes three layers:

- **Schema:** a `season` table sits between `media_item` (series) and `episode_file`, and seasons carry their *own* lifecycle state and `delete_at` — a series can simultaneously have S1 ACTIVE, S2 SCHEDULED, and S3 KEPT. Movies remain single-unit items; internally, treat "deletable unit" as the polymorphic target (movie | season) so the state machine, scheduler, calendar, banners, and audit log all operate on one concept.
- **Facts:** watch facts aggregate at both levels. Season-level facts (`season_last_watched_days`, `pct_season_watched`, `season_size_gb`, `season_age_days` from newest episode-file date) feed season rules; series-level facts remain for series-wide signals (`series_status`, `is_favorite_any_user`, requester linkage — Jellyseerr requests attach to the series/season per the request payload).
- **Sonarr reality check:** Sonarr has no single "delete season" endpoint. Season deletion = (1) set the season `monitored=false` via series update **first** (crash-safety: an unmonitored season can't re-grab), then (2) bulk-delete its episode files (`DELETE /api/v3/episodefile/bulk`), then (3) verify the season's file list is empty. The series record stays in Sonarr, so metadata, tags, and future re-requests keep working. Jellyfin then shows the season gone after the scoped refresh.

Rules can still target whole series (a series rule expands to "all seasons" at scheduling time — each season gets its own schedule row, so partial vetoes work naturally: keep S1, sweep the rest).

---

## 5. Data collection

### 5.1 Library sync (pull, scheduled)

Jobs `sync_radarr`, `sync_sonarr`, `sync_jellyfin` run every 30–60 min (configurable) and upsert:

- From **Radarr/Sonarr**: title, provider IDs, path, monitored, tags, quality, `movieFile`/`episodeFile` sizes, `dateAdded` (this is your authoritative "content age" clock), root folder.
- From **Jellyfin**: item ID mapping, library membership, `DateCreated`, per-user `UserData` (`Played`, `PlayCount`, `LastPlayedDate`, `IsFavorite` — favorites become a built-in protection signal), runtime.
- Disk usage per root folder from Sonarr/Radarr `diskspace` endpoints (avoids Jellysweep's requirement of mirror-mounting media paths into the container — one less TrueNAS dataset mapping to keep in sync).

Sync is **upsert + tombstone**: items that vanish from a service get `deleted_externally=true` rather than a row delete, so history/stats survive.

### 5.2 Playback tracking (push preferred, poll fallback)

You want to *own* watch statistics rather than depend on Jellystat. Two ingestion paths, both writing to the same `playback_event` table:

1. **Preferred — Jellyfin Webhook plugin** pointed at `POST /webhooks/jellyfin` with PlaybackStart / PlaybackProgress / PlaybackStop events. Near-zero cost, real-time.
2. **Fallback/backstop — Sessions poll** (`/Sessions`) every 60–120 s, diffed against known active sessions. Covers webhook misconfiguration/outages and lets first-run work with zero Jellyfin-side setup.

From raw events, a small aggregator job materializes `playback_session` rows (user, item, start, end, seconds watched, max position %) and rolls up per-item facts the rule engine actually consumes: `last_watched_at` (any user), `total_plays`, `distinct_watchers`, `max_completion_pct`, `watched_by_requester` (join against Jellyseerr requester). Also merge Jellyfin's own `LastPlayedDate` UserData as a floor, so history from *before Sweeparr existed* isn't invisible — critical, otherwise on day one everything looks "never watched" and (depending on rule direction) either everything or nothing becomes a candidate. **Cold-start rule: an item can't be nominated by watch-based rules until Sweeparr has ≥ N days (default 30) of observation or imported UserData for it.**

### 5.3 Jellyseerr request sync

Job `sync_jellyseerr` pages through `/api/v1/request`, upserting: requester (Jellyseerr user id + linked Jellyfin user id + email), request date, status, media (tmdb/tvdb id → join to `media_item`). This yields the signals rules care about:

- `requested_by` / `requested_at` — enables "requested content is protected for X days" and "notify the requester before their item is removed."
- `requester_watched` — the sharpest removal signal you'll have: *requested 8 months ago, requester finished it 6 months ago, nobody else has touched it.*
- Requester inactivity — "requested by a user who hasn't streamed anything in 90 days" (Jellyseerr user list + your playback data).

---

## 6. Rule engine

Maintainerr's best idea, rebuilt lean. A **rule set** = library scope + condition tree + action policy.

### 6.1 Condition tree

JSON-serialized boolean tree — groups with `AND`/`OR` operators containing conditions or nested groups:

```json
{
  "op": "AND",
  "conditions": [
    {"field": "age_days",          "cmp": ">=", "value": 180},
    {"field": "last_watched_days", "cmp": ">=", "value": 90},
    {"op": "OR", "conditions": [
      {"field": "size_gb",              "cmp": ">=", "value": 15},
      {"field": "max_completion_pct",   "cmp": ">=", "value": 85}
    ]}
  ]
}
```

**Field catalog (v1):**

| Category | Fields |
|---|---|
| Age | `age_days` (Sonarr/Radarr dateAdded), `release_age_days` |
| Watch | `last_watched_days`, `total_plays`, `distinct_watchers`, `max_completion_pct`, `watched_by_requester`, `is_favorite_any_user` |
| Request | `was_requested`, `requested_days_ago`, `requester_inactive_days` |
| File | `size_gb`, `quality`, `video_resolution` |
| Series-level | `series_status` (ended/continuing), `pct_episodes_watched` (whole series) |
| Season-level | `season_age_days`, `season_last_watched_days`, `pct_season_watched`, `season_size_gb`, `season_number`, `is_latest_season` |

TV rule sets declare a **target**: `season` (default — conditions evaluate per season, mixing season- and series-level fields) or `series` (matches expand to per-season schedules at scheduling time). `is_latest_season` exists so the obvious guardrail — "never sweep the newest season of a continuing show" — is one condition, not a workaround.
| Tags | `has_tag` / `not_has_tag` (Sonarr/Radarr tags) |
| Context | `disk_usage_pct` (root folder), `library` |

Evaluation is pure Python over the local DB — no live API calls during evaluation, so it's fast, deterministic, and testable. Ship a `preview` endpoint: given a rule set (even unsaved), return the matching items *right now*. **The UI must make preview unavoidable before enabling a rule.**

### 6.2 Action policy (per rule set)

- `grace_days` — base grace period between scheduling and deletion (e.g. 30).
- `disk_pressure_overrides` — Jellysweep-style tiers: `[{usage_pct: 85, max_grace: 14}, {usage_pct: 92, max_grace: 5}]`. Applied at evaluation time *and* re-checked daily against already-scheduled items (pressure can shorten an existing schedule; it never lengthens one automatically).
- `status` — `draft` → `dry_run` → `armed` (see §7.1). New/edited rules always land in `dry_run`; arming is an explicit action that shows the current candidate set one last time before confirming.
- `notify_requester`, `notify_admin` toggles (armed rules only — dry-run never notifies end users).
- `mirror_arr_tags` (global setting, **off by default**) — when on, Sweeparr writes an informational `sweeparr-scheduled-YYYY-MM-DD` tag to the Sonarr/Radarr item while SCHEDULED and removes it on any exit from that state. Strictly a one-way visibility flag for the arr UIs; the DB remains the sole source of truth and nothing ever *reads* these tags (the exclusion tag from §6.3 is the only tag Sweeparr reads).

### 6.3 Protection (hard vetoes — evaluated before any rule)

A protected item cannot be nominated no matter what rules say:

1. Exclusion tag in Sonarr/Radarr (e.g. `sweeparr-keep`) — power-user escape hatch that works from the arr UIs you already live in.
2. Jellyfin favorite by any user (configurable).
3. Approved **keep request** (per-item, with optional expiry — "keep for another 90 days").
4. Request protection window — requested in the last N days.
5. Actively airing/monitored series (configurable).
6. `unmanaged` items (no arr counterpart).

Protection reasons are stored and displayed — "why is this item still here" must be answerable in one click, same as "why is this leaving."

---

## 7. Lifecycle state machine + scheduler

### 7.1 States

```
            rule match (armed rule)
  ACTIVE ───────────────────────────► SCHEDULED
    ▲                                     │
    │   rules stop matching               │ grace elapses
    │◄────────────────────────────────────┤
    │                                     ▼
    │                                 DELETING ──► DELETED
    │      keep approved / protection gained │
    └───────────────────◄──────── KEPT ◄─────┘ (veto any time before execute)

  (dry-run rule match) ──► CANDIDATE   — shadow state, never promotes on its own
```

- **No approval gate.** An *armed* rule schedules matches directly — the grace period **is** the human window, made unmissable by the calendar, the Jellyfin banners, and the notification ladder. Manual per-item approval doesn't scale and rots into rubber-stamping; visibility + easy veto is the QC model instead.
- **CANDIDATE** is the *dry-run shadow state*: items a dry-run rule would have scheduled, holding `matched_rule_id` + a JSON snapshot of the field values that matched (audit gold). Candidates are pure observability — they never promote, never notify users, never touch collections. They exist so a new rule can bake in dry-run and you can judge its blast radius over days/weeks of real library drift, not just the instant of the preview.
- **Rule lifecycle around this:** *draft* (preview only) → *dry-run* (produces CANDIDATEs, appears in QC views) → *armed* (produces SCHEDULEDs). New and edited rules always re-enter dry-run.
- **SCHEDULED**: has a concrete `delete_at` timestamp on the deletable unit (movie or season). This feeds the calendar UI, the Jellyfin banners, and requester notifications. If the underlying rules stop matching (someone rewatched it), a daily reconciliation job demotes it back to ACTIVE automatically — schedules must be self-healing, not sticky.
- **KEPT**: veto applied. Records who/why/until-when.
- **DELETING → DELETED**: executor claimed it (see 7.3), then confirmed removal.

### 7.2 Scheduler jobs (APScheduler)

| Job | Default cadence | Purpose |
|---|---|---|
| `sync_sonarr` / `sync_radarr` / `sync_jellyfin` | 30–60 min | Library upserts |
| `sync_jellyseerr` | 30 min | Requests + users |
| `poll_sessions` | 90 s | Playback fallback (skipped if webhook events are flowing) |
| `aggregate_playback` | 15 min | Events → sessions → per-item facts |
| `evaluate_rules` | 6–12 h | Armed rules → schedules, dry-run rules → candidates; apply disk-pressure grace adjustments; demote units that no longer match |
| `execute_deletions` | hourly | Delete SCHEDULED items whose `delete_at` has passed (respecting dry-run + kill switch) |
| `notify` | hourly | Grace-period reminders (T-14/T-7/T-1 style ladder), admin digests |
| `sync_leaving_collection` | hourly | Reconcile the Jellyfin "Leaving Soon" collection with SCHEDULED items |
| `housekeeping` | daily | Prune old events per retention policy, VACUUM/ANALYZE, health snapshot |

All jobs: `max_instances=1`, `coalesce=True`, `misfire_grace_time` set — a NAS reboot must not cause a thundering herd or double execution. Job runs land in a `job_run` table (started/finished/status/summary) surfaced on a scheduler page with per-job "Run now" and pause toggles (the Jellysweep scheduler panel pattern).

### 7.3 Deletion executor — the paranoid path

For each due item, in order:

1. Global kill switch off? Originating rule still `armed`? Unit still SCHEDULED (row-level claim: `UPDATE ... SET state='DELETING' WHERE id=? AND state='SCHEDULED'` — the returning-rowcount check makes double-execution impossible even if two loops overlap)?
2. **Re-verify protections against live data** (fresh favorite? new keep request? re-request in Jellyseerr? watched yesterday per latest events?). Any hit → demote to KEPT/ACTIVE with reason, notify admin.
3. Delete via arr API, per deletable unit:
   - **Movie:** Radarr `DELETE /api/v3/movie/{id}?deleteFiles=true&addImportListExclusion={cfg}`.
   - **Season:** Sonarr three-step — set season `monitored=false` (series update) **first**, so a crash mid-operation can't trigger a re-grab; then `DELETE /api/v3/episodefile/bulk` with that season's file IDs; then re-fetch and verify the season has zero files. The series record is left intact (metadata, tags, and re-requests keep working). If *every* season of an ended series ends up swept, optionally prompt (never auto-execute) full series removal as housekeeping.
4. Confirm the arr no longer lists the file(s); trigger a scoped Jellyfin library refresh.
5. Write audit row (bytes freed, rule, timestamps), remove from Leaving Soon collection, send post-deletion notifications.
6. Any step fails → state `ERROR`, alert admin, never auto-retry destructive steps without a human ack.

`addImportListExclusion` matters: without it, a deleted movie on a Radarr import list quietly comes back. Make it a per-rule setting (default on) and document the interplay with Jellyseerr re-requests (excluded items should still be re-requestable — verify behavior during implementation; this is a known sharp edge).

---

## 8. In-Jellyfin banners & pills

The "perfect solution" feature. There is no supported Jellyfin server API for injecting UI chrome onto item pages, so this is a two-layer strategy — a native layer that works on **every client**, and an enhanced layer for the web UI.

### 8.1 Layer 1 (all clients): "Leaving Soon" collection — native, zero hacks

`sync_leaving_collection` maintains one or two Jellyfin collections ("Leaving Soon — Movies/TV") whose membership mirrors SCHEDULED state. Optionally pin them to home screen rows via library settings. Works on Android TV, Swiftfin, Roku, everything — because it's just a collection. This is the reliability floor and validated by Jellysweep's implementation of the same idea.

Optional add-on: write the deletion date into the item as a Jellyfin **tag** (`leaving-2026-08-04`). Tags render on item detail pages in most clients — a poor man's pill with zero injection. Make it a toggle; some people hate metadata mutation (it also survives in backups/exports, so default off).

### 8.2 Layer 2 (web client): script injection for real pills

Jellyfin's web client can load custom JS (via the long-standing index.html injection approach or a small companion plugin — Jellysweep ships exactly such a plugin, which is proof the pattern is viable and maintained). The script:

1. Observes navigation (MutationObserver on the web client's SPA view changes) and extracts the current item ID(s) — detail pages and library card grids.
2. Batches `GET {sweeparr}/api/v1/flags?jellyfin_ids=a,b,c` — a **public-read, CORS-enabled, aggressively cached** endpoint returning only non-sensitive data:
   ```json
   {"items": [{"jellyfin_id": "abc", "delete_at": "2026-08-04",
               "reason_public": "Not watched in 6+ months",
               "keep_request_url": "https://sweeparr.example.com/keep/abc"}]}
   ```
3. Renders: a small pill on cards (`Leaving Aug 4`) and a dismissible banner on detail pages with the reason and a **"Request to keep"** link into Sweeparr (deep-link straight to a pre-filled keep-request form; auth via Jellyfin SSO so users don't face a login wall).

**Honest constraints to design around:** injection only affects the web UI (and wrappers around it) — native apps never see it; the DOM you're hooking is unstable across Jellyfin releases, so the script must fail *silently and completely* (a broken selector must never break playback UI); and the `/flags` endpoint must be rate-limited and unauthenticated-by-design with only public-safe fields (it will be fetched from every browser session, through your Cloudflare Tunnel). Ship the script versioned and served by Sweeparr itself (`/static/inject/sweeparr.js`) so updating the container updates the injection.

### 8.3 Notification ladder (completes the warning story)

- **Requester-targeted:** "The movie you requested leaves in 14 days" — email via Jellyseerr's stored user email, and/or ntfy topic. Fires at configurable T-minus points.
- **Admin:** weekly digest (what got nominated, what's due this week, bytes to be freed) + immediate alerts on executor errors.
- Channel abstraction: `ntfy` first (you're homelab-native), SMTP second, generic webhook third (covers Discord/Gotify/etc. without bespoke integrations).

---

## 9. Statistics (the Jellystat-lite you keep)

Stats exist to serve two masters: the rule engine (already covered) and your curiosity. UI-facing stats, all computable from `playback_session` + `media_item`:

- Per-item: play history timeline, watchers, completion, size vs. watch-seconds ("cost per watched hour" — a brutal and delightful sort key for finding 60 GB remuxes watched once at 12%).
- Per-user: activity recency, request-to-watch conversion rate (who requests and never watches — feeds `requester_inactive_days` and makes admin conversations easier).
- Library: size over time, bytes freed by Sweeparr (cumulative — the dopamine chart), disk usage vs. thresholds.
- Retention: raw `playback_event` rows pruned after N days (default 90); `playback_session` and per-item facts kept indefinitely (they're tiny).

---

## 10. Data model (SQLite, core tables)

```
media_item        id, type(movie|series), title, year, tmdb_id, tvdb_id, imdb_id,
                  jellyfin_id, sonarr_id|radarr_id, library, path, size_bytes,
                  quality, resolution, date_added_arr, date_created_jf,
                  monitored, unmanaged, deleted_externally, match_confidence,
                  updated_at
                  -- movies also carry the lifecycle columns below

season            id, media_item_id, season_number, monitored, size_bytes,
                  episode_count, newest_file_date, jellyfin_season_id

-- lifecycle columns (on media_item for movies, on season for TV — the
-- "deletable unit"): state(ACTIVE|CANDIDATE|SCHEDULED|DELETING|DELETED|
-- KEPT|ERROR), delete_at, matched_rule_id, match_snapshot(json)

episode_file      id, season_id, episode, sonarr_file_id, size_bytes,
                  air_date, jf_id
arr_tag           media_item_id, tag                              (mirror, read-mostly)
request           id, media_item_id, jellyseerr_id, requester_user_id,
                  requested_at, status
user              id, jellyfin_id, jellyseerr_id, name, email, is_admin,
                  last_active_at
playback_event    id, raw(json), user_id, jellyfin_item_id, kind, ts   (pruned)
playback_session  id, user_id, media_item_id, episode_file_id?, started_at,
                  ended_at, seconds_watched, max_position_pct
item_watch_facts  media_item_id, last_watched_at, total_plays, distinct_watchers,
                  max_completion_pct, watched_by_requester        (materialized)
rule_set          id, name, library, status(draft|dry_run|armed), target
                  (movie|season|series), conditions(json), grace_days,
                  disk_overrides(json), notify_flags, sort_order

season_watch_facts season_id, last_watched_at, total_plays, distinct_watchers,
                  pct_season_watched                              (materialized)
keep_request      id, unit_type(movie|season), unit_id, user_id, reason, status(pending|approved|
                  denied), expires_at, decided_by, decided_at
protection        unit_type, unit_id, kind(tag|favorite|keep|request_window|airing),
                  detail, expires_at
audit_log         id, ts, media_item_id?, actor(system|user_id), action,
                  detail(json)                                     ← append-only
job_run           id, job_name, started_at, finished_at, status, summary(json)
notification      id, ts, channel, target, subject, status, media_item_id?
settings          key, value(json)   (+ .env for secrets/API keys)
```

Indexes on every foreign key, `media_item(state, delete_at)`, `playback_session(media_item_id, ended_at)`, and the three provider-ID columns.

---

## 11. Implementation guardrails (keep-open-while-coding list)

**SQLite discipline**
- WAL mode + `synchronous=NORMAL` + `busy_timeout=5000` at connection setup; foreign keys ON.
- One process, but async app + scheduler = concurrent writers. Route all writes through short transactions; keep API reads on separate sessions; never hold a session across an `await` to an external HTTP call.
- Alembic from commit one — you will migrate this schema a dozen times.
- Nightly DB backup job (simple `VACUUM INTO` to the config volume) — this DB *is* your watch history; unlike everything else it is not reconstructible from the other services.

**External API hygiene**
- Page everything (Jellyfin `/Items` with `startIndex/limit`; Jellyseerr `take/skip`). Ask only for fields you need (`fields=` params) — Jellyfin item payloads are huge by default.
- Treat all three arr/seerr APIs as unversioned-in-practice: pin known-good API versions in the adapter, log-and-skip unknown fields, never crash a sync job on one malformed item (skip, count, report).
- Timeouts on every call; a hung Jellyfin must degrade Sweeparr, not freeze it.

**Safety**
- Global `DRY_RUN` env override that beats every per-rule setting — the "I'm refactoring the executor" seatbelt.
- Deletion cap per run (e.g. max 10 items or 200 GB per executor cycle, configurable). A bad rule edit should cost you at most one cycle's cap, not a library.
- New/edited rules always start in dry-run; UI requires viewing the preview diff before arming.
- Recommend (and document) enabling Sonarr/Radarr **recycle bin** so even executed deletions have an undo window on the NAS.
- Clock discipline: store UTC everywhere, render in configured TZ (America/New_York); `delete_at` comparisons in UTC only. Off-by-a-timezone is how you delete something a day early.

**Security (Cloudflare Tunnel exposure)**
- **Auth = Jellyfin credential pass-through, Jellyseerr-style (decided).** Login form posts to Sweeparr, which calls Jellyfin `/Users/AuthenticateByName`; on success, Sweeparr mints its own session (HTTP-only cookie) and stores the Jellyfin user ID + `Policy.IsAdministrator` for role mapping — Jellyfin admins are Sweeparr admins, everyone else gets the user tier (keep requests, "what's leaving"). No passwords stored, no separate account system, and the user identity is *already* the same ID the playback/facts tables key on. Cache the admin flag per session and re-check on login, not per request.
- The unauthenticated surface is exactly: `/flags`, `/static/inject/*`, health check. Everything else behind auth. Consider Cloudflare Access on the admin routes as a second wall, consistent with your Zero Trust setup.
- API keys for Jellyfin/arr/seerr live in env/secrets, never in the DB, never returned by the settings API (write-only fields in the UI).

**Testing**
- The rule engine is pure functions over rows → unit-test it exhaustively (given facts, does the tree match). This is the highest-value test surface in the project.
- Executor tests with mocked adapters asserting the *order* of operations and the abort-on-protection path.
- One docker-compose "lab" file with real Jellyfin + Sonarr + Radarr + Jellyseerr instances and a seed script — you'll want it constantly, and it doubles as the integration-test bed.

---

## 12. API surface (sketch)

```
GET  /api/v1/dashboard                    counters, disk, next deletions, recent activity
GET  /api/v1/media?state=&library=&sort=  explorer grid (facts joined in)
GET  /api/v1/media/{id}                   full detail: stats, requests, protections, history
POST /api/v1/units/{id}/keep              create keep request (user tier; unit = movie or season)
POST /api/v1/units/{id}/schedule|unschedule|postpone|delete-now  (admin)
GET  /api/v1/schedule?from=&to=           calendar feed of SCHEDULED items
GET  /api/v1/rules  POST/PUT/DELETE       rule CRUD
POST /api/v1/rules/preview                evaluate condition tree → matching units (no side effects)
POST /api/v1/rules/{id}/arm|disarm        explicit status transitions
GET  /api/v1/keep-requests  POST .../{id}/approve|deny
GET  /api/v1/jobs  POST /api/v1/jobs/{name}/run|pause
GET  /api/v1/stats/*                      chart endpoints
GET  /flags?jellyfin_ids=...              public, cached, CORS (inject script)
POST /webhooks/jellyfin                   playback events
GET  /api/v1/settings  PUT ...            (+ POST /api/v1/settings/test/{service})
GET  /healthz                             liveness + integration health
```

SSE endpoint (`/api/v1/events`) streaming job completions/state changes so the UI updates live without polling.

---

## 13. UI pages (React/Vite/Tailwind)

1. **Dashboard** — disk gauges per root folder, "leaving this week" strip, bytes-freed-over-time chart, integration health, last job runs.
2. **Upcoming Removals** — the centerpiece. Calendar + list views of SCHEDULED items with delete date, rule, reason, size; row actions: keep / postpone (+30d) / delete now. Bulk select.
3. **Rule QC** — observability, not a gate. Per rule: current matches (CANDIDATEs for dry-run rules, SCHEDULEDs for armed ones), match-count-over-time sparkline, a diff view ("newly matched since yesterday / no longer matching"), and the matched-snapshot per item so you can verify each match's *reasoning*. This is where a freshly armed rule gets sanity-checked against reality for its first few cycles, and where a dry-run rule earns arming.
4. **Media Explorer** — full library grid with watch facts as sortable columns (last watched, plays, completion, GB, GB-per-watched-hour), filter chips, per-item drawer with playback timeline and lifecycle history.
5. **Rules** — visual condition-tree builder (grouped rows with AND/OR toggles, field/operator/value pickers from a typed catalog), policy panel (grace, disk tiers, rule status with an explicit arm action, notifications), and an always-visible live preview pane ("this rule currently matches 37 items / 412 GB").
6. **Keep Requests** — user-facing submit view + admin approval queue.
7. **History** — audit log with filters; deleted-items ledger with bytes freed.
8. **Settings** — connections (+test buttons), schedules, notification channels, Leaving Soon collection config, inject-script setup instructions, global dry-run/kill switch rendered as an unmissable banner state.

Design language: dark-first (it lives next to Jellyfin), dense tables, status pills reusing one shared component with the state colors (candidate amber, scheduled red, kept green, dry-run striped).

---

## 14. Phased roadmap

**Phase 1 — Observe (read-only, zero risk)**
Adapters + sync jobs + identity matching; playback ingestion (webhook + poll) and facts aggregation; DB/migrations; Dashboard + Media Explorer; settings + connection tests. *Exit: every item shows correct joined identity and believable watch facts.*

**Phase 2 — Decide & schedule (still deletes nothing)**
Rule engine + preview with movie **and season** targets; season/movie state machine with rules capped at `dry_run` status (arming disabled until Phase 3); Upcoming Removals + Rules + Rule QC UI; Leaving Soon collection; notifications. *Exit: a month of dry-run candidates you agree with — the QC diff views contain no surprises.*

**Phase 3 — Warn & remove**
Deletion executor with caps, re-verification, audit — Radarr movie path and Sonarr per-season path (unmonitor → bulk episode-file delete → verify); rule arming unlocked; keep requests end-to-end; web-client inject script + `/flags` (season banners render on both season and series pages); disk-pressure grace adjustment; backups/housekeeping. *Exit: first real automated deletion whose banner you saw in Jellyfin two weeks earlier.*

**Phase 4 (later) — Refinements**
Episode-level cleanup (`keep_episodes`-style rolling windows for long-running shows), optional prompted full-series removal when all seasons are swept, Jellyfin-tag pills, per-user protection preferences, stats deep-cuts, maybe a proper companion Jellyfin plugin instead of raw injection.

---

## 15. Decision log (formerly open questions)

| # | Question | Decision |
|---|---|---|
| 1 | TV deletion granularity | **Per-season in v1.** Season is the deletable unit; whole-series rules expand to per-season schedules. Episode-level windows deferred to Phase 4. |
| 2 | Confirmation model | **No approval gate.** Armed rules auto-schedule; grace period + visibility (calendar, banners, notifications) is the safety net. Rules bake in `dry_run` (CANDIDATE shadow state) before arming; **Rule QC** page verifies behavior after. |
| 3 | Arr tag mirroring | **Optional, off by default** (`mirror_arr_tags`). One-way visibility flag only; DB is the sole state store. |
| 4 | Auth | **Jellyfin credential pass-through, Jellyseerr-style.** Sweeparr session cookie after `/Users/AuthenticateByName`; Jellyfin admins = Sweeparr admins. |
| 5 | `addImportListExclusion` × Jellyseerr re-requests | **Deferred to live testing post-implementation.** Ship with the per-rule toggle (default on); validate re-request behavior in the lab compose and adjust the default based on findings. |

---

## Addendum — v1.2 (single-user / self-hosted simplification)

> **Context:** After the v1.1 implementation landed, a focused refactor aligned the product with
> single-admin, self-hosted homelab use — fewer safety layers that duplicated each other, no demo
> seed path, and configuration that lives in the UI after first boot. The sections below **amend**
> the corresponding v1.1 text where they conflict. Where not mentioned, v1.1 still applies.

### A.1 Design tenets (amended)

| v1.1 | v1.2 |
|---|---|
| Dry-run is the default state | **Rules start disabled** (`enabled=false`). Preview is stateless and has no side effects. |
| Global `DRY_RUN` env + per-rule `dry_run` → `armed` | **One system toggle** (`system_enabled` in DB, Settings UI). When paused: no rule evaluation, no deletions. |
| Deletion caps per run | **Removed.** Trust the grace period + system pause + per-rule disable. |
| Kill switch env var | **Removed.** System pause replaces it. |

The core tenet unchanged: **nothing deletes without a visible schedule and grace period.**

### A.2 Rule lifecycle (amended §6.2, §7.1)

**Rule set status** is now a single boolean:

```
enabled: false  →  rule is inert; preview only
enabled: true   →  evaluate_rules schedules matching units
```

Removed: `draft`, `dry_run`, `armed`, and the **CANDIDATE** shadow state. There is no intermediate
"shadow schedule" — if you want to observe blast radius over time, leave the rule **off** and watch
the live preview (or enable briefly, then disable to revert scheduled units).

**Rule CRUD:**

- `POST /api/v1/rules` — creates disabled
- `POST /api/v1/rules/{id}/enable` — enables + runs evaluation
- `POST /api/v1/rules/{id}/disable` — disables + reverts that rule's scheduled units to `ACTIVE`
- `DELETE /api/v1/rules/{id}` — deletes rule + reverts scheduled units
- `POST /api/v1/rules/preview` — unchanged; evaluates any condition tree with zero side effects

**UI:** Create from preset (stale movies, never-played requests, inactive-requester seasons) or blank.
Live preview shows count + GB; click to open the **full match list** with per-item condition snapshots.
Enable/delete use a simple confirm modal (no "type the rule name" gate).

### A.3 Lifecycle states (amended §7.1, §10)

```
ACTIVE ──(enabled rule match)──► SCHEDULED ──► DELETING ──► DELETED
  ▲                                  │
  └──────── disable rule / no longer matching ──┘
  └──────── KEPT (veto) ────────────────────────┘
```

**Removed:** `CANDIDATE`. Existing DB rows migrated `CANDIDATE → ACTIVE` on startup.

`evaluate_rules` only considers rules where `enabled=true` **and** `system_enabled=true`.

### A.4 Safety model (amended §7.3, §11)

Executor checks, in order:

1. `system_enabled`? Originating rule still `enabled`? Unit still `SCHEDULED` (row-level `DELETING` claim)?
2. Re-verify protections against live data
3. Delete via arr API (unchanged)
4. Audit + notify

Removed env overrides: `SWEEPARR_DRY_RUN`, `SWEEPARR_KILL_SWITCH`, `SWEEPARR_DELETION_CAP_*`.

### A.5 Configuration (amended §11)

**Bootstrap env** (`.env` / docker-compose):

| Variable | Purpose |
|---|---|
| `SWEEPARR_SESSION_SECRET` | Session cookie signing |
| `SWEEPARR_ADMIN_USERNAME` / `SWEEPARR_ADMIN_PASSWORD` | Local admin created on first boot only |
| `SWEEPARR_TIMEZONE` | Display timezone |
| `SWEEPARR_{SERVICE}_{URL,API_KEY}` | Optional one-time seed into DB |

**Runtime settings** (DB `settings` table, Settings UI):

| Key | Purpose |
|---|---|
| `system_enabled` | Global engine on/off |
| `integration_{service}` | URL, API key, ntfy topic — **authoritative after first save** |
| `disk` / `disk_capacity_tb` | Root-folder usage from Sonarr/Radarr diskspace sync |
| `disk_pressure_tiers` | Grace adjustment tiers (unchanged concept) |

Env integration values seed the DB **once** when a service has no stored config. After that, the
Settings UI is the source of truth. API keys are write-only in the API (`has_key: true`, never
returned in full).

Removed: `SWEEPARR_SEED_DEMO`, `SWEEPARR_DEV_AUTH_BYPASS`.

### A.6 Authentication (amended §11, Decision #4)

| Method | Role |
|---|---|
| **Local admin** | Bootstrapped from env on first run (`password_hash` in `user` table). Password changeable in Settings. |
| **Jellyfin pass-through** | `/Users/AuthenticateByName`; Jellyfin admins → Sweeparr admin. |

**Removed:** separate non-admin user tier and mobile-first "Leaving soon" app (`Leaving.tsx`,
`MyRequests.tsx`, `UserNav.tsx`).

**Kept:** `/keep/:token` magic-link flow for household keep requests from Jellyfin inject banners
(no login required). Admin approves in **Keep Requests**.

Only Jellyfin admins and the local admin reach the admin console.

### A.7 Data collection (amended §5)

**Library sync (implemented):**

- `sync_radarr` / `sync_sonarr` — upsert library + call `/api/v3/diskspace` → `disk` settings
- `sync_jellyfin` — paginated library ID link + **per-user UserData pull** (`IsPlayed` /
  `IsResumable` filters) → `item_watch_facts` / `season_watch_facts`
- On empty library at startup: auto-run library syncs if Sonarr/Radarr configured
- On integration save in Settings: probe health + run relevant sync jobs immediately

**Playback (partial):**

- `playback_event` / `playback_session` tables exist; **webhook ingestion (`POST /webhooks/jellyfin`)
  is not yet wired.** Watch stats currently come from Jellyfin UserData sync on the `sync_jellyfin`
  cadence (typically 45 min), not real-time.
- `aggregate_playback` still rolls up session rows when they exist.

**Removed:** `services/seed.py` and all demo data generation.

### A.8 Scheduler (amended §7.2)

Current default cadences:

| Job | Interval |
|---|---|
| `sync_radarr` / `sync_sonarr` / `sync_jellyfin` | 45 min |
| `sync_jellyseerr` | 30 min |
| `aggregate_playback` | 15 min |
| `evaluate_rules` | 8 h |
| `execute_deletions` | 1 h |
| `notify` / `sync_leaving_collection` | 1 h |
| `housekeeping` | 24 h |

Removed: `poll_sessions` (no separate poll job; UserData sync covers historical plays).

Settings UI shows jobs in a **table** (job name | next run | Run button) for clarity.

### A.9 UI (amended §13)

| Page | v1.2 notes |
|---|---|
| **Rules** | On/off toggle per rule (not draft/dry-run/armed stepper). Preset picker on create. Full preview modal. |
| **Settings** | Editable connections + system toggle + job table + local password change. |
| **Media Explorer** | Sortable/filterable **column headers** (type filter cycles All → Movies → TV; click headers to sort). No chip bar. |
| **Dashboard** | Empty-state hint when disk data missing (run sync jobs). |
| **Rule QC** | Still post-hoc observability; references enabled rules + SCHEDULED units (no CANDIDATE view). |

Global banner when `system_enabled=false`: "SYSTEM PAUSED — no rules evaluate and nothing deletes."

### A.10 API (amended §12)

```
POST /api/v1/rules/{id}/enable|disable     replaces arm|disarm
PUT  /api/v1/settings                      integrations + system_enabled (returns sync_summary on save)
POST /api/v1/settings/test/{service}       probe single integration
POST /api/v1/auth/change-password          local admin only
```

Removed: `include_dry_run` query param on schedule endpoints.

### A.11 Data model (amended §10)

```
rule_set          … enabled(bool)           replaces status(draft|dry_run|armed), dry_run_since
user              … password_hash             local admin credential
settings          integration_{service}     replaces env-only API keys
```

Lifecycle `state` enum: `ACTIVE | SCHEDULED | DELETING | DELETED | KEPT | ERROR` (no `CANDIDATE`).

Startup migration shim in `db.py` handles existing SQLite databases (add columns, migrate states,
drop legacy columns).

### A.12 Decision log (additions)

| # | Question | v1.2 Decision |
|---|---|---|
| 6 | Demo / dev bootstrap | **Removed.** Real integrations required; library sync populates data. |
| 7 | Safety layering | **Collapsed** to rule `enabled` + system `system_enabled` + grace period. No env seatbelts. |
| 8 | Config authority | **DB + Settings UI** after first boot; env seeds once. |
| 9 | Auth for chicken-and-egg | **Local admin** from env, plus Jellyfin pass-through once configured. |
| 10 | Watch stats ingestion | **UserData sync** shipped; webhooks deferred. |

### A.13 Phased roadmap (status note)

Phases 1–2 core is **implemented** with the v1.2 simplifications above. Phase 3 executor path
exists; Phase 4 refinements unchanged. Outstanding from original spec:

- Jellyfin webhook playback ingestion (real-time sessions)
- `poll_sessions` fallback job
- Full Jellyseerr request → `watched_by_requester` linkage (request sync is read-only stub)

---

*Addendum v1.2 — reflects implementation as of the single-user refactor. See [README.md](README.md)
for operator-facing quick start and configuration.*
