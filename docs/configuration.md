# Configuration

claude-quota-guardian reads `~/.claude/session-continuity/config.json`. All fields are optional — missing fields fall back to defaults.

| Field | Default | Description |
|---|---|---|
| `plan` | `"none"` | `"none"` \| `"pro"` \| `"max5x"` \| `"max20x"`. `"none"` disables plan-quota checks (context-window monitoring still runs). Any other value enables `ccusage`-based plan checks. |
| `thresholds.context` | `0.995` | Fraction (0-1) of the model's context window that triggers a checkpoint. |
| `thresholds.plan` | `0.995` | Fraction (0-1) of the plan's quota (per `ccusage`) that triggers a checkpoint. |
| `planCheckIntervalToolCalls` | `5` | Reserved for the Phase 2 watcher; not yet used by the core hooks. |
| `watcherIntervalMinutes` | `15` | Reserved for the Phase 2 watcher. |
| `notifications.enabled` | `true` | Reserved for future use; notifications currently fire whenever `node-notifier` is installed. |

## Plan-quota checks (`ccusage`)

If `plan` is not `"none"`, `getPlanUsage` shells out to `npx ccusage@latest blocks --json --active --token-limit max`. The `max` token-limit mode self-calibrates against your own historical usage, so no hardcoded per-plan token totals are needed. If `ccusage` is not installed or fails, plan-quota checks are silently skipped — only context-window checks remain active.

Install `ccusage` globally for faster startup: `npm i -g ccusage`.

## Example

```json
{
  "plan": "pro",
  "thresholds": { "context": 0.995, "plan": 0.995 }
}
```
