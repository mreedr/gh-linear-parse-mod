import { atom, read, update } from 'claude-code'
import type { BoxProps, EngineInterface, Register } from 'claude-code'

import type { StatusNote, BandColor, IssueStatus, Item, PrStatus } from '../types'
import { openLink } from './browser'
import {
  PR_FIELDS,
  addKey,
  authorInitials,
  bandGroups,
  cell,
  clockTime,
  diffParts,
  extractLinks,
  fitText,
  isIssueDone,
  isIssueKey,
  isPrKey,
  issueGlyph,
  issueId,
  issueWatchKeys,
  isStale,
  lastChecked,
  linkLabel,
  linksFromHistory,
  mergeLinks,
  nextStatus,
  parseColorArgs,
  parseIssueResult,
  parsePrJson,
  prRef,
  shortTitle,
  shouldPoll,
  statusGlyphs,
  textWidth,
  watchKeys,
} from './parse'

type $ = EngineInterface

const items = atom({ plugin: 'gh-linear-parse-mod', key: 'items' } as const, [] as Item[])
const isHidden = atom({ plugin: 'gh-linear-parse-mod', key: 'isHidden' } as const, false)
const dismissed = atom({ plugin: 'gh-linear-parse-mod', key: 'dismissed' } as const, [] as string[])
const DEFAULT_COLOR: BandColor = { color: 'gray', isFill: false }
const bandColor = atom({ plugin: 'gh-linear-parse-mod', key: 'bandColor' } as const, DEFAULT_COLOR as BandColor | null)
const hasBackfilled = atom({ plugin: 'gh-linear-parse-mod', key: 'hasBackfilled' } as const, false)
const isExpanded = atom({ plugin: 'gh-linear-parse-mod', key: 'isExpanded' } as const, false)
const prStatuses = atom({ plugin: 'gh-linear-parse-mod', key: 'prStatuses' } as const, {} as Record<string, PrStatus>)
const isWatching = atom({ plugin: 'gh-linear-parse-mod', key: 'isWatching' } as const, true)
const issueStatuses = atom({ plugin: 'gh-linear-parse-mod', key: 'issueStatuses' } as const, {} as Record<string, IssueStatus>)
const refreshing = atom({ plugin: 'gh-linear-parse-mod', key: 'refreshing' } as const, 0)
const agentStatus = atom({ plugin: 'gh-linear-parse-mod', key: 'agentStatus' } as const, null as StatusNote | null)

const SHOWN = 5
const MAX_STORED = 40
const MAX_TEXT = 200_000
const MAX_DISMISSED = 500
// a muted slate blue, readable on dark and light themes
const TEXT_COLOR = '#8b95b8'
const STATE_TOOL = 'mcp__gh-linear-parse-mod__links_band'
const STATUS_TOOL = 'mcp__gh-linear-parse-mod__set_status'
const MAX_STATUS = 120
const RECHECK_MS = 15_000
const CI_POLL_MS = 90_000
const CI_POLL_WINDOW_MS = 6 * 60 * 60_000
const WATCH_MS = 5 * 60_000
// Where a Linear MCP server's `get_issue` is found when the tool list names none.
const LINEAR_SERVERS = ['linear-server', 'claude.ai Linear', 'linear']
const LINEAR_TOOL = /^mcp__(.*linear.*)__get_issue$/i

async function record($: $, text: string): Promise<string[]> {
  try {
    const found = extractLinks(text.slice(0, MAX_TEXT))
    if (found.length === 0) return []
    const gone = await read($, dismissed)
    await update($, items, list => mergeLinks(list, found, MAX_STORED, gone))
    await persist($)
    return found.map(l => l.key).filter(k => isChecked(k) && !gone.includes(k))
  } catch {
    // a failed update only costs the band an entry, never the prompt
    return []
  }
}

const isChecked = (key: string) => isPrKey(key) || isIssueKey(key)

const HELP =
  'Use no option to show or hide the band, or one of: on, off, refresh, clear, reset, watch on|off, nudge on|off, color <color> [fill] (a color name alone works too).'

const NUDGE = {
  id: 'gh-linear-parse-mod:status-nudge',
  scope: 'session',
  text: `Keep a status line current in the links band above the prompt with ${STATUS_TOOL}: set it, in under 80 characters, when you start work that will take more than a minute or begin waiting on something (CI, a subagent, a review); update it when that changes; and clear it with an empty text when you finish. Only the main conversation sets it; subagents leave it alone.`,
} as const

