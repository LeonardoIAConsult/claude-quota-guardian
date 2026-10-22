# Changelog

## 1.1.6 — 2026-10-22

### Fixed
- Extension badge: 1.1.5 put a letter before the number (`S72` for the weekly at 72%), and at
  badge size the "S" reads as a 5: it looked like "572%". The badge now holds only the number and
  "%" (`72%`); which window it is moves to the tooltip, first thing: "el número es Semanal".

### Tests
- The badge test checks every combination holds only digits and "%". 393 in all: 369 with
  `npm test` and 24 for the bar.

## 1.1.5 — 2026-10-22

### Fixed
- Extension badge: the number now says which window it is (`5h2` = 5-hour session at 2%, `S70` =
  weekly at 70%), and hovering it lists every window, when each resets and the time of the
  reading. Before, it showed the weekly 70 with no label and read as the 5-hour usage.
- A failed read (no network, a 429, a 5xx) no longer wipes the last good reading: the badge keeps
  it in grey and the popup shows it with "Sin actualizar". Signing out clears it and the badge
  shows `!` with the reason, instead of going blank.
- A 429 or 5xx from claude.ai is reported as a Claude error, not as "Inicia sesión".
- Requests to claude.ai give up after 10 s, so the popup no longer spins forever; the alarm, the
  popup and the refresh button share one request.
- A quota window whose reset time passed shows "reiniciada" in the popup, the badge and the
  bar above the prompt, never its old %. On the hooks side every window is checked, not only
  the top one, a reading with a reset window is refetched right away, and a stored reading
  older than one hour is no longer served as current after a failed fetch or during backoff.
- Extension cache list: two sessions started in the same folder showed identical rows (two
  "Inicio (~)"). Each now adds the folder it works in, or a number when that matches too.
- Bar: percentages are whole numbers, like `/usage`, and the context reads `Contexto 150k (15%
  lleno)` so it is not taken for quota.

### Tests
- New `tests/extension/usage.test.js` for the extension's badge, error and timeout logic.
  393 in all: 369 with `npm test` and 24 for the bar.

## 1.1.4 — 2026-10-20

### Fixed
- A session with no transcript whose stored folder name is the home folder's 8.3 short form
  (`JANEDO~1`) now shows "Inicio (~)" instead of the short name: the stored name is checked
  next to the real home folder and resolved, not only compared as text.
- macOS: the home folder is recognised when its name is spelled with other case. Names and
  folders are compared ignoring case on Windows and macOS (their default file systems ignore
  it), and exactly on Linux.

### Tests
- The other-spelling tests no longer depend on the machine: a link to the home folder gives a
  second spelling on every OS. The 8.3 tests use a real short name and say so when they skip
  (no 8.3 names on the volume) instead of passing without testing anything.
- Each way `isHomeName` recognises the home folder has its own test (the name it was given,
  the real name, the 8.3 name, other case on macOS), and a sibling folder keeps its own name.

## 1.1.3 — 2026-10-20

### Fixed
- The extension listed things you do not have open: every session with activity in the last
  24 h (closed ones and unattended routines included), expired ones still on the list, each
  under the folder of its last `cd` ("lib", "src") instead of its project. It now lists only
  sessions whose cache is alive, and names each one after the project it started in, decoded
  from its transcript folder in `~/.claude/projects` (the folder is looked up on disk, so a
  "-" inside a project name stays in the name).
- Sessions with no project of their own (started in the home folder or at a drive root) show
  "Inicio (~)", never the home folder's name, which is the OS user's. The same label replaces a
  stored folder name equal to the home folder's when the transcript cannot be read. The home
  folder is recognised even when it is spelled differently (Windows 8.3 short names).
- If the transcript folder is gone, the name falls back to the stored folder name, which is the
  folder of the session's last `cd` (not necessarily its project).

### Tests
- Expired caches are left out; one session across several folders is one row named after its
  project; another project is its own row; the fallback name; home and drive-root starts
  (with and without a transcript) and the 8.3 spelling of the home folder.

## 1.1.2 — 2026-10-19

### Fixed
- With another status line in the slot (no `rate_limits` reaching Guardian's), a Max session
  with an exported-but-declined API key showed 60 min in the bar and 5 in the extension. The
  bar now leaves a note when the engine reports rate limits (once per folder and session);
  the hooks fold it into the session's proof on every hook, so the extension shows 60 too.
  The note is the durable proof; notes older than a day are cleaned up.

### Tests
- The bar's shared answer follows the session's current folder; a fresh live usage reading
  proves a login on its own.

## 1.1.1 — 2026-10-19

### Fixed
- The status line, the bar and the extension now show the same cache minutes for the same
  session: each session has one `lastActivityAt` and one `subscription` answer in its
  `state.json`, and all three read them.
- Subscription proof from rate_limits is kept per session in a short list, so two sessions
  sharing a folder never make the idle status line rewrite state.json; a usage reading counts
  as an OAuth login (macOS keeps the token in the Keychain, not in a file).
- An API-key session on a machine that also has an OAuth login shows 5 min, not 60
  (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or Bedrock/Vertex/Foundry switches mean per-token).
- After `/clear` or `/resume` the bar forgets the previous conversation's countdown (no
  `session.start` fires for them; the bar now listens to `session.end`).
- A bar tick that outlives its session no longer leaves an unhandled rejection, and a tick
  in flight across `/clear` no longer writes the old conversation's numbers into the new one.
- One precedence for the subscription answer in all three surfaces: rate limits (now, or
  recorded for the session) before the stored answer; `0`/`false`/`off` API switches count as
  off; a usage reading (live or cached) proves a login only while it is under an hour old.
- "Limpiar y seguir" only accepts the checkpoint of the folder the session is in now
  (where /continuity-checkpoint writes it, also after a cd).
- Installing the browser bridge no longer reports failure when only the cleanup of the old
  folder fails, and never deletes the launcher it just wrote.

## 1.1.0 — 2026-10-19

### Added
- **Prompt-cache countdown.** Guardian estimates how long the conversation cache has left
  (60 min on a Pro/Max subscription, 5 min on an API key, or `cache.ttlMinutes`) and shows it in
  three places:
  - the status line (`cache 42m`, `cache 3m!`, `cache expired`), refreshed every 30 s;
  - a bar above the prompt (`bar/`, plugin `quota-guardian-bar`) with context size, 5h and week,
    a **Traspaso** button that runs `/continuity-checkpoint` and then **Limpiar y seguir**;
  - the browser extension (1.1), one row per Claude Code session of the last 24 h, through a
    read-only local native-messaging bridge (`native-host/`) that only the extension can start.
- `bin/install.js` turns on the bar and registers the bridge for Chrome, Edge, Brave and
  Chromium; `bin/uninstall.js` removes both.

### Changed
- Plugins renamed `quota-guardian` and `quota-guardian-bar`: Claude Code reserves names that
  start with `claude-`. Earlier plugin installs: `/plugin uninstall claude-quota-guardian@claude-quota-guardian`.
- The extension pins its ID (`key` in the manifest); remove 1.0 and load the folder again.
- A manual checkpoint (`/continuity-checkpoint` by hand, or Traspaso) no longer blocks tools,
  and never stands in for a real cutoff.
- `/continuity-checkpoint` replaces a consumed leftover `pending.json` instead of updating it,
  so the next session really loads the new checkpoint.
- The status line rewrites `state.json` only when the rate limits change.

Details and backlog: [docs/2026-10-19-cache-countdown.md](docs/2026-10-19-cache-countdown.md).
