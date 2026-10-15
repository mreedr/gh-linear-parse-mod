# gh-linear-parse-mod

A Claude Code mod that keeps the GitHub PR and Linear links discussed in a session in a band above the prompt.
It reads your prompts and the assistant's answers (not tool results), and on first load it backfills links already in the transcript.
Pressing a link opens it in your default browser, or in the browser the `browser` option names.
The band has up to three sections, each under its own header row: Status (Claude's status line), GitHub, then Linear.
PRs show as `repo | #N`; Linear issues show as `ENG-123 | slug words`, and other Linear pages as `project | name`, followed by the tab when the link names one (`project | new onboarding · overview`).
Each PR is followed by its author's first two letters (`mr` for mreedr), its lines added and deleted (`+120 -34`, in green and red), and a short, gray form of its title: a conventional-commit scope becomes a tag, ticket references and clauses such as `when ...` or `once ...` are dropped, and the rest is cut at the band's edge.
The line counts are never cut; on a band too narrow for them the row shows the title alone.
Each Linear issue is followed by its workflow status (`In progress`, `In review`), read through the session's Linear MCP server.
The whole row past its `x` opens the link.
A `/clear` empties the band, the PR and issue statuses and the dismissed list; the color and watch settings stay.
Each session's links and dismissals are saved (the 30 most recent sessions), so a resumed session gets its band back even after compaction took the links out of the conversation.
The header shows how many links the session has and when the PRs and issues were last read, with its buttons at the right edge: Refresh reads them all again.
On a narrow band the time is left out so the header stays on one line.

## Install

You need a recent Claude Code and the GitHub CLI (`gh`), signed in with `gh auth login`; the PR status emoji come from `gh`.
Linear statuses need a Linear MCP server connected to Claude Code (one whose tools are named `mcp__<server>__get_issue`, such as Linear's own `linear-server`); without one, Linear rows show no status.

In a Claude Code terminal session:

```
/plugin install gh-linear-parse-mod --marketplace mreedr/gh-linear-parse-mod
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).
If that form is not accepted, add the marketplace and install in two steps:

```
/plugin marketplace add mreedr/gh-linear-parse-mod
/plugin install gh-linear-parse-mod@gh-linear-parse-mod
```

Start a new session: PR and Linear links you or Claude mention show up in a band above the prompt.
Links open in your default browser; see [Browser](#browser) to pick one.
To get later versions, update the plugin from `/plugin`.

## Browser

The `browser` option is empty by default, which opens links in the system default browser (`open`, `xdg-open` or `start`).
On macOS it can name an app instead, such as `Brave Browser` or `Google Chrome`; set it in the plugin's config menu or in `~/.claude/settings.json`:

```json
"pluginConfigs": { "gh-linear-parse-mod": { "options": { "browser": "Brave Browser" } } }
```

With a Chromium browser (Brave, Chrome, Edge, Chromium, Vivaldi) the mod first switches to a tab already on the link, including a PR's `/files` page.
The first time, macOS asks whether your terminal may control the browser; without that, links open in a new tab.
If the named browser fails to open, the link opens in the default browser with a toast.

## Usage

| Command | Effect |
| --- | --- |
| `/gh-linear-parse-mod` | Toggle the band (also `on`, `off`) |
| `/gh-linear-parse-mod clear` | Empty the band for this session |
| `/gh-linear-parse-mod refresh` | Re-check the status of every PR and Linear issue in the band |
| `/gh-linear-parse-mod watch on\|off` | Turn the 5-minute status refresh on or off (this session; on by default) |
| `/gh-linear-parse-mod nudge on\|off` | Ask agents in their system prompt to keep their status current, or stop asking (all sessions; on by default) |
| `/gh-linear-parse-mod reset` | Let links dismissed with `x` show again (this session) |
| `/gh-linear-parse-mod color <color> [fill]` | Border (or fill) color for this session: a name, hex or theme key; the default is a gray border, `color` alone goes back to it, `color none` removes it |
| `/gh-linear-parse-mod <color> [fill]` | Same as `color <color> [fill]`, for a color name, hex or theme key; any other unknown option shows the list of options and leaves the band alone |

In the band, `x` dismisses a link for the session, and `Show N more` / `Show less` expands the list.

## PR status

PR rows carry three status columns, labelled `PR`, `CI` and `Rv` in the GitHub header row.
Linear rows carry one, labelled `St` in the Linear header row.

| Column | Emoji |
| --- | --- |
| PR | 🟢 open · 📝 draft · 🟣 merged · ⚫ closed |
| CI | ✅ pass · ❌ fail · ⏳ running · blank when there are no checks; only the newest run of each check counts, so a run cancelled by a rerun or a newer push is ignored |
| Rv | 👍 approved · 👀 review needed · ✋ changes requested · 💬 a person other than the author commented, no approval yet (bots such as `claude` don't count) · 🦯 no reviewer assigned (open PRs; a draft is not asking for review yet, so it shows nothing) |

A dim `…` means not checked yet, and a dim `?` means `gh` could not read the PR.
Merged and closed PRs are dimmed.
Status comes from `gh pr view`, so `gh` must be installed and signed in.
A PR is checked when it is first mentioned, again when it is mentioned at least 15 seconds later, every 90 seconds while its CI runs (for up to 6 hours), and on `refresh`.
While the watch is on and the band is showing, open and draft PRs in view are also re-checked every 5 minutes, so approvals, merges and new pushes show up on their own.

## Linear status

| Status type | Emoji |
| --- | --- |
| Triage | 📥 |
| Backlog | 💤 |
| Unstarted (todo) | ⚪ |
| Started (in progress, in review, blocked) | 🟡 |
| Completed | 🟣 |
| Canceled or duplicate | ⚫ |

The emoji follows the status's type, and the status's own name follows the issue's label, lined up down the band.
Completed, canceled and duplicate issues are dimmed, and a dim `?` means the Linear server could not read the issue.
An issue is checked when it is first mentioned and on `refresh`; while the watch is on, unfinished issues in view are re-checked every 5 minutes.
The mod calls only the server's read-only `get_issue` tool.

## Claude's view of the band

Claude can read the band through the `mcp__gh-linear-parse-mod__links_band` tool, which returns this session's links with each PR's status and each Linear issue's status, dismissed keys, hidden and expanded flags, and color.
Ask something like "what's in my links band?".

## Claude's status

Claude can set a status line in the band's Status section with the `mcp__gh-linear-parse-mod__set_status` tool, a short note of what it is doing or waiting on (`waiting on CI for #812`), followed by the time it was set.
A new status replaces the old one, and an empty text clears it.
Press its `x` to clear it yourself; a `/clear` clears it too.
With no links in the band, the band shows the status line alone.
By default the mod adds a short section to the system prompt asking the agent to keep its status current; `/gh-linear-parse-mod nudge off` removes it in every session from the next request, and `nudge on` puts it back.

## Develop

```sh
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