// Whether each request's system prompt asks the agent to keep its status; on unless turned off.
async function isNudging($: $): Promise<boolean> {
  try {
    return (await $.store.get('statusNudge')) !== false
  } catch {
    return true
  }
}

const SAVED_SESSIONS = 30
const isItem = (x: unknown): x is Item =>
  typeof x === 'object' && x !== null && typeof (x as Item).key === 'string' && typeof (x as Item).url === 'string'

// Each session's links and dismissals, kept across restarts so a resumed session gets
// its band back even when compaction took the links out of the transcript.
async function persist($: $) {
  try {
    const id = await $.session.id()
    const [list, gone] = await Promise.all([read($, items), read($, dismissed)])
    const saved = await $.store.get('sessions')
    const index = Array.isArray(saved) ? saved.filter((s): s is string => typeof s === 'string') : []
    const ids = [id, ...index.filter(s => s !== id)]
    for (const old of ids.slice(SAVED_SESSIONS)) await $.store.delete(`links:${old}`)
    await $.store.set(`links:${id}`, { items: list, dismissed: gone })
    await $.store.set('sessions', ids.slice(0, SAVED_SESSIONS))
  } catch {
    // an unsaved band is rebuilt from the transcript on resume
  }
}

async function restore($: $) {
  if ((await read($, items)).length > 0) return
  const saved = (await $.store.get(`links:${await $.session.id()}`)) as { items?: unknown; dismissed?: unknown } | undefined
  if (!saved || !Array.isArray(saved.items)) return
  const list = saved.items.filter(isItem)
  const gone = Array.isArray(saved.dismissed) ? saved.dismissed.filter((k): k is string => typeof k === 'string') : []
  await update($, dismissed, keys => (keys.length > 0 ? keys : gone))
  await update($, items, current => (current.length > 0 ? current : list))
  refreshSoon($, list.map(i => i.key).filter(isChecked))
}

const inflight = new Set<string>()
let isPolling = false

// The CI poll runs only while some PR's CI does; a reload drops the timer and the
// flag together, and session.start restarts it when a PR is still running.
function ensurePolling($: $) {
  if (isPolling) return
  isPolling = true
  try {
    $.clock.every(CI_POLL_MS, async () => {
      const now = await $.clock.now()
      const known = await read($, prStatuses)
      const list = await read($, items)
      refreshSoon($, list.filter(i => shouldPoll(known[i.key], now, CI_POLL_WINDOW_MS)).map(i => i.key), true)
    })
  } catch {
    isPolling = false
  }
}

let isWatchTimer = false

// Every 5 minutes, while the watch is on and the band is up, the PRs in view that
// can still change; started by the first status check, like the CI poll.
function ensureWatching($: $) {
  if (isWatchTimer) return
  isWatchTimer = true
  try {
    $.clock.every(WATCH_MS, async () => {
      if (!(await read($, isWatching)) || (await read($, isHidden))) return
      const list = await read($, items)
      const visible = list.slice(0, (await read($, isExpanded)) ? list.length : SHOWN)
      const now = await $.clock.now()
      const keys = visible.map(i => i.key)
      const prs = watchKeys(keys, await read($, prStatuses), now, CI_POLL_WINDOW_MS)
      refreshSoon($, [...prs, ...issueWatchKeys(keys, await read($, issueStatuses))], true)
    })
  } catch {
    isWatchTimer = false
  }
}

let linearServer: string | undefined

// The Linear MCP server the session has, found once: the one the tool list names,
// else the usual names; the issue's status, or undefined when no server answers.
async function readIssue($: $, id: string) {
  const args = { id, fields: ['status', 'statusType'] }
  if (linearServer) {
    const r = await $.mcp.call(linearServer, 'get_issue', args).catch(() => undefined)
    if (r) return parseIssueResult(r)
    linearServer = undefined
  }
  const tools = await $.tool.list().catch(() => [])
  const listed = tools.map(t => LINEAR_TOOL.exec(t.name)?.[1]).filter((n): n is string => !!n)
  for (const server of new Set([...listed, ...LINEAR_SERVERS])) {
    const r = await $.mcp.call(server, 'get_issue', args).catch(() => undefined)
    const status = r && parseIssueResult(r)
    if (status) {
      linearServer = server
      return status
    }
  }
  return undefined
}

