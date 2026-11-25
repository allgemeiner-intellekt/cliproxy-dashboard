# Changelog

All notable changes to this project are listed here. Versions follow
[Semantic Versioning](https://semver.org/). Each release is a `vX.Y.Z` git tag;
see [Releasing](README.md#releasing).

## [Unreleased]

## [0.1.0] - 2026-11-25

First versioned release of this fork, a usage and cost dashboard for CLIProxyAPI.

### Changed

- The dashboard focuses on usage and cost. The proxy management bridge,
  quota, account, config, key, sharing-pool and history-search features are
  gone (#2).
- The image runs as the `bun` user (uid 1000). The mounted data directory
  must be owned by uid 1000; see the Docker section of the README (#8).

### Added

- `GET /api/health` returns 503 once the collector has been disconnected for
  more than 2 minutes, and the image has a `HEALTHCHECK` (#8).
- CI gates image publishing and deploys on lint, type checks, build, tests and
  a migration drift check. PRs build the image without pushing, and pushes to
  main publish with provenance and SBOM attestations (#4).
- Version tags publish `:X.Y.Z` and `:X.Y` images and a GitHub release.
- Accessibility: higher text contrast, keyboard navigation and announcements
  in the usage chart, labelled controls, larger touch targets, reduced-motion
  support (#9).
- Tests for the collector, importers and HTTP routes (#10) and for frontend
  helpers (#9).

### Fixed

- Collector: a bad record or a SQLite error no longer crashes it. Valid rows
  in a batch are still stored, and failed writes are retried from a bounded
  buffer of up to 5000 rows. Records that arrive while it's full are dropped
  and logged.
  It reconnects after parse errors, stops retrying after an AUTH failure, and
  detects half-open connections (#3).
- Startup no longer waits on the price download, keeps machine names when
  `tailscale status` fails, and rejects invalid configuration (#5).
- Usage page: no stale responses after switching ranges, loading and error
  states, polling pauses while the tab is hidden (#6).
- HTTP API: Host check against DNS rebinding, JSON-only writes, JSON error
  responses, bounded import timestamps, `usage.db` created `0600` (#7).
- Deploy hook: each signed request is accepted once, even across restarts.
  Request bodies are validated, and job status requires a signature and is
  never cached.

[Unreleased]: https://github.com/allgemeiner-intellekt/cliproxy-dashboard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/allgemeiner-intellekt/cliproxy-dashboard/releases/tag/v0.1.0
