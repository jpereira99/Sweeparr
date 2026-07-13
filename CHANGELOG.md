# Changelog

All notable changes to Sweeparr are documented here.

## [1.1.1] - 2026-07-13

### Fixed

- Jellyfin favorites now protect content correctly: sync pulls `IsFavorite` (including unwatched
  items and Series-level favorites), season facts expose `is_favorite_any_user`, and unfavorites
  clear protection on the next sync.

## [1.1.0] - 2026-07-13

### Added

- Six opinionated rule presets: stale movies, never-played requests, watched and done, big and
  unwatched, stale seasons, and ended and fully watched.
- Autosave for disabled rules while editing; enabled rules require a manual save with an unsaved
  changes indicator.
- Per-season `newest_file_date` populated during `sync_sonarr` from Sonarr episode file dates, so
  `age_days` / `season_age_days` rules work for TV seasons.

### Fixed

- Empty Sonarr seasons with no downloaded episodes (`episode_count == 0`) are excluded from rule
  evaluation, preventing placeholder seasons from being scheduled for deletion.
- Rule enable/disable toggle now updates the UI immediately without a page refresh.
- Enabling a rule no longer redirects away from the Rules page.

## [1.0.0] - 2026-07-08

Initial stable release.
