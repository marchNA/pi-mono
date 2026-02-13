# Changelog (Fork)

This changelog tracks modifications made in this fork (`marchNA/pi-mono`), diverging from the upstream `badlogic/pi-mono`.

## [2026-02-13]

### Added
- `/extensions` slash command: list installed extensions, install new ones from the `examples/extensions/` catalog, and open extension files in the editor

### Changed
- `/model` > "Add custom provider" API Protocol step now uses a visual radio selector instead of a text input field

### Fixed
- `/model` selector: cursor arrow appeared on both a model row and "Add custom provider" simultaneously (missing `onAddProviderAction` state checks in 3 places)
- `/model` > "Add custom provider": Anthropic API type was saved as invalid `"anthropic"` instead of `"anthropic-messages"`, causing custom Anthropic-compatible providers to fail at runtime
- `/model` selector: pressing Enter while search input was focused and "Add custom provider" was highlighted did not enter the add-provider flow
- `/model` > "Add custom provider": removed redundant `deleteCharBackward` branch in input handler

### Added (upstream cherry-pick from 0.52.10)
- Fixed context usage percentage showing stale pre-compaction values; footer now shows `?/200k` until next LLM response ([upstream #1382](https://github.com/badlogic/pi-mono/pull/1382))
- Fixed `_checkCompaction()` using first compaction entry instead of latest, causing incorrect overflow detection ([upstream #1382](https://github.com/badlogic/pi-mono/pull/1382))
- `ContextUsage.tokens` and `ContextUsage.percent` are now `number | null` (breaking: extensions must handle `null`) ([upstream #1382](https://github.com/badlogic/pi-mono/pull/1382))
- OpenAI streaming tool-call parsing now tolerates malformed trailing JSON in partial chunks ([upstream #1424](https://github.com/badlogic/pi-mono/issues/1424))
- Extension event forwarding for message and tool execution lifecycles: `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end` ([upstream #1375](https://github.com/badlogic/pi-mono/pull/1375))
- `--model` now works without `--provider`, supports `provider/id` syntax, fuzzy matching, and `:<thinking>` suffix ([upstream #1350](https://github.com/badlogic/pi-mono/pull/1350))
- `@` file autocomplete fuzzy matching now prioritizes path-prefix and segment matches for nested paths ([upstream #1423](https://github.com/badlogic/pi-mono/issues/1423))

### Fixed
- Notes extension adapted for `ContextUsage.percent` being `number | null` after upstream compaction fix
- Skip "Update Available" notification when upstream version is already cherry-picked (checks CHANGELOG.md for `upstream cherry-pick from <version>`)
- Fix CHANGELOG.md lookup using repo root instead of `cwd()`, so version check bypass works when running pi from other directories

## [2026-02-12]

### Added
- Notes extension enabled for project: copied `notes.ts` to `.pi/extensions/` for persistent agent memory across context compaction and sessions
- `/commit <message>` slash command for quick git add + commit + push in pi interactive mode
- Feishu bot image support: download and forward user-sent images to the LLM model
- Feishu bot rich text (post) message support: extract text and inline images
- `/login` now supports custom OpenAI-compatible providers via API key: interactive flow to configure provider name, API URL, API key, and select models from remote `/models` endpoint; saves to `models.json` + `auth.json`
- `/model` selector now groups models by provider (hierarchical view)
- `/model` selector has "Edit visible providers" option at the bottom to hide/show providers via checkbox toggles; persisted to `settings.json` as `hiddenProviders`
- Per-model visibility editing in `/model` selector: from the provider editor, press Enter to drill into a provider's model list and toggle individual models with Space
- Standalone Antigravity quota checker script (`scripts/antigravity-quota.ts`): two modes — local API (queries running Antigravity language server) and Google Cloud Code API (OAuth login, works without Antigravity); auto-detect mode tries local first, falls back to cloud
- `/model-quota` slash command: shows Antigravity model quota usage with progress bars and reset times directly in the chat UI
- Automatic model fallback on quota exhaustion: when retries are exhausted, automatically switches to a fallback model and retries (default: `claude-opus-4-6-thinking` → `gemini-3-pro-high`); automatically switches back to the original model when quota resets (based on reset time extracted from error); configurable via `modelFallbacks` in `settings.json`
- Bash tool `background` mode: new optional `background: true` parameter for running long-lived processes (browsers, dev servers, etc.) without blocking; uses `stdio: ["ignore", "ignore", "ignore"]` + `child.unref()` to fully detach child processes

### Fixed
- Fixed paste detection on Windows Terminal: added heuristic paste detection for terminals that don't support bracketed paste mode; multi-character input containing newlines mixed with printable text is now treated as a paste event instead of individual keystrokes, preventing accidental submission
- Fixed bash shell detection on Windows when Git is installed in a non-standard location (e.g., `D:\Tools\Git`); now derives `bash.exe` path from `git.exe` on PATH before falling back to direct `bash.exe` search
- Fixed slow startup caused by extension loading: share a single jiti instance across all extensions with module cache enabled, reducing `resourceLoader.reload()` from ~17s to ~5.5s (3x speedup)
- Feishu bot system prompt no longer says "Slack bot assistant"; now uses platform-aware prompt with correct formatting rules (Markdown for Feishu, mrkdwn for Slack)
- Daemon mode now works when running via `npx tsx` (uses `--import tsx` loader for child process instead of bare `node`)
- Thinking content no longer sent as messages to the channel (still logged to file)
- Bare `feishu`/`slack` argument now recognized as platform (previously treated as working directory, causing data to be written to project path)
- Feishu bot no longer floods chat with thread replies for tool details and usage summary (`respondInThread` is now a no-op for Feishu)
- Windows path separator bug: `workspacePath` calculation now uses `dirname()` instead of string replace with `/`, fixing doubled channel ID in attachment paths

### Changed
- Z.AI provider baseUrl corrected to `https://open.bigmodel.cn/api/coding/paas/v4`
- Z.AI default model updated from `glm-4.7` to `glm-5`

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
