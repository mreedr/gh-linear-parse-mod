import type { BandColor, CI, GroupEdit, IssueStatus, IssueType, Item, PrGroup, PrState, PrStatus, Review } from '../types'

export type Link = Item

const LINK = /https?:\/\/(?:www\.)?(?:github\.com|linear\.app)\/[^\s<>"'`()[\]{}\\]+/gi
const TRAILING = /[.,;:!?*_]+$/

function githubLink(parts: string[]): Link | undefined {
  const [owner, repo, kind, number] = parts
  if (!owner || !repo || kind !== 'pull' || !number || !/^\d+$/.test(number)) return undefined

  return {
    key: `github:${owner}/${repo}#${number}`.toLowerCase(),
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
  }
}

function linearLink(parts: string[]): Link | undefined {
  const [workspace, kind, id] = parts
  if (!workspace || !kind) return undefined

  const url = `https://linear.app/${parts.join('/')}`
  if (kind === 'issue' && id && /^[A-Za-z]+-\d+$/.test(id)) {
    return { key: `linear:${workspace}/issue/${id}`.toLowerCase(), url }
  }

  return { key: url.toLowerCase(), url }
}

export function parseLink(raw: string): Link | undefined {
  const m = raw.replace(TRAILING, '').match(/^https?:\/\/(?:www\.)?(github\.com|linear\.app)\/([^?#]*)/i)
  if (!m) return undefined
  const parts = (m[2] ?? '').split('/').filter(Boolean)

  return m[1]?.toLowerCase() === 'github.com' ? githubLink(parts) : linearLink(parts)
}

// Only GitHub pull requests and Linear pages count. A PR link collapses to
// its bare URL (no /files, query or fragment); a Linear issue keeps the URL as
// written, slug included, and the same issue with or without a slug shows once.
export function extractLinks(text: string): Link[] {
  const seen = new Set<string>()
  const links: Link[] = []

  for (const m of text.matchAll(LINK)) {
    const link = parseLink(m[0])
    if (!link || seen.has(link.key)) continue
    seen.add(link.key)
    links.push(link)
  }

  return links
}

// Past `max` the oldest dismissals fall off, so the stored list stays small.
export function addKey(keys: readonly string[], key: string, max: number): string[] {
  return [...keys.filter(k => k !== key), key].slice(-max)
}

const THEME_KEYS = [
  'text', 'inverseText', 'inactive', 'subtle', 'suggestion', 'remember', 'success', 'error',
  'warning', 'merged', 'claude', 'permission', 'planMode', 'autoAccept', 'promptBorder',
  'bashBorder', 'ide', 'diffAdded', 'diffRemoved', 'diffAddedDimmed', 'diffRemovedDimmed',
  'diffAddedWord', 'diffRemovedWord',
]
const NAMED = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray', 'grey']

export type ColorArg =
  | { kind: 'clear' }
  | { kind: 'none' }
  | { kind: 'set'; value: BandColor }
  | { kind: 'invalid'; color: string }

// `color` alone or `color reset` goes back to the default, `color none` drops the
// border; `color <c> [fill]` sets. A color is a
// terminal name (`red`, `cyanBright`), a hex value or a theme key.
export function parseColorArgs(words: readonly string[]): ColorArg {
  const [color, mode, ...rest] = words
  if (!color || color === 'reset') return { kind: 'clear' }
  if (color === 'none') return { kind: 'none' }
  if ((mode !== undefined && mode !== 'fill') || rest.length > 0) return { kind: 'invalid', color: words.join(' ') }

  const named = NAMED.find(n => n === color.toLowerCase() || `${n}bright` === color.toLowerCase())
  const theme = THEME_KEYS.find(k => k.toLowerCase() === color.toLowerCase())
  const resolved =
    named ? (color.toLowerCase().endsWith('bright') ? `${named}Bright` : named)
      : theme ?? (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color.toLowerCase() : undefined)
  if (!resolved) return { kind: 'invalid', color }

  return { kind: 'set', value: { color: resolved, isFill: mode === 'fill' } }
}

// Newest first: links in `found` go to the front in text order, and a link seen
// again moves up rather than repeating. Dismissed links never come back.
export function mergeLinks(
  list: readonly Link[],
  found: readonly Link[],
  max: number,
  dismissed: readonly string[] = [],
): Link[] {
  const fresh = found.filter(l => !dismissed.includes(l.key))
  const keys = new Set(fresh.map(l => l.key))

  return [...fresh, ...list.filter(l => !keys.has(l.key))].slice(0, max)
}

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

// Messages oldest first in, links newest first out, as if each had been seen live.
// Reminders the engine injects into user messages are not part of the discussion.
export function linksFromHistory(texts: readonly string[], max: number, dismissed: readonly string[] = []): Link[] {
  return texts.reduce<Link[]>(
    (list, text) => mergeLinks(list, extractLinks(text.replace(REMINDER, '')), max, dismissed),
    [],
  )
}

export const isPrKey = (key: string) => key.startsWith('github:')

export const isIssueKey = (key: string) => /^linear:[^/]+\/issue\/[a-z]+-\d+$/.test(key)

// `linear:acme/issue/eng-12` is `ENG-12`.
export const issueId = (key: string) => key.slice(key.lastIndexOf('/') + 1).toUpperCase()

export function prRef(url: string): { repo: string; number: number } | undefined {
  const m = url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/)

  return m?.[1] && m[2] ? { repo: m[1], number: Number(m[2]) } : undefined
}

type Check = {
  __typename?: string
  status?: string | null
  conclusion?: string | null
  state?: string | null
  name?: string | null
  context?: string | null
  workflowName?: string | null
  startedAt?: string | null
}

// The newest run of each check: a rerun or a newer push replaces the run it cancelled.
function latestRuns(rollup: readonly Check[]): Check[] {
  const latest = new Map<string, Check>()
  rollup.forEach((c, i) => {
    const name = c.name ?? c.context
    const key = name ? `${c.workflowName ?? ''}/${name}` : `#${i}`
    const seen = latest.get(key)
    if (!seen || (c.startedAt ?? '') >= (seen.startedAt ?? '')) latest.set(key, c)
  })

  return [...latest.values()]
}

export function ciSummary(all: readonly Check[] | null | undefined): CI {
  if (!all || all.length === 0) return 'none'
  const rollup = latestRuns(all)
  const bad = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
  if (rollup.some(c => bad.includes(c.conclusion ?? '') || bad.includes(c.state ?? ''))) return 'fail'
  const isRunning = (c: Check) =>
    c.__typename === 'StatusContext' || (c.__typename === undefined && c.state != null)
      ? c.state === 'PENDING' || c.state === 'EXPECTED'
      : c.status !== 'COMPLETED'
  if (rollup.some(isRunning)) return 'running'

  return 'pass'
}

export const PR_FIELDS = 'title,author,state,isDraft,reviewDecision,statusCheckRollup,reviewRequests,latestReviews,additions,deletions,mergeable'

export type Fetched = {
  state: PrState
  ci: CI
  review?: Review
  title?: string
  author?: string
  additions?: number
  deletions?: number
  hasConflict?: boolean
}

// Review apps whose comments are not a person asking for a change.
const BOTS = new Set(['claude', 'github-advanced-security', 'copilot-pull-request-reviewer', 'coderabbitai'])
const isBot = (login: string) => BOTS.has(login.toLowerCase()) || login.endsWith('[bot]')

export function parsePrJson(stdout: string): Fetched | undefined {
  let pr: {
    title?: string
    state?: string
    isDraft?: boolean
    reviewDecision?: string | null
    statusCheckRollup?: Check[] | null
    author?: { login?: string } | null
    reviewRequests?: unknown[] | null
    latestReviews?: { author?: { login?: string } | null; state?: string }[] | null
    additions?: number
    deletions?: number
    mergeable?: string
  }
  try {
    pr = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!pr || typeof pr.state !== 'string') return undefined

  const state: PrState =
    pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : 'open'
  const isLive = state === 'open' || state === 'draft'
  const others = (pr.latestReviews ?? []).filter(r => {
    const login = r.author?.login ?? ''
    return login !== pr.author?.login && !isBot(login)
  })
  // An open or draft PR nobody has been asked to review, and nobody has reviewed.
  const isUnassigned = isLive && (pr.reviewRequests?.length ?? 0) === 0 && others.length === 0
  // A person other than the author left a comment review, and nobody has approved.
  const isCommented = isLive && others.some(r => r.state === 'COMMENTED') && !others.some(r => r.state === 'APPROVED')
  // GitHub leaves reviewDecision empty when the base branch requires no review, as on a stacked PR.
  const review: Review | undefined =
    pr.reviewDecision === 'APPROVED' ? 'approved'
      : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes'
        : isCommented ? 'commented'
          : isUnassigned ? 'unassigned'
            : pr.reviewDecision === 'REVIEW_REQUIRED' || (isLive && (pr.reviewRequests?.length ?? 0) > 0) ? 'pending'
              : undefined

  const title = typeof pr.title === 'string' ? pr.title : undefined
  const author = pr.author?.login || undefined
  const hasDiff = typeof pr.additions === 'number' && typeof pr.deletions === 'number'
  // GitHub works mergeability out lazily: UNKNOWN until then, so only CONFLICTING counts.
  const hasConflict = isLive && pr.mergeable === 'CONFLICTING'

  return {
    state,
    ci: ciSummary(pr.statusCheckRollup),
    ...(review ? { review } : {}),
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(hasDiff ? { additions: pr.additions, deletions: pr.deletions } : {}),
    ...(hasConflict ? { hasConflict } : {}),
  }
}

// A failed check keeps what was known; `ciSince` marks when CI started running so
// polling can give up on a check that never finishes.
export function nextStatus(prev: PrStatus | undefined, fetched: Fetched | undefined, now: number): PrStatus {
  if (!fetched) return prev ? { ...prev, checkedAt: now } : { state: 'unknown', ci: 'none', checkedAt: now }
  const ciSince = fetched.ci === 'running' ? (prev?.ci === 'running' ? prev.ciSince ?? now : now) : undefined

  return { ...fetched, checkedAt: now, ...(ciSince !== undefined ? { ciSince } : {}) }
}

export const isStale = (s: PrStatus | IssueStatus | undefined, now: number, ms: number) => !s || now - s.checkedAt > ms

export const shouldPoll = (s: PrStatus | undefined, now: number, windowMs: number) =>
  s?.ci === 'running' && now - (s.ciSince ?? s.checkedAt) < windowMs

const PR_GLYPH: Record<PrState, string> = { open: '🟢', draft: '📝', merged: '🟣', closed: '⚫' }
const CI_GLYPH: Record<CI, string> = { pass: '✅', fail: '❌', running: '⏳', none: '' }
const CONFLICT_GLYPH = '💥'
const LANDED_GLYPH = '🌒'
const RV_GLYPH: Record<Review, string> = { approved: '🚀', pending: '👀', changes: '✋', unassigned: '🦯', commented: '💬' }

export type Glyphs = { pr: string; ci: string; rv: string; isPending: boolean }

// A PR that shows 👀: its review is requested and not given yet.
export const isAwaitingReview = (s: PrStatus | undefined) => statusGlyphs(s).rv === RV_GLYPH.pending

export function statusGlyphs(s: PrStatus | undefined): Glyphs {
  if (!s) return { pr: '…', ci: '', rv: '', isPending: true }
  if (s.state === 'unknown') return { pr: '?', ci: '', rv: '', isPending: true }

  // A draft is not asking for review yet, so no reviewer is not news.
  const isMoot = s.state === 'draft' && s.review === 'unassigned'
  const rv = s.state === 'merged' ? LANDED_GLYPH : !s.review || isMoot ? '' : RV_GLYPH[s.review]

  // A conflict blocks the merge whatever CI says, so it takes the CI cell.
  const ci = s.hasConflict ? CONFLICT_GLYPH : CI_GLYPH[s.ci]

  return { pr: PR_GLYPH[s.state], ci, rv, isPending: false }
}

// What the 5-minute watch re-checks: open and draft PRs, and ones not read yet. Merged
// and closed PRs do not change, and a PR on the 90-second CI poll is covered there.
export function watchKeys(
  keys: readonly string[],
  known: Readonly<Record<string, PrStatus>>,
  now: number,
  ciWindowMs: number,
): string[] {
  return keys.filter(k => {
    if (!isPrKey(k)) return false
    const s = known[k]
    if (!s || s.state === 'unknown') return true
    return (s.state === 'open' || s.state === 'draft') && !shouldPoll(s, now, ciWindowMs)
  })
}

export type Label = { project: string; ref: string }

// Dashes become spaces, except inside numbers such as dates.
const words = (slug: string) => slug.replace(/-[0-9a-f]{8,}$/i, '').replace(/(?<!\d)-|-(?!\d)/g, ' ')

// GitHub PRs read `repo | #N`; Linear issues `ENG-1 | slug words`, other Linear pages
// `kind | name`, then the tab when the link names one (`· overview`), so two tabs of one
// project read apart.
export function linkLabel(url: string): Label {
  const pr = prRef(url)
  if (pr) return { project: pr.repo.split('/')[1] ?? pr.repo, ref: `#${pr.number}` }

  const [, kind = '', id = '', ...rest] = url.replace(/^https?:\/\/[^/]+\//, '').split('/')
  if (kind === 'issue' && id) return { project: id.toUpperCase(), ref: words(rest[0] ?? '') }
  const tab = rest.filter(Boolean).join('/')
  return { project: kind, ref: tab ? `${words(id)} · ${tab}` : words(id) }
}

// PRs above Linear links, each group keeping its order.
export function bandGroups(list: readonly Item[]): { github: Item[]; linear: Item[] } {
  return { github: list.filter(i => isPrKey(i.key)), linear: list.filter(i => !isPrKey(i.key)) }
}

// When the band's PRs were last read from GitHub, failed reads included.
export function lastChecked(keys: readonly string[], known: Readonly<Record<string, { checkedAt: number }>>): number | undefined {
  const times = keys.map(k => known[k]?.checkedAt).filter((t): t is number => t !== undefined)
  return times.length > 0 ? Math.max(...times) : undefined
}

export const clockTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })

export type ShortTitle = { tag?: string; text: string }

const COMMIT_TYPES = new Set(['feat', 'fix', 'chore', 'build', 'perf', 'refactor', 'docs', 'test', 'ci', 'style', 'revert'])
const TICKET = /\b[A-Z]{2,}-\d+\b|#\d+|\bT\d+[a-z]?\b/
const CLAUSE = / (?:when|until|once|while|so|unless) |,? - |, (?:and|or|but|so|then) /

// A PR title cut to what it does: `feat(search): x when y (T2)` reads `search` and `x`.
export function shortTitle(title: string): ShortTitle {
  let text = title.trim().replace(/^(?:\[[^\]]*\]\s*)+/, '').replace(/^[A-Z]{2,}-\d+:\s*/, '')
  let tag: string | undefined

  const scoped = text.match(/^(\w+)\(([^)]+)\)!?:?\s+/)
  const bare = text.match(/^([a-z][\w-]*):\s+/)
  if (scoped) {
    tag = scoped[2]
    text = text.slice(scoped[0].length)
  } else if (bare?.[1]) {
    if (!COMMIT_TYPES.has(bare[1])) tag = bare[1]
    text = text.slice(bare[0].length)
  }

  text = text.replace(/\s*\(([^)]*)\)$/, (m, inner: string) => (TICKET.test(inner) ? '' : m))
  const cut = text.match(CLAUSE)
  if (cut?.index !== undefined && text.slice(0, cut.index).split(' ').length >= 2) text = text.slice(0, cut.index)

  return { ...(tag ? { tag } : {}), text: text.trim() }
}

