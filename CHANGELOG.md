# Changelog (Fork)

This changelog tracks modifications made in this fork (`marchNA/pi-mono`), diverging from the upstream `badlogic/pi-mono`.

## [2026-02-12]

### Added
- `/commit <message>` slash command for quick git add + commit + push in pi interactive mode
- Feishu bot image support: download and forward user-sent images to the LLM model
- Feishu bot rich text (post) message support: extract text and inline images
- `/login` now supports custom OpenAI-compatible providers via API key: interactive flow to configure provider name, API URL, API key, and select models from remote `/models` endpoint; saves to `models.json` + `auth.json`
- `/model` selector now groups models by provider (hierarchical view)
- `/model` selector has "Edit visible providers" option at the bottom to hide/show providers via checkbox toggles; persisted to `settings.json` as `hiddenProviders`
- Per-model visibility editing in `/model` selector: from the provider editor, press Enter to drill into a provider's model list and toggle individual models with Space
- Standalone Antigravity quota checker script (`scripts/antigravity-quota.ts`): two modes — local API (queries running Antigravity language server) and Google Cloud Code API (OAuth login, works without Antigravity); auto-detect mode tries local first, falls back to cloud
- `/model-quota` slash command: shows Antigravity model quota usage with progress bars and reset times directly in the chat UI
- Automatic model fallback on quota exhaustion: when retries are exhausted, automatically switches to a fallback model and retries (default: `claude-opus-4-6-thinking` → `gemini-3-pro-high`); configurable via `modelFallbacks` in `settings.json`

### Fixed
- Fixed bash shell detection on Windows when Git is installed in a non-standard location (e.g., `D:\Tools\Git`); now derives `bash.exe` path from `git.exe` on PATH before falling back to direct `bash.exe` search

### Changed
- Z.AI provider baseUrl corrected to `https://open.bigmodel.cn/api/coding/paas/v4`
- Z.AI default model updated from `glm-4.6` to `glm-4.7`

### Fixed
- Feishu bot system prompt no longer says "Slack bot assistant"; now uses platform-aware prompt with correct formatting rules (Markdown for Feishu, mrkdwn for Slack)
- Daemon mode now works when running via `npx tsx` (uses `--import tsx` loader for child process instead of bare `node`)
- Thinking content no longer sent as messages to the channel (still logged to file)
- Bare `feishu`/`slack` argument now recognized as platform (previously treated as working directory, causing data to be written to project path)
- Feishu bot no longer floods chat with thread replies for tool details and usage summary (`respondInThread` is now a no-op for Feishu)
- Windows path separator bug: `workspacePath` calculation now uses `dirname()` instead of string replace with `/`, fixing doubled channel ID in attachment paths

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