async function refreshIssue($: $, key: string) {
  const fetched = await readIssue($, issueId(key))
  // with no Linear server in the session the row stays blank
  if (!fetched && !linearServer) return
  const now = await $.clock.now()
  if (!(await read($, items)).some(i => i.key === key)) return
  await update($, issueStatuses, map => ({ ...map, [key]: fetched ? { ...fetched, checkedAt: now } : { ...map[key], checkedAt: now } }))
  ensureWatching($)
}

async function refresh($: $, key: string) {
  if (inflight.has(key)) return
  if (isIssueKey(key)) {
    inflight.add(key)
    try {
      await refreshIssue($, key)
    } finally {
      inflight.delete(key)
    }
    return
  }
  const item = (await read($, items)).find(i => i.key === key)
  const ref = item && prRef(item.url)
  if (!ref) return
  inflight.add(key)
  try {
    const argv = ['gh', 'pr', 'view', String(ref.number), '-R', ref.repo, '--json', PR_FIELDS]
    const ran = await $.process.run(argv, { timeoutMs: 20_000 }).catch(() => null)
    const fetched = ran?.exitCode === 0 ? parsePrJson(ran.stdout) : undefined
    const now = await $.clock.now()
    if (!(await read($, items)).some(i => i.key === key)) return
    await update($, prStatuses, map => ({ ...map, [key]: nextStatus(map[key], fetched, now) }))
    if (fetched?.ci === 'running') ensurePolling($)
    ensureWatching($)
  } finally {
    inflight.delete(key)
  }
}

// One at a time, in band order, off the hook's path so `gh` never holds a prompt.
function refreshSoon($: $, keys: readonly string[], isForced = false) {
  if (keys.length === 0) return
  try {
    $.clock.after(1, () =>
      void (async () => {
        await update($, refreshing, n => n + 1)
        try {
          for (const key of keys) {
            const now = await $.clock.now()
            const s = isIssueKey(key) ? (await read($, issueStatuses))[key] : (await read($, prStatuses))[key]
            if (isForced || isStale(s, now, RECHECK_MS)) await refresh($, key)
          }
        } finally {
          await update($, refreshing, n => Math.max(0, n - 1))
        }
      })().catch(() => undefined),
    )
  } catch {
    // a refused timer leaves the status to the next mention or poll
  }
}

let isBackfilling = false

// Once per session, the links already in the transcript. An empty transcript (a new
// session, or one whose history has not loaded yet) leaves it to the next trigger.
async function backfill($: $) {
  if (isBackfilling || (await read($, hasBackfilled))) return
  isBackfilling = true
  try {
    const messages = await $.session.messages()
    if (messages.length === 0) return
    const gone = await read($, dismissed)
    const past = linksFromHistory(messages.map(m => m.text.slice(0, MAX_TEXT)), MAX_STORED, gone)
    await update($, items, list => mergeLinks(past, list, MAX_STORED))
    await persist($)
    await update($, hasBackfilled, () => true)
    refreshSoon($, (await read($, items)).map(i => i.key).filter(isChecked))
  } finally {
    isBackfilling = false
  }
}

function backfillSoon($: $) {
  try {
    $.clock.after(1, () => void backfill($).catch(() => undefined))
  } catch {
    // a refused timer leaves the backfill to the next trigger
  }
}

async function refreshAll($: $): Promise<number> {
  const keys = (await read($, items)).map(i => i.key).filter(isChecked)
  refreshSoon($, keys, true)
  return keys.length
}

async function dismiss($: $, key: string) {
  await update($, dismissed, keys => addKey(keys, key, MAX_DISMISSED))
  await update($, items, list => list.filter(i => i.key !== key))
  await persist($)
  await update($, prStatuses, ({ [key]: _, ...rest }) => rest)
  await update($, issueStatuses, ({ [key]: _, ...rest }) => rest)
}

// Cells the frame takes across: a border and its padding, or a fill's padding.
const frameColumns = (style: BandColor | null) => (!style ? 0 : style.isFill ? 2 : 4)

function frame(style: BandColor | null): Partial<BoxProps> {
  if (!style) return {}
  if (style.isFill) return { backgroundColor: style.color, paddingX: 1 }

  return { borderStyle: 'round', borderColor: style.color, paddingX: 1 }
}

async function setHidden($: $, value: boolean) {
  await update($, isHidden, () => value)
  await $.store.set('isHidden', value)
}

