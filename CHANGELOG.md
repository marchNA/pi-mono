# Changelog (Fork)

This changelog tracks modifications made in this fork (`marchNA/pi-mono`), diverging from the upstream `badlogic/pi-mono`.

## [Unreleased]

### Added
- `/commit <message>` slash command for quick git add + commit + push in pi interactive mode

## 2026-02-11

### Added
- Feishu (飞书) bot implementation (`packages/mom/src/feishu.ts`) with `@larksuiteoapi/node-sdk`
- Daemon mode for mom bot: `--daemon`, `--stop-daemon`, `--status` CLI arguments
- Default working directory changed to `~/.pi/mom/data` to keep sensitive IDs out of the repo
- Auto-create settings files when running in daemon mode (no stdin)
- Chinese (简体中文) language support: `buildSystemPrompt()` accepts `language` parameter
- Local timezone timestamps via `toLocalISOString()` in log, feishu, slack, and store modules
- `MomSettingsManager` missing interface methods: `getImageAutoResize`, `getShellCommandPrefix`, `getTheme`, `getLanguage`, `getBranchSummarySettings`, `reload`
- `claude-opus-4-6-thinking` model to antigravity provider
- PID file cleanup on SIGINT/SIGTERM for both Slack and Feishu bots

### Fixed
- Feishu `AppType.SelfBuild` enum value (was string `"self_built"`, causing ISV/marketplace token flow and `tenant_access_token` failure)

### Changed
- `EventsWatcher` refactored to use generic `EventTarget` interface instead of `SlackBot`, supporting both Slack and Feishu
- `package-lock.json` removed from git tracking, added to `.gitignore`
- Pre-commit hook: silently skip ignored files during restage
