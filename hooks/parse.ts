import type { BandColor, CI, IssueStatus, IssueType, Item, PrGroup, PrState, PrStatus, Review } from '../types'

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
  const review: Review | undefined =
    pr.reviewDecision === 'APPROVED' ? 'approved'
      : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes'
        : isCommented ? 'commented'
          : isUnassigned ? 'unassigned'
            : pr.reviewDecision === 'REVIEW_REQUIRED' ? 'pending'
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
const RV_GLYPH: Record<Review, string> = { approved: '👍', pending: '👀', changes: '✋', unassigned: '🦯', commented: '💬' }

export type Glyphs = { pr: string; ci: string; rv: string; isPending: boolean }

export function statusGlyphs(s: PrStatus | undefined): Glyphs {
  if (!s) return { pr: '…', ci: '', rv: '', isPending: true }
  if (s.state === 'unknown') return { pr: '?', ci: '', rv: '', isPending: true }

  // A draft is not asking for review yet, so no reviewer is not news.
  const rv = !s.review || (s.state === 'draft' && s.review === 'unassigned') ? '' : RV_GLYPH[s.review]

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

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

// A PR link, `owner/repo#N`, or `repo#N` / `#N` naming exactly one PR already in the band.
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
  return matches.length === 1 ? matches[0] : undefined
}

export type ParsedGroups = { groups: PrGroup[]; links: Link[]; skipped: string[]; repeated: string[] }

// The group_prs input as groups of PR keys: unreadable refs are skipped and a PR
// named twice stays in its first group.
export function parseGroups(input: unknown, band: readonly Item[]): ParsedGroups {
  const links: Link[] = []
  const skipped: string[] = []
  const repeated: string[] = []
  const groups: PrGroup[] = []
  for (const g of Array.isArray(input) ? input.slice(0, MAX_GROUPS) : []) {
    if (typeof g !== 'object' || g === null) continue
    const { label, text, prs } = g as { label?: unknown; text?: unknown; prs?: unknown }
    const keys: string[] = []
    for (const ref of Array.isArray(prs) ? prs : []) {
      const raw = clean(ref, 300)
      const link = raw ? resolvePr(raw, [...band, ...links]) : undefined
      if (!link) {
        if (raw) skipped.push(raw)
        continue
      }
      if (links.some(l => l.key === link.key)) {
        repeated.push(raw)
        continue
      }
      keys.push(link.key)
      links.push(link)
    }
    const l = clean(label, MAX_LABEL)
    const t = clean(text, MAX_GROUP_TEXT)
    if (l || t || keys.length > 0) groups.push({ ...(l && { label: l }), ...(t && { text: t }), prs: keys })
  }
  return { groups, links, skipped, repeated }
}

// Drops PRs from the groups, and any group left with nothing in it.
export const withoutPrs = (groups: readonly PrGroup[], keys: readonly string[]): PrGroup[] =>
  groups.map(g => ({ ...g, prs: g.prs.filter(k => !keys.includes(k)) })).filter(g => g.label || g.text || g.prs.length > 0)

export type GithubRow =
  | { kind: 'label'; group?: number; text: string }
  | { kind: 'text'; group: number; text: string }
  | { kind: 'pr'; item: Item }

// The GitHub section top to bottom: each group's label, text and PRs, then the PRs in
// no group (newest first) under `other`.
export function githubRows(groups: readonly PrGroup[], band: readonly Item[], rest: readonly Item[]): GithubRow[] {
  const byKey = new Map(band.map(i => [i.key, i]))
  const rows: GithubRow[] = groups.flatMap((g, group): GithubRow[] => [
    ...(g.label ? [{ kind: 'label' as const, group, text: g.label }] : []),
    ...(g.text ? [{ kind: 'text' as const, group, text: g.text }] : []),
    ...g.prs.flatMap(k => (byKey.has(k) ? [{ kind: 'pr' as const, item: byKey.get(k)! }] : [])),
  ])
  if (groups.length > 0 && rest.length > 0) rows.push({ kind: 'label', text: 'other' })
  return [...rows, ...rest.map(item => ({ kind: 'pr' as const, item }))]
}