const WIDE = /\p{Extended_Pictographic}/u

// Terminal cells: an emoji takes two, anything else one (variation selectors none).
export const textWidth = (text: string) =>
  [...text].reduce((n, ch) => n + (ch === '️' ? 0 : WIDE.test(ch) ? 2 : 1), 0)

// A status glyph in a two-cell slot.
export const cell = (glyph: string) => glyph + ' '.repeat(Math.max(0, 2 - textWidth(glyph)))

// `text` cut to `room` cells, an ellipsis marking the cut.
export function fitText(text: string, room: number): string {
  if (textWidth(text) <= room) return text
  if (room <= 0) return ''
  let out = ''
  for (const ch of text) {
    if (textWidth(out + ch) > room - 1) break
    out += ch
  }
  return `${out.trimEnd()}…`
}

// The PR author as two letters of their login, enough to tell the team apart.
export const authorInitials = (login: string) => login.slice(0, 2).toLowerCase().padEnd(2)

// A PR's changed lines as `+12 -3`, the additions padded to `width` digits so the
// deletions line up down the band.
export function diffParts(s: PrStatus | undefined, width: number): { plus: string; minus: string } | undefined {
  if (s?.additions === undefined || s.deletions === undefined) return undefined
  return { plus: `+${s.additions}`.padStart(width + 1), minus: `-${s.deletions}` }
}

