# Configuration

claude-quota-guardian reads `~/.claude/session-continuity/config.json`. All fields are optional — missing fields fall back to defaults.

| Field | Default | Description |
|---|---|---|
| `plan` | `"none"` | `"none"` \| `"pro"` \| `"max5x"` \| `"max20x"`. `"none"` disables plan-quota checks (context-window monitoring still runs). Any other value enables `ccusage`-based plan checks. |
| `thresholds.context` | `0.986` | Fraction (0-1) of the model's context window that hard-blocks tools on the terminal (CLI) surface. |
| `thresholds.plan` | `0.986` | Fraction (0-1) of the plan's quota that triggers a checkpoint. |
| `thresholds.desktopWarn` | `0.96` | Notify-only warning threshold for the Claude Code Desktop surface (context %) — set below the hard threshold so Desktop gets warned before the wall. Desktop also gets an account-quota warn at `thresholds.plan`. Desktop is never hard-blocked. Set to `null` to silence Desktop entirely. |
| `providers.codex` | `{ enabled: true, warnPct: 90, stalenessMinutes: 20, renotifyMinutes: 15 }` | Notify-only monitoring of OpenAI Codex CLI sessions (see [Other AI providers](#other-ai-providers-notify-only) below). `warnPct` is a percentage (0-100). |
| `planTokenLimit` | `null` | Tokens in your plan's 5h window. Needed for plan-% on `ccusage` >=20 (see below). `null` → plan-% disabled, context-% still runs. |
| `planCheckIntervalToolCalls` | `5` | Throttles the `ccusage` subprocess (1-2s typical, shells out via `npx`): only re-runs it once every N `PostToolUse`/`Stop` checks, reusing the last reading from `state.json` in between. The real account-wide `rate_limits` signal (see below) is cached separately and is never throttled by this setting. |
| `watcherIntervalMinutes` | `15` | Base watcher polling cadence. `adaptiveWatcher.tiers` shortens this as usage climbs (default: 3min at 90%, 1min at 98%). |
| `notifications.enabled` | `true` | When `false`, the watcher and hooks still write state/pending files but skip OS notifications. |
| `usageApi` | `{ enabled: true, cacheSeconds: 60, timeoutMs: 5000 }` | Exact account-wide 5h/7d usage from Anthropic's OAuth usage endpoint (see [Exact account-wide quota](#exact-account-wide-quota-oauth-usage-api) below). `enabled: false` reverts to the statusline/ccusage signals only. |

## Detection architecture

Five hooks, all registered globally in `~/.claude/settings.json` (apply to every Claude Code project/terminal/IDE session for this user, not just one project):

| Hook | Event | Purpose |
|---|---|---|
| `hooks/check-usage.js` | `PostToolUse` | Heartbeat + threshold check after every tool call. |
| `hooks/heartbeat-stop.js` | `Stop` | Same heartbeat/threshold check after every assistant turn, **including turns with no tool calls** — closes the gap where context climbs during pure-text turns and `PostToolUse` never fires. Never emits `decision: block` (for `Stop`, that decision means "prevent the agent from stopping," the opposite of what's needed here). |
| `hooks/enforce-checkpoint.js` | `PreToolUse` | Hard stop: once a checkpoint is pending and unconsumed, blocks every tool call except `Bash`/`Write` (the two the `/continuity-checkpoint` flow needs) until the checkpoint is saved. This is a real block — unlike the `PostToolUse`/`Stop` advisories, the tool call never runs. |
| `hooks/resume-context.js` | `SessionStart` | Injects the saved checkpoint into a new session once consumed. |
| `hooks/statusline.js` | `statusLine` | Caches Claude Code's real account-wide `rate_limits` (5h/7d Pro/Max quota) into `state.json` and renders the visible status line. See below. |

**Self-heal:** on every watcher pass, `selfHealHooks` verifies the four hooks are still registered in `~/.claude/settings.json` and re-merges them (idempotent, never touches foreign hooks or the statusLine) if an external tool removed them, sending an OS notification when it heals. `bin/uninstall.js` removes the watcher schedule itself, so an uninstalled Guardian cannot resurrect its own hooks.

Once a checkpoint is pending, `check-usage.js`/`heartbeat-stop.js` re-notify every 5 minutes (instead of a single one-shot toast) until `/continuity-checkpoint` runs and marks it consumed.

**Terminal-only enforcement:** every Claude Code transcript line is stamped with an `entrypoint` field (`"cli"`, `"claude-desktop"`, ...) — `lib/usage-monitor.js`'s `getEntrypoint` reads it back out of the transcript, and `lib/threshold-check.js` enforces on exactly one value:

- **Terminal** (`entrypoint === "cli"`): full hard-block flow above — `thresholds.context` (98.6%) creates a pending checkpoint and `enforce-checkpoint.js` really blocks tools until `/continuity-checkpoint` runs.
- **Claude Code Desktop** (`entrypoint === "claude-desktop"`): notify-only tier, like non-Claude providers. At `thresholds.desktopWarn` (96%) it warns about conversation context (fix: open a fresh conversation); at `thresholds.plan` it warns about the account-wide quota (fix: wait for the reset — a new conversation does not help). Re-notified at most every 5 minutes, never blocked, never creates `pending.json`.
- **Everything else** (unknown future surfaces, or a transcript with no `entrypoint` stamp): heartbeat-only — `state.json` keeps updating for the watcher's adaptive polling, nothing else.

**Context limit caveat:** `lib/plan-limits.json`'s `context.default` (180000) is a conservative estimate, not Claude Code's exact internal usable budget — Claude Code reserves some of the model's raw context window for system prompt/tool schemas/autocompact margin, so its own "% used" indicator and this tool's `contextPct` will not match exactly. The default is set below the model's raw 200k window specifically to trigger before Claude Code's own autocompact silently truncates the transcript (which would otherwise reset `contextPct` downward before the threshold is ever crossed). If you still see the threshold crossed only after Code's own UI already shows a higher %, lower `thresholds.context` and/or `plan-limits.json`'s `context.default` further.

**Scope caveat:** enforcement covers the Claude Code terminal surface only (see above). Other Claude Code surfaces (Desktop app, IDE variants) still heartbeat into `state.json` because they share the same `~/.claude/settings.json`/hooks/engine, but are never blocked. The separate Claude.ai consumer chat app (web or desktop, the one with "Projects"/uploaded documents instead of a project folder) has no local hook mechanism at all and is fully out of reach.

## Other AI providers (notify-only)

Non-Claude AI CLIs have no hook system, so the full loop (detect → block → checkpoint → auto-resume) is impossible there. For them Guardian offers a **notify-only tier**, polled by the background watcher on its normal cadence, configured under `providers`:

- **OpenAI Codex CLI** (`providers.codex`): `lib/adapters/codex.js` reads Codex's own session rollouts (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, read-only — Guardian never writes into `~/.codex`). Each fresh session (file modified within `stalenessMinutes`) yields its real context usage (`last_token_usage.total_tokens` vs `model_context_window` from the last `token_count` event) and, when present, the account `rate_limits.used_percent`. When the max of those crosses `warnPct` (default 90), the watcher sends an OS notification telling you to ask Codex for a summary/checkpoint before the cutoff, re-notifying at most every `renotifyMinutes`. Session state lands in `session-continuity/codex-<hash>/state.json` in the same `maxPct`/`updatedAt` shape as Claude project heartbeats, so the watcher's adaptive polling (15→3→1 min) reacts to a filling Codex session exactly like a filling Claude session. Override the Codex data dir with `CQG_CODEX_HOME` (defaults to `~/.codex`).

To add another provider later: write an adapter that returns `{ projectPath, contextPct, rateLimitPct, maxPct, updatedAt }` per fresh session from that provider's local session logs, and wire it into `pollProviders` in `watcher/quota-watcher.js`.

## Exact account-wide quota (OAuth usage API)

`lib/usage-api.js` queries `https://api.anthropic.com/api/oauth/usage` — the same endpoint Claude Code's own `/usage` command uses — authenticated with the CLI's OAuth token from `~/.claude/.credentials.json` (read fresh on every call, so CLI token refreshes are picked up automatically; the token is passed to the fetch child process via stdin, never argv or env). The response carries exact, unrounded `five_hour`/`seven_day` utilization percentages plus their `resets_at` timestamps — no estimation, no `planTokenLimit` guessing, no third-party tool.

`getStatus` consults it first: when available, its more-pressing window becomes `planPct`/`planResetAt` directly and the ccusage subprocess is skipped entirely (the statusline `rate_limits` cache below still wins if it reports a *higher* number, e.g. a fresher reading). Refetches are throttled to once every `usageApi.cacheSeconds` (default 60s) via the reading cached in `state.json`, force-refreshed when a window's `resets_at` passes (rollover), and a stale reading is reused when a due refresh fails — unless its window already rolled over.

**Caveats:** the endpoint is undocumented and could change or disappear without notice — every failure path (missing/expired credentials, HTTP error, timeout, schema change) silently degrades to the statusline/ccusage signals below, never breaking a hook. It only exists for OAuth (Claude.ai Pro/Max) logins; API-key setups have no `.credentials.json` and simply report `no-credentials`.

## Real account-wide quota (`rate_limits` via the status line)

`thresholds.context`/`thresholds.plan` above are both estimates: `context` is a local token count against a guessed budget (see the context limit caveat above), and ccusage-derived `plan` depends on a third-party tool and, on `ccusage` >=20, a manually-supplied `planTokenLimit`. Claude Code's statusline payload is the **only** place a real, account-wide number is ever exposed — `rate_limits.five_hour.used_percentage`/`rate_limits.seven_day.used_percentage`, visible for any Claude.ai Pro/Max subscriber after the first API response in a session. It is never included in `PreToolUse`/`PostToolUse`/`Stop` hook payloads, only in the separate `statusLine` one.

`hooks/statusline.js` reads it on every render and caches the higher of the two windows into the same per-project `state.json` the other hooks heartbeat into (`rateLimitPct`, `rateLimitResetAt`). `lib/threshold-check.js` then reads that cache back on its next `PostToolUse`/`Stop` run and feeds it into `getStatus`'s `planPct` (`lib/usage-monitor.js`'s `cachedRateLimit` param) — winning over the ccusage-derived value whenever it's higher, and working even when `plan` is `"none"` (no ccusage setup required at all). From there it's just the existing `plan` signal: same `thresholds.plan` (98.6%), same hard-block/pending flow on CLI/IDE, same account-wide plan-warn on Desktop (see above) — including against `thresholds.plan` even when local context is low, since an account-wide quota and the current conversation's context are independent things.

**statusLine is a single slot.** Unlike `hooks`, Claude Code's `settings.json` only supports one `statusLine` command — there's no array of them. `bin/install.js`'s `installStatusLine` only claims it when nothing else has (e.g. a status-bar plugin's badge script); if something else already owns it, install logs `statusLine NOT registered` and leaves it untouched rather than overwriting it. In that case, rate_limits tracking stays off until you either free up the slot or manually combine both commands' logic into one script (have it write to `paths.statePath(cwd)` the same way `hooks/statusline.js` does, then print whatever it would otherwise print).

## Plan-quota checks (`ccusage`)

If `plan` is not `"none"`, `getPlanUsage` shells out to `ccusage blocks --json --active` (via `npx`, with `shell: true` so Windows resolves `npx.cmd`). If `ccusage` is not installed or fails, plan-quota checks are silently skipped — only context-window checks remain active.

**ccusage version note:** older `ccusage` (<20) returned a precomputed `tokenLimitStatus.percentUsed`, which is used directly when present. `ccusage` >=20 only reports raw `totalTokens` with no percentage — Anthropic does not publish the exact 5h token cap, so to get a plan-% on these versions you must set `planTokenLimit` (e.g. an empirical token budget for your plan). Without it, plan-% stays disabled and the **context-window guard is the sole, reliable trigger** (it always works, no `ccusage` needed).

Install `ccusage` globally for faster startup: `npm i -g ccusage`.

## Example

```json
{
  "plan": "pro",
  "thresholds": { "context": 0.995, "plan": 0.995 }
}
```