// Statuses read before the line counts were fetched.
async function fetchMissingCounts($: $) {
  const known = await read($, prStatuses)
  refreshSoon($, (await read($, items)).map(i => i.key).filter(k => isPrKey(k) && known[k] !== undefined && known[k].additions === undefined), true)
}

export const register: Register = (on, options) => {
  const browser = typeof options.browser === 'string' ? options.browser.trim() : ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'gh-linear-parse-mod',
      description: 'Toggle the GitHub/Linear links band (args: on, off, clear, reset, refresh, watch on|off, color <color> [fill])',
    })
    const stored = await $.store.get('isHidden')
    if (typeof stored === 'boolean') await update($, isHidden, () => stored)
    // entries from before links carried a `key` (runs, repos) are dropped on reload
    await update($, items, list => list.filter(i => i.key))
    // a reload ends the refresh loops that were counted
    await update($, refreshing, () => 0)
    await restore($).catch(() => undefined)
    backfillSoon($)
    await fetchMissingCounts($)
    await $.tool.register({
      name: 'links_band',
      description:
        "Returns this session's gh-linear-parse-mod links band: the GitHub PR and Linear links newest first (the band shows PRs above Linear links) with each PR's title, author, lines added and deleted, state, CI and review status, whether it has a merge conflict, and each Linear issue's status, as last checked, the links dismissed this session, whether the band is hidden or expanded, and its color. Read-only.",
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'set_status',
      description:
        "Sets this session's status line at the top of the gh-linear-parse-mod links band: a short note of what you are doing or waiting on (for example \"waiting on CI for #812\"), under 80 characters. Replaces any earlier status; an empty or missing text clears it. Set it when the person would want to see it at a glance, and clear it when the work is done.",
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The status; empty or left out clears it.' } },
      },
      isDeferred: false,
    })

    const known = Object.values(await read($, prStatuses))
    if (known.some(s => s.ci === 'running')) ensurePolling($)
    if (known.length > 0 || Object.keys(await read($, issueStatuses)).length > 0) ensureWatching($)
    // left by the removed Diff toggle
    if ((await $.store.keys()).includes('isDiff')) await $.store.delete('isDiff')
    // a reload draws the band with the new code without waiting for a change
    $.ui.invalidate('ui.render')

    return started
  })

  // A /clear ends the session with no session.start after it: the new conversation
  // starts with an empty band, keeping only the color and watch settings.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, items, () => [])
      await update($, prStatuses, () => ({}))
      await update($, issueStatuses, () => ({}))
      await update($, dismissed, () => [])
      await update($, isExpanded, () => false)
      await update($, hasBackfilled, () => false)
      await update($, agentStatus, () => null)
    }

    return next(e)
  })

  on('tool.call', { tool: STATE_TOOL }, async $ => {
    const [links, gone, hidden, expanded, color, known, watching] = await Promise.all([
      read($, items),
      read($, dismissed),
      read($, isHidden),
      read($, isExpanded),
      read($, bandColor),
      read($, prStatuses),
      read($, isWatching),
    ])
    const issues = await read($, issueStatuses)
    const state = {
      links: links.map(i => {
        const s = known[i.key]
        const issue = issues[i.key]
        if (isIssueKey(i.key) && issue) return { url: i.url, status: issue.name ?? 'unavailable', statusType: issue.type, checkedAt: new Date(issue.checkedAt).toISOString() }
        if (!isPrKey(i.key)) return { url: i.url }
        if (!s || s.state === 'unknown') return { url: i.url, status: s ? 'unavailable' : 'not checked yet' }
        return { url: i.url, title: s.title, author: s.author, additions: s.additions, deletions: s.deletions, state: s.state, ci: s.ci, hasConflict: s.hasConflict ?? false, review: s.review ?? 'none', checkedAt: new Date(s.checkedAt).toISOString() }
      }),
      dismissed: gone,
      isHidden: hidden,
      isExpanded: expanded,
      shownInBand: hidden ? 0 : expanded ? links.length : Math.min(links.length, SHOWN),
      isWatching: watching,
      isNudging: await isNudging($),
      agentStatus: (st => (st ? { text: st.text, setAt: new Date(st.setAt).toISOString() } : null))(await read($, agentStatus)),
      lastCheckedAt: (t => (t === undefined ? null : new Date(t).toISOString()))(lastChecked(links.map(i => i.key), { ...known, ...issues })),
      color,
    }

    return { result: JSON.stringify(state, null, 2) }
  })

  on('tool.call', { tool: STATUS_TOOL }, async ($, e) => {
    const text = (typeof e.text === 'string' ? e.text : '').replace(/\s+/g, ' ').trim().slice(0, MAX_STATUS)
    const setAt = await $.clock.now()
    await update($, agentStatus, () => (text ? { text, setAt } : null))
    return { result: text ? `Status set: ${text}` : 'Status cleared.' }
  })

  on('command.run', { command: 'gh-linear-parse-mod' }, async ($, e) => {
    const arg = e.args.trim()
    const [verb, ...words] = arg.split(/\s+/)
    if (verb === 'color') {
      const parsed = parseColorArgs(words)
      if (parsed.kind === 'invalid') {
        return {
          text: `Unknown color "${parsed.color}". Use a name (red, cyan, magentaBright), a hex value (#3b2a4a) or a theme key (subtle, claude), optionally followed by "fill".`,
        }
      }
      if (parsed.kind === 'clear') {
        await update($, bandColor, () => DEFAULT_COLOR)
        return { text: 'Band back to the default gray border for this session.' }
      }
      if (parsed.kind === 'none') {
        await update($, bandColor, () => null)
        return { text: 'Band border removed for this session.' }
      }
      await update($, bandColor, () => parsed.value)
      return {
        text: `Band ${parsed.value.isFill ? 'fill' : 'border'} set to ${parsed.value.color} for this session.`,
      }
    }
    if (arg === 'clear') {
      await update($, items, () => [])
      await update($, prStatuses, () => ({}))
      await update($, issueStatuses, () => ({}))
      await persist($)
      return { text: 'Cleared the session links.' }
    }
    if (verb === 'watch') {
      const [mode] = words
      if (mode !== undefined && mode !== 'on' && mode !== 'off') return { text: 'Use "watch on" or "watch off".' }
      const watching = mode === 'on' ? true : mode === 'off' ? false : !(await read($, isWatching))
      await update($, isWatching, () => watching)
      return {
        text: watching
          ? 'PR status refreshes every 5 minutes for open and draft PRs in view (this session).'
          : 'PR status auto-refresh off for this session; mentions, running CI and refresh still update it.',
      }
    }
    if (verb === 'nudge') {
      const [mode] = words
      if (mode !== undefined && mode !== 'on' && mode !== 'off') return { text: 'Use "nudge on" or "nudge off".' }
      const nudging = mode === 'on' ? true : mode === 'off' ? false : !(await isNudging($))
      await $.store.set('statusNudge', nudging)
      return {
        text: nudging
          ? 'Agents are asked to keep their status current with set_status (all sessions, from the next request).'
          : 'Agents are no longer asked to keep a status (all sessions); they can still set one.',
      }
    }
    if (arg === 'refresh') {
      const count = await refreshAll($)
      return { text: `Refreshing ${count} link${count === 1 ? '' : 's'}.` }
    }
    if (arg === 'reset') {
      await update($, dismissed, () => [])
      await persist($)
      return { text: 'Dismissed links will show again when they come up.' }
    }
    if (arg !== '' && arg !== 'on' && arg !== 'off') {
      // A bare color name sets the color, as `color <name>` does.
      const parsed = parseColorArgs([verb ?? '', ...words])
      if (parsed.kind === 'set') {
        await update($, bandColor, () => parsed.value)
        return { text: `Band ${parsed.value.isFill ? 'fill' : 'border'} set to ${parsed.value.color} for this session.` }
      }
      return { text: `Unknown option "${arg}". ${HELP}` }
    }
    const hidden = arg === 'off' ? true : arg === 'on' ? false : !(await read($, isHidden))
    await setHidden($, hidden)
    if (!hidden) backfillSoon($)
    return { text: hidden ? 'Session links hidden.' : 'Session links shown.' }
  })

  on('prompt.submit', async ($, e, next) => {
    refreshSoon($, await record($, e.text))
    backfillSoon($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    refreshSoon($, await record($, e.answer))
    backfillSoon($)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(STATUS_TOOL) || !(await isNudging($))) return composed

    return { sections: [...composed.sections.filter(c => c.id !== NUDGE.id), NUDGE] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const list = await read($, items)
    const note = await read($, agentStatus)
    if (list.length === 0 && !note) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const more = list.length - SHOWN
    const expanded = more > 0 && (await read($, isExpanded))
    const style = await read($, bandColor)
    const known = await read($, prStatuses)
    const visible = list.slice(0, expanded ? list.length : SHOWN)
    const issues = await read($, issueStatuses)
    const updatedAt = lastChecked(list.map(i => i.key), { ...known, ...issues })
    const isRefreshing = (await read($, refreshing)) > 0
    const { github, linear } = bandGroups(visible)
    const hasPr = github.length > 0
    const hasIssueSlot = linear.some(i => issues[i.key])
    const canRefresh = list.some(i => isPrKey(i.key)) || Object.keys(issues).some(k => list.some(i => i.key === k))
    const labels = new Map(visible.map(i => [i.key, linkLabel(i.url)]))
    // Each group is its own table, with its own project width.
    const width = (group: Item[]) => Math.max(0, ...group.map(i => labels.get(i.key)?.project.length ?? 0))
    const widths = { github: width(github), linear: width(linear) }
    const labelText = (i: Item) => {
      const { project, ref } = labels.get(i.key) ?? linkLabel(i.url)
      return ref ? `${project.padEnd(isPrKey(i.key) ? widths.github : widths.linear)} | ${ref}` : project
    }
    // PR labels padded to one width so the descriptions after them line up.
    const prWidth = Math.max(0, ...github.map(i => labelText(i).length))
    const issueWidth = Math.max(0, ...linear.filter(i => issues[i.key]?.name).map(i => labelText(i).length))
    const addWidth = Math.max(0, ...github.map(i => String(known[i.key]?.additions ?? '').length))
    const delWidth = Math.max(0, ...github.map(i => String(known[i.key]?.deletions ?? '').length))
    // Fixed two-cell slots line the emoji up under their labels whatever is in them.
    const slot = (key: string, text: string, isDim = false) => (
      <Box key={key} width={2}>
        <Text dimColor={isDim}>{text || ' '}</Text>
      </Box>
    )

    // Cells a row's Button has: the band less its frame and the `x `.
    const columns = Number.isFinite(e.props.bodyColumns) ? e.props.bodyColumns : Infinity
    const room = columns - frameColumns(style) - 2

    // The whole row past its `x` is one Button; the description is cut to fit, since a
    // Button's children wrap rather than truncate.
    const issueRow = (i: Item) => {
      const s = issues[i.key]
      const isDone = isIssueDone(s)
      const glyph = cell(issueGlyph(s))
      const slots = hasIssueSlot ? `${glyph} ` : ''
      const lead = textWidth(slots)
      const label = fitText(s?.name ? labelText(i).padEnd(issueWidth) : labelText(i), room - lead)
      const status = s?.name ? fitText(s.name, room - lead - textWidth(label) - 2) : ''
      return (
        <Box key={i.key} flexDirection="row" gap={1}>
          <Button key={`dismiss:${i.key}`} label="x" plain dimColor onPress={() => dismiss($, i.key)} />
          <Button key={`open:${i.key}`} plain onPress={() => void openLink($, i.url, browser)}>
            {slots && <Text dimColor={!s?.type}>{slots}</Text>}
            <Text color={TEXT_COLOR} bold={!isDone} dimColor={isDone}>
              {label}
            </Text>
            {status && <Text dimColor>{`  ${status}`}</Text>}
          </Button>
        </Box>
      )
    }

    const row = (i: Item) => {
      if (!isPrKey(i.key)) return issueRow(i)
      const s = known[i.key]
      const g = isPrKey(i.key) ? statusGlyphs(s) : undefined
      const isDone = s?.state === 'merged' || s?.state === 'closed'
      const short = s?.title ? shortTitle(s.title) : undefined
      const diff = diffParts(s, addWidth)
      const slots = hasPr ? `${cell(g?.ci ?? '')} ${cell(g?.rv ?? '')} ` : ''
      const lead = hasPr ? textWidth(cell(g?.pr ?? '')) + 1 + textWidth(slots) : 0
      const label = fitText(short || diff ? labelText(i).padEnd(prWidth) : labelText(i), room - lead)
      const by = s?.author ? `${authorInitials(s.author)} ` : ''
      const tag = short?.tag ? `${short.tag} · ` : ''
      const descRoom = room - lead - textWidth(label) - 2
      // Counts are never cut: they show whole or not at all, and the title takes what is left.
      const counts = diff ? `${by}${diff.plus} ${diff.minus}` : ''
      const fitsDiff = diff !== undefined && textWidth(counts) <= descRoom
      // Deletions padded so the titles after them line up.
      const gap = fitsDiff ? 2 + delWidth + 1 - diff.minus.length : 0
      const desc = !short
        ? ''
        : fitsDiff
          ? fitText(tag + short.text, descRoom - textWidth(counts) - gap)
          : fitText(by + tag + short.text, descRoom)
      return (
        <Box key={i.key} flexDirection="row" gap={1}>
          <Button key={`dismiss:${i.key}`} label="x" plain dimColor onPress={() => dismiss($, i.key)} />
          <Button key={`open:${i.key}`} plain onPress={() => void openLink($, i.url, browser)}>
            {hasPr && <Text dimColor={g?.isPending}>{cell(g?.pr ?? '')} </Text>}
            {slots}
            <Text color={TEXT_COLOR} bold={!isDone} dimColor={isDone}>
              {label}
            </Text>
            {!fitsDiff && desc && <Text dimColor>{`  ${desc}`}</Text>}
            {fitsDiff && <Text dimColor>{`  ${by}`}</Text>}
            {fitsDiff && (
              <Text color="green" dimColor={isDone}>
                {diff.plus}
              </Text>
            )}
            {fitsDiff && ' '}
            {fitsDiff && (
              <Text color="red" dimColor={isDone}>
                {diff.minus}
              </Text>
            )}
            {fitsDiff && desc && <Text dimColor>{`${' '.repeat(gap)}${desc}`}</Text>}
          </Button>
        </Box>
      )
    }

    // A section's header row: its column labels over the status cells, then its name.
    const section = (key: string, name: string, columns: string[]) => (
      <Box key={key} flexDirection="row" gap={1}>
        <Box key="pad" width={1} />
        {columns.map(c => slot(`label-${c.toLowerCase()}`, c, true))}
        <Text dimColor>{name}</Text>
      </Box>
    )

    const noteTime = note ? `  ${clockTime(note.setAt)}` : ''
    const statusSection = note && [
      section('status-header', 'Status', []),
      <Box key="status" flexDirection="row" gap={1}>
        <Button key="dismiss:status" label="x" plain dimColor onPress={() => update($, agentStatus, () => null)} />
        <Text>
          <Text italic>{fitText(note.text, room - textWidth(noteTime))}</Text>
          <Text dimColor>{noteTime}</Text>
        </Text>
      </Box>,
    ]
    const title = `Session links (${list.length})`
    const expandLabel = expanded ? 'Show less' : `Show ${more} more`
    // The time goes first when the header would not fit on one line.
    const actions = [canRefresh ? (isRefreshing ? 'Refreshing…' : 'Refresh') : '', more > 0 ? expandLabel : '', 'Hide']
    const headerLead = 2
    const headerNeeds = (withTime: boolean) =>
      headerLead + textWidth(title) + (withTime && updatedAt !== undefined ? 3 + textWidth(`updated ${clockTime(updatedAt)}`) : 0) +
      actions.filter(Boolean).reduce((n, a) => n + 1 + textWidth(a), 1)
    const showsUpdated = updatedAt !== undefined && headerNeeds(true) <= room + 2
    if (list.length === 0) {
      return (
        <Box flexDirection="column" {...frame(style)}>
          {statusSection}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" {...frame(style)}>
        <Box flexDirection="row" gap={1}>
          <Box key="pad" width={1} />
          <Text dimColor>{title}</Text>
          {showsUpdated && (
            <Box key="updated">
              <Text dimColor>· updated {clockTime(updatedAt)}</Text>
            </Box>
          )}
          <Box key="spacer" flexGrow={1} />
          {canRefresh && (
            <Button
              key="refresh"
              label={isRefreshing ? 'Refreshing…' : 'Refresh'}
              plain
              dimColor
              onPress={() => void refreshAll($)}
            />
          )}
          {more > 0 && (
            <Button
              key="expand"
              label={expandLabel}
              plain
              dimColor
              onPress={() => update($, isExpanded, v => !v)}
            />
          )}
          <Button key="hide" label="Hide" plain dimColor onPress={() => setHidden($, true)} />
        </Box>
        {statusSection}
        {hasPr && section('github-header', 'GitHub', ['PR', 'CI', 'Rv'])}
        {github.map(row)}
        {linear.length > 0 && section('linear-header', 'Linear', hasIssueSlot ? ['St'] : [])}
        {linear.map(row)}
      </Box>
    )
  })
}