const ISSUE_TYPES = new Set<string>(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate'])

// A Linear `get_issue` result: its status name and type, whether the server sends the
// status as a name or as `{ name, type }`.
export function parseIssueResult(r: { content: readonly { type: string; text?: string }[]; isError: boolean }): Omit<IssueStatus, 'checkedAt'> | undefined {
  if (r.isError) return undefined
  let issue: { status?: unknown; statusType?: unknown; state?: unknown }
  try {
    issue = JSON.parse(r.content.find(c => c.type === 'text')?.text ?? '')
  } catch {
    return undefined
  }
  if (!issue || typeof issue !== 'object') return undefined
  const raw = issue.status ?? issue.state
  const obj = raw && typeof raw === 'object' ? (raw as { name?: unknown; type?: unknown }) : undefined
  const name = typeof raw === 'string' ? raw : typeof obj?.name === 'string' ? obj.name : undefined
  const kind = issue.statusType ?? obj?.type
  const type = typeof kind === 'string' && ISSUE_TYPES.has(kind) ? (kind as IssueType) : undefined
  if (!name && !type) return undefined

  return { ...(name ? { name } : {}), ...(type ? { type } : {}) }
}

const ISSUE_GLYPH: Record<IssueType, string> = {
  triage: '📥',
  backlog: '💤',
  unstarted: '⚪',
  started: '🟡',
  completed: '🟣',
  canceled: '⚫',
  duplicate: '⚫',
}

export const issueGlyph = (s: IssueStatus | undefined) => (!s ? '' : s.type ? ISSUE_GLYPH[s.type] : s.name ? '•' : '?')

export const isIssueDone = (s: IssueStatus | undefined) =>
  s?.type === 'completed' || s?.type === 'canceled' || s?.type === 'duplicate'

// Linear issues the 5-minute watch re-checks: all but the finished ones.
export const issueWatchKeys = (keys: readonly string[], known: Readonly<Record<string, IssueStatus>>) =>
  keys.filter(k => isIssueKey(k) && !isIssueDone(known[k]))

const MAX_GROUPS = 20
const MAX_LABEL = 60
const MAX_GROUP_TEXT = 200
const MAX_STEP = 120

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

// A PR link, `owner/repo#N`, `#N` naming exactly one PR already in the band, or `repo#N`
// for a PR in the band or, when the band holds one owner's `repo`, another PR there.
export function resolvePr(ref: string, band: readonly Item[]): Link | undefined {
  const link = parseLink(ref)
  if (link) return isPrKey(link.key) ? link : undefined
  const full = ref.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/)
  if (full) return githubLink([full[1]!, full[2]!, 'pull', full[3]!])
  const short = ref.match(/^([\w.-]+)?#(\d+)$/)
  if (!short) return undefined
  const [, repo, n] = short
  const matches = band.filter(i => {
    const name = i.key.split('/')[1]
    return isPrKey(i.key) && (repo ? name === `${repo.toLowerCase()}#${n}` : name?.endsWith(`#${n}`))
  })
  if (matches.length === 1) return matches[0]
  if (!repo || matches.length > 0) return undefined
  const owners = new Set(
    band.flatMap(i => {
      const [, owner, name] = i.url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\//) ?? []
      return owner && name?.toLowerCase() === repo.toLowerCase() ? [`${owner}/${name}`] : []
    }),
  )
  const [only] = owners
  return owners.size === 1 ? githubLink([...only!.split('/'), 'pull', n!]) : undefined
}

export type ParsedGroups = { groups: PrGroup[]; links: Link[]; skipped: string[]; repeated: string[] }

// One group from tool input, its PRs resolved against the band and the PRs taken so far.
// A step is a row of its own, so it keeps no label, text or PRs.
function parseGroup(g: unknown, band: readonly Item[], found: Omit<ParsedGroups, 'groups'>): PrGroup | undefined {
  if (typeof g !== 'object' || g === null) return undefined
  const { label, text, prs, step, done } = g as { label?: unknown; text?: unknown; prs?: unknown; step?: unknown; done?: unknown }
  const s = clean(step, MAX_STEP)
  if (s) return { step: s, ...(done === true && { isDone: true }), prs: [] }
  const keys: string[] = []
  for (const ref of Array.isArray(prs) ? prs : []) {
    const raw = clean(ref, 300)
    const link = raw ? resolvePr(raw, [...band, ...found.links]) : undefined
    if (!link) {
      if (raw) found.skipped.push(raw)
      continue
    }
    if (found.links.some(l => l.key === link.key)) {
      found.repeated.push(raw)
      continue
    }
    keys.push(link.key)
    found.links.push(link)
  }
  const l = clean(label, MAX_LABEL)
  const t = clean(text, MAX_GROUP_TEXT)
  return l || t || keys.length > 0 ? { ...(l && { label: l }), ...(t && { text: t }), prs: keys } : undefined
}

// The group_prs input as groups of PR keys: unreadable refs are skipped and a PR
// named twice stays in its first group.
export function parseGroups(input: unknown, band: readonly Item[]): ParsedGroups {
  const found = { links: [] as Link[], skipped: [] as string[], repeated: [] as string[] }
  const groups = (Array.isArray(input) ? input.slice(0, MAX_GROUPS) : []).flatMap(g => parseGroup(g, band, found) ?? [])
  return { groups, ...found }
}

const isEmpty = (g: PrGroup) => !g.label && !g.text && !g.step && g.prs.length === 0

export type EditedGroups = { groups: PrGroup[]; links: Link[]; notes: string[] }

// Applies edit_groups' edits in order. Each edit sees the groups the ones before it left,
// and a group left empty goes once they are all done.
export function editGroups(start: readonly PrGroup[], edits: unknown, band: readonly Item[]): EditedGroups {
  let groups = start.map(g => ({ ...g, prs: [...g.prs] }))
  const links: Link[] = []
  const notes: string[] = []
  const known = () => [...band, ...links]
  const at = (n: unknown, max: number) => (typeof n === 'number' && Number.isInteger(n) ? Math.max(0, Math.min(n, max)) : max)
  const target = (e: GroupEdit, n: number) => {
    const g = typeof e.group === 'number' ? groups[e.group] : undefined
    if (!g) notes.push(`Edit ${n + 1}: no group ${String(e.group)} (groups run from 0 to ${groups.length - 1}).`)
    return g
  }
  const take = (key: string) => groups.forEach(g => (g.prs = g.prs.filter(k => k !== key)))

  ;(Array.isArray(edits) ? edits : []).forEach((raw, n) => {
    const e = (typeof raw === 'object' && raw !== null ? raw : {}) as GroupEdit
    if (e.op === 'put' || e.op === 'remove') {
      const ref = clean(e.pr, 300)
      const link = ref ? resolvePr(ref, known()) : undefined
      if (!link) return notes.push(`Edit ${n + 1}: "${ref}" is not a PR link, owner/repo#N, or a repo#N for a repo in the band.`)
      if (e.op === 'remove') return take(link.key)
      const g = target(e, n)
      if (!g) return
      if (g.step) return notes.push(`Edit ${n + 1}: group ${e.group} is a step, which holds no PRs.`)
      take(link.key)
      g.prs.splice(at(e.at, g.prs.length), 0, link.key)
      if (!links.some(l => l.key === link.key)) links.push(link)
      return
    }
    if (e.op === 'set') {
      const g = target(e, n)
      if (!g) return
      if (g.step) {
        if (e.label !== undefined || e.text !== undefined) notes.push(`Edit ${n + 1}: group ${e.group} is a step; set its step or done.`)
        const s = clean(e.step, MAX_STEP)
        if (s) g.step = s
        if (e.done === true) g.isDone = true
        if (e.done === false) delete g.isDone
        return
      }
      if (e.step !== undefined || e.done !== undefined) notes.push(`Edit ${n + 1}: group ${e.group} is not a step; set its label or text.`)
      for (const [field, max] of [['label', MAX_LABEL], ['text', MAX_GROUP_TEXT]] as const) {
        if (typeof e[field] !== 'string') continue
        const v = clean(e[field], max)
        if (v) g[field] = v
        else delete g[field]
      }
      return
    }
    if (e.op === 'insert') {
      if (groups.length >= MAX_GROUPS) return notes.push(`Edit ${n + 1}: there are already ${MAX_GROUPS} groups.`)
      const found = { links: [] as Link[], skipped: [] as string[], repeated: [] as string[] }
      const g = parseGroup(e, known(), found)
      if (found.skipped.length > 0) notes.push(`Edit ${n + 1}: skipped ${found.skipped.join(', ')} (not a PR link, owner/repo#N, or a repo#N for a repo in the band).`)
      if (!g) return notes.push(`Edit ${n + 1}: an insert needs a label, text, PRs or a step.`)
      g.prs.forEach(take)
      groups.splice(at(e.at, groups.length), 0, g)
      found.links.forEach(l => links.some(k => k.key === l.key) || links.push(l))
      return
    }
    if (e.op === 'delete') {
      if (target(e, n)) groups.splice(e.group!, 1)
      return
    }
    notes.push(`Edit ${n + 1}: unknown op "${String(e.op)}"; use put, remove, set, insert or delete.`)
  })
  groups = groups.filter(g => !isEmpty(g))
  return { groups, links, notes }
}

// Drops PRs from the groups, and any group left with nothing in it.
export const withoutPrs = (groups: readonly PrGroup[], keys: readonly string[]): PrGroup[] =>
  groups.map(g => ({ ...g, prs: g.prs.filter(k => !keys.includes(k)) })).filter(g => !isEmpty(g))

// Drops the groups whose PRs all went, and those PRs from the rest.
export const withoutDone = (groups: readonly PrGroup[], keys: readonly string[]): PrGroup[] =>
  withoutPrs(groups.filter(g => g.prs.length === 0 || g.prs.some(k => !keys.includes(k))), keys)

export type GithubRow =
  | { kind: 'label'; group?: number; text: string; isDone?: boolean }
  | { kind: 'text'; group: number; text: string; isDone?: boolean }
  | { kind: 'step'; group: number; text: string; isDone: boolean }
  | { kind: 'landed'; count: number; isOpen: boolean }
  | { kind: 'pr'; item: Item }

export type Landed = {
  // The merged and closed PRs in view, folded into one row under the rest.
  items: readonly Item[]
  // Every merged or closed PR in the band, in view or not.
  finished: ReadonlySet<string>
  listed: ReadonlySet<string>
  isOpen: boolean
}

// The GitHub section top to bottom: each group's label, text and PRs, then the PRs in
// no group (newest first) under `other`, then the landed row. A group whose PRs have
// all landed is done.
export function githubRows(groups: readonly PrGroup[], band: readonly Item[], rest: readonly Item[], landed?: Landed): GithubRow[] {
  const byKey = new Map(band.map(i => [i.key, i]))
  const rows: GithubRow[] = groups.flatMap((g, group): GithubRow[] => {
    if (g.step) return [{ kind: 'step', group, text: g.step, isDone: g.isDone === true }]
    const listed = landed ? g.prs.filter(k => landed.listed.has(k)) : []
    const isDone = listed.length > 0 && listed.every(k => landed!.finished.has(k))
    const prs = g.prs.filter(k => byKey.has(k) && !landed?.finished.has(k))
    return [
      ...(g.label ? [{ kind: 'label' as const, group, text: g.label, ...(isDone && { isDone }) }] : []),
      ...(g.text ? [{ kind: 'text' as const, group, text: g.text, ...(isDone && !g.label && { isDone }) }] : []),
      ...prs.map(k => ({ kind: 'pr' as const, item: byKey.get(k)! })),
    ]
  })
  if (groups.length > 0 && rest.length > 0) rows.push({ kind: 'label', text: 'other' })
  rows.push(...rest.map(item => ({ kind: 'pr' as const, item })))
  if (!landed || landed.items.length === 0) return rows
  rows.push({ kind: 'landed', count: landed.items.length, isOpen: landed.isOpen })
  return landed.isOpen ? [...rows, ...landed.items.map(item => ({ kind: 'pr' as const, item }))] : rows
}
