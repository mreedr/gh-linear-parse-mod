import { atom, read, update } from 'claude-code'
import type { BoxProps, EngineInterface, Register, UiPressArgument } from 'claude-code'

import type { StatusNote, BandColor, GroupingBase, IssueStatus, Item, PrGroup, PrStatus, SignedIn } from '../types'
import { openLink } from './browser'
import {
  PR_FIELDS,
  addKey,
  authorInitials,
  bandGroups,
  cell,
  clockTime,
  diffParts,
  editGroups,
  extractLinks,
  fitText,
  githubRows,
  isAwaitingReview,
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
  parseGroups,
  parsePrJson,
  prRef,
  shortTitle,
  shouldPoll,
  statusGlyphs,
  textWidth,
  watchKeys,
  withoutDone,
  withoutPrs,
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
const hidesAwaitingReview = atom({ plugin: 'gh-linear-parse-mod', key: 'hidesAwaitingReview' } as const, false)
const prGroups = atom({ plugin: 'gh-linear-parse-mod', key: 'prGroups' } as const, null as PrGroup[] | null)
const groupingBase = atom({ plugin: 'gh-linear-parse-mod', key: 'groupingBase' } as const, null as GroupingBase | null)
const showsLanded = atom({ plugin: 'gh-linear-parse-mod', key: 'showsLanded' } as const, false)
const isSigningIn = atom({ plugin: 'gh-linear-parse-mod', key: 'isSigningIn' } as const, false)
const isSigningInVercel = atom({ plugin: 'gh-linear-parse-mod', key: 'isSigningInVercel' } as const, false)
// null until the first check; 🔑 unless the check found it signed out (🔒)
const signedIn = atom({ plugin: 'gh-linear-parse-mod', key: 'signedIn' } as const, { gcloud: null, vercel: null } as SignedIn)

const SHOWN = 5
const MAX_STORED = 40
const MAX_TEXT = 200_000
const MAX_DISMISSED = 500
// a muted slate blue, readable on dark and light themes
const TEXT_COLOR = '#8b95b8'
const STATE_TOOL = 'mcp__gh-linear-parse-mod__links_band'
const STATUS_TOOL = 'mcp__gh-linear-parse-mod__set_status'
const GROUP_TOOL = 'mcp__gh-linear-parse-mod__group_prs'
const EDIT_TOOL = 'mcp__gh-linear-parse-mod__edit_groups'
const MAX_STATUS = 120
const RECHECK_MS = 15_000
// gcloud opens its sign-in page through Python's webbrowser, which takes BROWSER as a plain program path.
const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
const SIGN_IN_MS = 5 * 60_000
const SIGN_IN_CHECK_MS = 5 * 60_000
// The token goes to /dev/null so it never reaches the mod; only the exit code matters.
const SIGN_IN_CHECKS: Record<keyof SignedIn, { argv: string[]; env?: Record<string, string> }> = {
  gcloud: { argv: ['sh', '-c', 'gcloud auth print-access-token --quiet >/dev/null 2>&1'] },
  vercel: { argv: ['npx', '-y', 'vercel', 'whoami'], env: { CI: '1' } },
}
// vercel login opens its device page through the `open` package, which ignores BROWSER: CI=1 keeps it
// from opening anything, and the band opens the page it prints in Brave.
const VERCEL_PAGE = /(https:\/\/vercel\.com\/oauth\/device\S*)\s/
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
  'Use no option to show or hide the band, or one of: add <url>, group [how], group clear, on, off, refresh, clear, reset, watch on|off, nudge on|off, color <color> [fill] (a color name alone works too).'

const NUDGE = {
  id: 'gh-linear-parse-mod:status-nudge',
  scope: 'session',
  text: `Keep a status line current in the links band above the prompt with ${STATUS_TOOL}: set it, in under 80 characters, when you start work that will take more than a minute or begin waiting on something (CI, a subagent, a review); update it when that changes; and clear it with an empty text when you finish. Only the main conversation sets it; subagents leave it alone.`,
} as const

// While PRs are grouped, each request's system prompt asks the agent to keep the grouping current.
const GROUP_NUDGE = {
  id: 'gh-linear-parse-mod:group-nudge',
  scope: 'session',
  text: `The person has grouped the PRs in the links band above the prompt. After you open, merge or close a PR, read ${STATE_TOOL}: when its sinceGrouping lists open PRs in no group, or the plan's steps have moved on, change the grouping with ${EDIT_TOOL}, or lay it out again with ${GROUP_TOOL} when most of it moves. Tick a step with ${EDIT_TOOL} once it is done. Merged and closed PRs leave their groups on their own.`,
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

const isGroup = (x: unknown): x is PrGroup =>
  typeof x === 'object' && x !== null && Array.isArray((x as PrGroup).prs) && (x as PrGroup).prs.every(k => typeof k === 'string')

const isStrings = (x: unknown): x is string[] => Array.isArray(x) && x.every(k => typeof k === 'string')
const isBase = (x: unknown): x is GroupingBase =>
  typeof x === 'object' && x !== null && isStrings((x as GroupingBase).seen) && isStrings((x as GroupingBase).live)

// Each session's links and dismissals, kept across restarts so a resumed session gets
// its band back even when compaction took the links out of the transcript.
async function persist($: $) {
  try {
    const id = await $.session.id()
    const [list, gone, groups, base] = await Promise.all([read($, items), read($, dismissed), read($, prGroups), read($, groupingBase)])
    const saved = await $.store.get('sessions')
    const index = Array.isArray(saved) ? saved.filter((s): s is string => typeof s === 'string') : []
    const ids = [id, ...index.filter(s => s !== id)]
    for (const old of ids.slice(SAVED_SESSIONS)) await $.store.delete(`links:${old}`)
    await $.store.set(`links:${id}`, { items: list, dismissed: gone, groups, base })
    await $.store.set('sessions', ids.slice(0, SAVED_SESSIONS))
  } catch {
    // an unsaved band is rebuilt from the transcript on resume
  }
}

async function restore($: $) {
  if ((await read($, items)).length > 0) return
  const saved = (await $.store.get(`links:${await $.session.id()}`)) as { items?: unknown; dismissed?: unknown; groups?: unknown; base?: unknown } | undefined
  if (!saved || !Array.isArray(saved.items)) return
  const list = saved.items.filter(isItem)
  const gone = Array.isArray(saved.dismissed) ? saved.dismissed.filter((k): k is string => typeof k === 'string') : []
  await update($, dismissed, keys => (keys.length > 0 ? keys : gone))
  await update($, items, current => (current.length > 0 ? current : list))
  const groups = Array.isArray(saved.groups) ? saved.groups.filter(isGroup) : []
  if (groups.length > 0) await update($, prGroups, current => current ?? groups)
  if (groups.length > 0 && isBase(saved.base)) await update($, groupingBase, current => current ?? (saved.base as GroupingBase))
  refreshSoon($, list.map(i => i.key).filter(isChecked))
}

// Claude Code wipes a mod's $.state on /clear, so the band's values ride across in
// module memory and are written back once the wipe is done.
type Carried = {
  items: Item[]
  isHidden: boolean
  dismissed: string[]
  bandColor: BandColor | null
  hasBackfilled: boolean
  isExpanded: boolean
  prStatuses: Record<string, PrStatus>
  isWatching: boolean
  issueStatuses: Record<string, IssueStatus>
  hidesAwaitingReview: boolean
  prGroups: PrGroup[] | null
  groupingBase: GroupingBase | null
  showsLanded: boolean
  signedIn: SignedIn
}

async function carry($: $): Promise<Carried> {
  return {
    items: await read($, items),
    isHidden: await read($, isHidden),
    dismissed: await read($, dismissed),
    bandColor: await read($, bandColor),
    hasBackfilled: await read($, hasBackfilled),
    isExpanded: await read($, isExpanded),
    prStatuses: await read($, prStatuses),
    isWatching: await read($, isWatching),
    issueStatuses: await read($, issueStatuses),
    hidesAwaitingReview: await read($, hidesAwaitingReview),
    prGroups: await read($, prGroups),
    groupingBase: await read($, groupingBase),
    showsLanded: await read($, showsLanded),
    signedIn: await read($, signedIn),
  }
}

async function putBack($: $, c: Carried) {
  await update($, items, () => c.items)
  await update($, isHidden, () => c.isHidden)
  await update($, dismissed, () => c.dismissed)
  await update($, bandColor, () => c.bandColor)
  await update($, hasBackfilled, () => c.hasBackfilled)
  await update($, isExpanded, () => c.isExpanded)
  await update($, prStatuses, () => c.prStatuses)
  await update($, isWatching, () => c.isWatching)
  await update($, issueStatuses, () => c.issueStatuses)
  await update($, hidesAwaitingReview, () => c.hidesAwaitingReview)
  await update($, prGroups, () => c.prGroups)
  await update($, groupingBase, () => c.groupingBase)
  await update($, showsLanded, () => c.showsLanded)
  await update($, signedIn, () => c.signedIn)
}

// The new session id arrives after the /clear, so the first prompt saves the band under it.
let isUnsavedAfterClear = false

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
  await update($, prGroups, groups => groups && withoutPrs(groups, [key]))
  await persist($)
  await update($, prStatuses, ({ [key]: _, ...rest }) => rest)
  await update($, issueStatuses, ({ [key]: _, ...rest }) => rest)
}

async function copyLink($: $, url: string, press: UiPressArgument) {
  const copied = await $.ui.copy({ text: url, surface: press.surface }).catch(() => null)
  $.ui.toast(copied?.isCopied ? `Copied ${url}` : 'Could not copy the link')
}

const isFinished = (s: PrStatus | undefined) => s?.state === 'merged' || s?.state === 'closed'

// Dismisses the merged and closed PRs, so a later mention does not bring them back.
async function sweep($: $) {
  const known = await read($, prStatuses)
  const keys = (await read($, items)).map(i => i.key).filter(k => isFinished(known[k]))
  if (keys.length === 0) return
  await update($, dismissed, gone => keys.reduce((acc, k) => addKey(acc, k, MAX_DISMISSED), gone))
  await update($, items, list => list.filter(i => !keys.includes(i.key)))
  await update($, prGroups, groups => {
    const left = groups && withoutDone(groups, keys)
    return left && left.length > 0 ? left : null
  })
  await persist($)
  await update($, prStatuses, s => Object.fromEntries(Object.entries(s).filter(([k]) => !keys.includes(k))))
}

async function setGroups($: $, groups: PrGroup[] | null) {
  const isSet = groups !== null && groups.length > 0
  const known = await read($, prStatuses)
  const prs = (await read($, items)).map(i => i.key).filter(isPrKey)
  await update($, prGroups, () => (isSet ? groups : null))
  await update($, groupingBase, () => (isSet ? { seen: prs, live: prs.filter(k => !isFinished(known[k])) } : null))
  await persist($)
}

// A grouping as the tool results name it: each group by its label, text or step, with its PR count.
const groupsSummary = (groups: readonly PrGroup[]) =>
  groups
    .map(g => (g.step ? `step "${g.step}"${g.isDone ? ' (done)' : ''}` : `${g.label ?? (g.text ? 'text' : 'unlabeled')} (${g.prs.length} PR${g.prs.length === 1 ? '' : 's'})`))
    .join(', ')

// PRs a grouping names that the band does not hold yet join it, even ones dismissed before.
async function takeLinks($: $, links: readonly Item[]) {
  const keys = links.map(l => l.key)
  await update($, dismissed, gone => gone.filter(k => !keys.includes(k)))
  const have = new Set((await read($, items)).map(i => i.key))
  const fresh = links.filter(l => !have.has(l.key))
  if (fresh.length > 0) await update($, items, list => mergeLinks(list, fresh, MAX_STORED))
  return fresh.map(l => l.key)
}

// Ticks a step, or unticks it, when it still holds that text.
async function toggleStep($: $, group: number, step: string) {
  await update($, prGroups, groups =>
    groups && groups.map((g, n) => (n === group && g.step === step ? (g.isDone ? { step: g.step, prs: g.prs } : { ...g, isDone: true }) : g)),
  )
  await persist($)
}

const groupPrompt = (how: string) =>
  `Group the PRs in the links band above the prompt with ${GROUP_TOOL}` +
  (how
    ? `: ${how}.`
    : '. Pick labels that fit the work, such as the order to merge or roll them out in, and add steps for the work in between that is not a PR.') +
  ` Read ${STATE_TOOL} first for the PRs and their state.`

// Cells the frame takes across: a border and its padding, or a fill's padding.
const frameColumns = (style: BandColor | null) => (!style ? 0 : style.isFill ? 2 : 4)

function frame(style: BandColor | null): Partial<BoxProps> {
  if (!style) return {}
  if (style.isFill) return { backgroundColor: style.color, paddingX: 1 }

  return { borderStyle: 'round', borderColor: style.color, paddingX: 1 }
}

// App buttons (gcloud, vercel) sit apart from the title, left of the band's own buttons.
const APP_GAP = 1

async function checkSignedIn($: $, cli: keyof SignedIn) {
  const { argv, env } = SIGN_IN_CHECKS[cli]
  const ran = await $.process.run(argv, { ...(env && { env }), timeoutMs: 30_000 }).catch(() => null)
  if (ran) await update($, signedIn, s => ({ ...s, [cli]: ran.exitCode === 0 }))
}

const checkSignIns = ($: $) => Promise.all([checkSignedIn($, 'gcloud'), checkSignedIn($, 'vercel')])

// /clear and /resume start the session again; one timer is enough.
let isCheckingSignIns = false

const lock = (s: boolean | null) => (s === false ? '🔒' : '🔑')

async function gcloudLogin($: $) {
  if (await read($, isSigningIn)) return
  await update($, isSigningIn, () => true)
  try {
    const ran = await $.process.run(['gcloud', 'auth', 'login'], { env: { BROWSER: BRAVE }, timeoutMs: SIGN_IN_MS }).catch(() => null)
    const reason = ran?.stderr.trim().split('\n').filter(Boolean).at(-1)
    $.ui.toast(ran?.exitCode === 0 ? 'gcloud: signed in' : `gcloud sign-in failed${reason ? `: ${reason.slice(0, 120)}` : ''}`)
  } finally {
    await update($, isSigningIn, () => false)
    await checkSignedIn($, 'gcloud')
  }
}

async function vercelLogin($: $) {
  if (await read($, isSigningInVercel)) return
  await update($, isSigningInVercel, () => true)
  const login = $.process.spawn({ argv: ['npx', '-y', 'vercel', 'login'], env: { CI: '1' } })
  let isTimedOut = false
  const giveUp = $.clock.after(SIGN_IN_MS, () => {
    isTimedOut = true
    void login.return({ code: null, signal: null }).catch(() => undefined)
  })
  let output = ''
  let isOpened = false
  try {
    for await (const { text } of login) {
      output += text
      const page = isOpened ? undefined : VERCEL_PAGE.exec(output)?.[1]
      if (page) {
        isOpened = true
        await $.process.run(['open', '-a', 'Brave Browser', page]).catch(() => undefined)
      }
    }
    const ended = await login.result.catch(() => null)
    const reason = output.trim().split('\n').map(l => l.trim()).filter(l => l && l !== '>').at(-1)
    $.ui.toast(
      ended?.code === 0 ? 'vercel: signed in'
        : isTimedOut ? 'vercel sign-in timed out'
          : `vercel sign-in failed${reason ? `: ${reason.slice(0, 120)}` : ''}`,
    )
  } catch {
    $.ui.toast('vercel sign-in failed: npx vercel did not start')
  } finally {
    giveUp.cancel()
    await update($, isSigningInVercel, () => false)
    await checkSignedIn($, 'vercel')
  }
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
      description: 'Toggle the GitHub/Linear links band (args: add <url>, group [how], group clear, on, off, clear, reset, refresh, watch on|off, color <color> [fill])',
    })
    const stored = await $.store.get('isHidden')
    if (typeof stored === 'boolean') await update($, isHidden, () => stored)
    // entries from before links carried a `key` (runs, repos) are dropped on reload
    await update($, items, list => list.filter(i => i.key))
    // a reload ends the refresh loops that were counted
    await update($, refreshing, () => 0)
    await update($, isSigningIn, () => false)
    await update($, isSigningInVercel, () => false)
    void checkSignIns($)
    if (!isCheckingSignIns) {
      isCheckingSignIns = true
      $.clock.every(SIGN_IN_CHECK_MS, () => void checkSignIns($))
    }
    await restore($).catch(() => undefined)
    backfillSoon($)
    await fetchMissingCounts($)
    await $.tool.register({
      name: 'links_band',
      description:
        "Returns this session's gh-linear-parse-mod links band: the GitHub PR and Linear links newest first (the band shows PRs above Linear links) with each PR's title, author, lines added and deleted, state, CI and review status, whether it has a merge conflict, and each Linear issue's status, as last checked, the links dismissed this session, whether the band is hidden or expanded, its color, and, while PRs are grouped, the groups top to bottom (each a label, text and PRs, or a step and whether it is done) and sinceGrouping: the grouped PRs that merged or closed and the open PRs that joined the band since group_prs or edit_groups last changed the groups. Read-only.",
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
    await $.tool.register({
      name: 'group_prs',
      description:
        "Sets how the GitHub section of the gh-linear-parse-mod links band is grouped: a list of groups, top to bottom, each with an optional label (a divider such as \"round 1\" or \"blocked\"), an optional line of text, and optional PRs (PR links, owner/repo#N, or repo#N for a repo already in the band), or else a step: a to-do row of its own for work that is not a PR, such as \"apply the migration\", which shows a box ticked once done. Sends the whole layout each time and replaces the last one; an empty list clears it. For a small change, such as moving one PR, editing one group's text or ticking a step, use edit_groups instead. PRs not in any group show under \"other\". Use it only when the person asks you to group or order PRs (for example through /gh-linear-parse-mod group), or to keep a grouping they asked for current. Merged and closed PRs leave their groups on their own and fold into a landed row at the bottom, and a group whose PRs have all landed shows a ✓, so never make a group for merged or closed PRs.",
      inputSchema: {
        type: 'object',
        properties: {
          groups: {
            type: 'array',
            description: 'The groups, top to bottom; empty clears the grouping.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'The divider text, under 60 characters.' },
                text: { type: 'string', description: 'A line of text under the label, under 200 characters.' },
                prs: { type: 'array', items: { type: 'string' }, description: 'The PRs in this group, in order.' },
                step: { type: 'string', description: 'Makes this group a step, a to-do row of its own, under 120 characters; it takes no label, text or PRs.' },
                done: { type: 'boolean', description: 'For a step: whether it is done.' },
              },
            },
          },
        },
        required: ['groups'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'edit_groups',
      description:
        "Changes the gh-linear-parse-mod links band's PR groups in place, one edit after another, without resending the layout. A group is its 0-based place in links_band's groups, and each edit sees the groups as the edits before it left them. Ops: put (pr into group, at a place in it or last, taken out of any other group), remove (pr out of its group, back under \"other\"), set (a group's label or text, an empty string clears one; a step's step text, or done to tick it), insert (a new group at a place or last, with a label, text and PRs, or a step), delete (a group; its PRs go back under \"other\"). A group left with nothing in it goes. PRs are PR links, owner/repo#N, or repo#N for a repo already in the band.",
      inputSchema: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            description: 'The edits, applied in order.',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['put', 'remove', 'set', 'insert', 'delete'] },
                pr: { type: 'string', description: 'For put and remove: the PR.' },
                group: { type: 'number', description: 'For put, set and delete: the group, 0-based.' },
                at: { type: 'number', description: 'For put: the place in the group; for insert: the place among the groups. Last when left out.' },
                label: { type: 'string', description: 'For set and insert: the divider text.' },
                text: { type: 'string', description: 'For set and insert: the line of text under the label.' },
                prs: { type: 'array', items: { type: 'string' }, description: 'For insert: the PRs in the new group.' },
                step: { type: 'string', description: "For set and insert: a step's text." },
                done: { type: 'boolean', description: 'For set and insert: whether the step is done.' },
              },
              required: ['op'],
            },
          },
        },
        required: ['edits'],
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

  // A /clear goes on under a new session id with no session.start and a wiped $.state: the
  // band carries over so the new task can still reach its links; the old task's status goes.
  // A /resume swaps in another session, whose session.start restores its own band.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, agentStatus, () => null)
      const carried = await carry($)
      $.clock.after(1, async () => {
        await putBack($, carried)
        await persist($)
        isUnsavedAfterClear = true
      })
    }
    if (e.reason === 'resume') {
      await update($, items, () => [])
      await update($, prStatuses, () => ({}))
      await update($, issueStatuses, () => ({}))
      await update($, dismissed, () => [])
      await update($, isExpanded, () => false)
      await update($, hasBackfilled, () => false)
      await update($, agentStatus, () => null)
      await update($, prGroups, () => null)
      await update($, groupingBase, () => null)
      await update($, showsLanded, () => false)
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
    const groups = await read($, prGroups)
    const base = await read($, groupingBase)
    const hidesReview = await read($, hidesAwaitingReview)
    const inView = hidesReview ? links.filter(i => !isAwaitingReview(known[i.key])) : links
    const grouped = new Set(groups?.flatMap(g => g.prs) ?? [])
    // With groups up, merged and closed PRs fold into the landed row.
    const landed = groups ? inView.filter(i => isFinished(known[i.key])).length : 0
    const ungrouped = inView.filter(i => !grouped.has(i.key) && !(groups && isFinished(known[i.key]))).length
    const urlOf = (k: string) => links.find(i => i.key === k)?.url ?? k
    const sinceGrouping = groups && {
      landed: (base?.live ?? []).filter(k => grouped.has(k) && isFinished(known[k])).map(urlOf),
      notGrouped: links
        .filter(i => isPrKey(i.key) && !grouped.has(i.key) && !base?.seen.includes(i.key) && !isFinished(known[i.key]))
        .map(i => i.url),
    }
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
      shownInBand: hidden
        ? 0
        : inView.length - ungrouped - landed + (expanded ? ungrouped : Math.min(ungrouped, SHOWN)) + ((await read($, showsLanded)) ? landed : 0),
      hidesAwaitingReview: hidesReview,
      groups: groups && groups.map(g => ({ ...g, prs: g.prs.map(urlOf) })),
      sinceGrouping,
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

  on('tool.call', { tool: GROUP_TOOL }, async ($, e) => {
    const { groups, links, skipped, repeated } = parseGroups(e.groups, await read($, items))
    const fresh = await takeLinks($, links)
    await setGroups($, groups)
    refreshSoon($, fresh, true)
    const notes = [
      skipped.length > 0 && `Skipped (not a PR link, owner/repo#N, or a repo#N for a repo in the band): ${skipped.join(', ')}.`,
      repeated.length > 0 && `Already in an earlier group, so left there: ${repeated.join(', ')}.`,
    ].filter(Boolean)
    const summary =
      groups.length === 0
        ? 'Grouping cleared; the GitHub section is newest first again.'
        : `Grouped the GitHub section: ${groupsSummary(groups)}.`

    return { result: [summary, ...notes].join(' ') }
  })

  on('tool.call', { tool: EDIT_TOOL }, async ($, e) => {
    const { groups, links, notes } = editGroups((await read($, prGroups)) ?? [], e.edits, await read($, items))
    const fresh = await takeLinks($, links)
    await setGroups($, groups)
    refreshSoon($, fresh, true)
    const summary = groups.length === 0 ? 'No groups left; the GitHub section is newest first again.' : `Groups now: ${groupsSummary(groups)}.`

    return { result: [summary, ...notes].join(' ') }
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
    if (verb === 'group') {
      if (words.join(' ') === 'clear') {
        await setGroups($, null)
        return { text: 'Grouping cleared; the GitHub section is newest first again.' }
      }
      // Submitted from a timer, since a command's own hook cannot start a turn.
      const text = groupPrompt(words.join(' '))
      $.clock.after(1, () => void $.prompt.submit({ text, asUser: true }).catch(() => undefined))
      return { text: 'Asked Claude to group the PRs in the band.' }
    }
    if (arg === 'clear') {
      await update($, prGroups, () => null)
      await update($, groupingBase, () => null)
      await update($, showsLanded, () => false)
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
    if (verb === 'add') {
      const found = extractLinks(words.join(' '))
      if (found.length === 0) return { text: 'No GitHub PR or Linear link found. Use "add <url>".' }
      const keys = found.map(l => l.key)
      await update($, dismissed, gone => gone.filter(k => !keys.includes(k)))
      refreshSoon($, await record($, words.join(' ')), true)
      if (await read($, isHidden)) {
        await setHidden($, false)
        backfillSoon($)
      }
      return { text: `Added ${found.map(l => l.url).join(', ')}.` }
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
    if (isUnsavedAfterClear) {
      isUnsavedAfterClear = false
      await persist($)
    }
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
    const nudges = [
      ...(e.tools.includes(STATUS_TOOL) && (await isNudging($)) ? [NUDGE] : []),
      ...(e.tools.includes(GROUP_TOOL) && (await read($, prGroups)) ? [GROUP_NUDGE] : []),
    ]
    if (nudges.length === 0) return composed

    return { sections: [...composed.sections.filter(c => !nudges.some(n => n.id === c.id)), ...nudges] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const list = await read($, items)
    const note = await read($, agentStatus)
    if (list.length === 0 && !note) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const groups = (await read($, prGroups)) ?? []
    const grouped = new Set(groups.flatMap(g => g.prs))
    const known = await read($, prStatuses)
    // 👀 in the header hides the PRs waiting on a review, and shows them again.
    const hidesReview = await read($, hidesAwaitingReview)
    const awaiting = list.filter(i => isAwaitingReview(known[i.key])).length
    const shown = hidesReview ? list.filter(i => !isAwaitingReview(known[i.key])) : list
    // Grouped PRs always show; Show N more collapses the rest. With groups up, merged and
    // closed PRs leave them for one landed row, folded until pressed.
    const isLanded = (i: Item) => groups.length > 0 && isFinished(known[i.key])
    const landedItems = shown.filter(isLanded)
    const rest = shown.filter(i => !grouped.has(i.key) && !isLanded(i))
    const more = rest.length - SHOWN
    const expanded = more > 0 && (await read($, isExpanded))
    const style = await read($, bandColor)
    const visible = rest.slice(0, expanded ? rest.length : SHOWN)
    const issues = await read($, issueStatuses)
    const updatedAt = lastChecked(list.map(i => i.key), { ...known, ...issues })
    const isRefreshing = (await read($, refreshing)) > 0
    const auth = await read($, signedIn)
    const signInLabel = (await read($, isSigningIn)) ? '🔑 gcloud…' : `${lock(auth.gcloud)} gcloud`
    const vercelLabel = (await read($, isSigningInVercel)) ? '🔑 vercel…' : `${lock(auth.vercel)} vercel`
    const { github: ungrouped, linear } = bandGroups(visible)
    const landed = {
      items: landedItems,
      finished: new Set(list.filter(isLanded).map(i => i.key)),
      listed: new Set(list.map(i => i.key)),
      isOpen: await read($, showsLanded),
    }
    const githubLayout = githubRows(groups, shown, ungrouped, landed)
    const github = githubLayout.flatMap(r => (r.kind === 'pr' ? [r.item] : []))
    const hasPr = github.length > 0
    const hasIssueSlot = linear.some(i => issues[i.key])
    const canSweep = list.some(i => isFinished(known[i.key]))
    const reviewLabel = hidesReview ? `👀 ${awaiting}` : '👀'
    const canRefresh = list.some(i => isPrKey(i.key)) || Object.keys(issues).some(k => list.some(i => i.key === k))
    const labels = new Map([...github, ...linear].map(i => [i.key, linkLabel(i.url)]))
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
    // A link row also ends in its copy button: the spacer's gap, the button's and its two cells.
    const linkRoom = room - 4
    const copyButton = (i: Item) => [
      <Box key="spacer" flexGrow={1} />,
      <Button key={`copy:${i.key}`} label="📄" plain dimColor onPress={press => void copyLink($, i.url, press)} />,
    ]

    // The whole row past its `x` is one Button; the description is cut to fit, since a
    // Button's children wrap rather than truncate.
    const issueRow = (i: Item) => {
      const s = issues[i.key]
      const isDone = isIssueDone(s)
      const glyph = cell(issueGlyph(s))
      const slots = hasIssueSlot ? `${glyph} ` : ''
      const lead = textWidth(slots)
      const label = fitText(s?.name ? labelText(i).padEnd(issueWidth) : labelText(i), linkRoom - lead)
      const status = s?.name ? fitText(s.name, linkRoom - lead - textWidth(label) - 2) : ''
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
          {copyButton(i)}
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
      const label = fitText(short || diff ? labelText(i).padEnd(prWidth) : labelText(i), linkRoom - lead)
      const by = s?.author ? `${authorInitials(s.author)} ` : ''
      const tag = short?.tag ? `${short.tag} · ` : ''
      const descRoom = linkRoom - lead - textWidth(label) - 2
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
          {copyButton(i)}
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

    // A group's label is a dim divider and its text a dim italic line; a done group gets a ✓.
    const githubRow = (r: (typeof githubLayout)[number]) => {
      if (r.kind === 'pr') return row(r.item)
      if (r.kind === 'landed') {
        return (
          <Box key="group-landed" flexDirection="row" gap={1}>
            <Box key="pad" width={1} />
            <Button
              key="landed"
              label={`── ${r.isOpen ? '▾' : '▸'} landed (${r.count}) ──`}
              plain
              dimColor
              onPress={() => update($, showsLanded, v => !v)}
            />
          </Box>
        )
      }
      // A step is a to-do row; pressing it ticks or unticks it.
      if (r.kind === 'step') {
        return (
          <Box key={`group-step:${r.group}`} flexDirection="row" gap={1}>
            <Box key="pad" width={1} />
            <Button
              key={`step:${r.group}`}
              label={fitText(`${r.isDone ? '☑' : '☐'} ${r.text}`, room)}
              plain
              dimColor={r.isDone}
              onPress={() => toggleStep($, r.group, r.text)}
            />
          </Box>
        )
      }
      const key = r.group === undefined ? 'group-other' : `group-${r.kind}:${r.group}`
      const done = r.isDone ? ' ✓' : ''
      const text = r.kind === 'label' ? `── ${r.text}${done} ──` : `   ${r.text}${done}`
      return (
        <Box key={key} flexDirection="row" gap={1}>
          <Box key="pad" width={1} />
          <Text dimColor italic={r.kind === 'text'}>
            {fitText(text, room)}
          </Text>
        </Box>
      )
    }

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
    const actions = [signInLabel, vercelLabel, canRefresh ? (isRefreshing ? 'Refreshing…' : 'Refresh') : '', awaiting > 0 ? reviewLabel : '', canSweep ? '🧹' : '', more > 0 ? expandLabel : '', 'Hide']
    const headerLead = 2
    const headerNeeds = (withTime: boolean) =>
      headerLead + textWidth(title) + (withTime && updatedAt !== undefined ? 3 + textWidth(`updated ${clockTime(updatedAt)}`) : 0) +
      actions.filter(Boolean).reduce((n, a) => n + 1 + textWidth(a), 1) + APP_GAP + 1
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
          <Box key="app-gap" width={APP_GAP} />
          <Button key="gcloud-login" label={signInLabel} plain dimColor onPress={() => void gcloudLogin($)} />
          <Button key="vercel-login" label={vercelLabel} plain dimColor onPress={() => void vercelLogin($)} />
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
          {awaiting > 0 && (
            <Button
              key="awaiting-review"
              label={reviewLabel}
              plain
              dimColor={hidesReview}
              onPress={() => update($, hidesAwaitingReview, v => !v)}
            />
          )}
          {canSweep && <Button key="sweep" label="🧹" plain onPress={() => sweep($)} />}
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
        {githubLayout.length > 0 && section('github-header', 'GitHub', ['PR', 'CI', 'Rv'])}
        {githubLayout.map(githubRow)}
        {linear.length > 0 && section('linear-header', 'Linear', hasIssueSlot ? ['St'] : [])}
        {linear.map(row)}
      </Box>
    )
  })
}
