# Changelog

All notable changes to the Skaftor CLI are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-07-28

First release published from the open-source `skaftor/skaftor-cli` repository.
No functional CLI changes from 0.1.1 — this release aligns the published package
with the repo.

### Changed
- Package name standardized to the unscoped **`skaftor`** (`npm i skaftor`); the
  interim `@skaftorai/cli` is deprecated and points here.
- Relicensed to **MIT**.
- Polished README (badges, usage), added community health files (CONTRIBUTING,
  CODE_OF_CONDUCT, SECURITY), issue/PR templates, and CI + release automation.

## [0.1.1] - 2026-07-28

### Added
- `skaftor wo plan` — decision-engine view of a work order (repo, files, reuse, impact).
- `skaftor wo manifest` — emit the full execution manifest as a single JSON payload.

### Changed
- Clearer error messages on auth/network failures.

## [0.1.0] - 2026-07-01

### Added
- Initial CLI: `login`, `context`, `use`, `whoami`.
- Work-order commands: `wo next`, `wo mine`, `wo list`, `wo show`, `wo start`, `wo ask`,
  `wo sync`, `wo done`.
- JSON-RPC 2.0 client over the per-project MCP server; config stored at
  `~/.skaftor/config.json` (mode `600`).

[Unreleased]: https://github.com/skaftor/skaftor-cli/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/skaftor/skaftor-cli/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/skaftor/skaftor-cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/skaftor/skaftor-cli/releases/tag/v0.1.0
