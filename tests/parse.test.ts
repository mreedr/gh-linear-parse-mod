import { describe, expect, test } from 'claude-code/testing'

import {
  githubRows,
  parseGroups,
  resolvePr,
  withoutDone,
  withoutPrs,
  isIssueKey,
  issueGlyph,
  issueId,
  issueWatchKeys,
  parseIssueResult,
  addKey,
  authorInitials,
  cell,
  ciSummary,
  extractLinks,
  fitText,
  isStale,
  linkLabel,
  linksFromHistory,
  mergeLinks,
  diffParts,
  nextStatus,
  parseColorArgs,
  parseLink,
  parsePrJson,
  prRef,
  shortTitle,
  shouldPoll,
  statusGlyphs,
  watchKeys,
} from '../hooks/parse'

describe('parseLink github', () => {
  test('pull request collapses to its bare URL', () => {
    expect(parseLink('https://github.com/acme/store/pull/791/files?diff=split#r1')).toEqual({
      key: 'github:acme/store#791',
      url: 'https://github.com/acme/store/pull/791',
    })
  })
  test('everything else on GitHub is ignored', () => {
    expect(parseLink('https://github.com/a/b/issues/12')).toBe(undefined)
    expect(parseLink('https://github.com/a/b/commit/c0fb3027deadbeef')).toBe(undefined)
    expect(parseLink('https://github.com/a/b/actions/runs/998877/job/1')).toBe(undefined)
    expect(parseLink('https://github.com/a/b/tree/main')).toBe(undefined)
    expect(parseLink('https://github.com/a/b/blob/main/x.ex#L10')).toBe(undefined)
    expect(parseLink('https://github.com/a/b/pulls')).toBe(undefined)
    expect(parseLink('https://github.com/a/b')).toBe(undefined)
    expect(parseLink('https://github.com/acme')).toBe(undefined)
  })
})

describe('parseLink linear', () => {
  test('issue keeps the full URL as written', () => {
    expect(parseLink('https://linear.app/acme/issue/eng-4242/signup-email?x=1#c')).toEqual({
      key: 'linear:acme/issue/eng-4242',
      url: 'https://linear.app/acme/issue/eng-4242/signup-email',
    })
  })
  test('other pages keep their full URL', () => {
    expect(parseLink('https://linear.app/acme/project/new-onboarding-0a1b2c3d4e5f/overview')?.url).toBe(
      'https://linear.app/acme/project/new-onboarding-0a1b2c3d4e5f/overview',
    )
  })
  test('workspace root is ignored', () => {
    expect(parseLink('https://linear.app/acme')).toBe(undefined)
  })
})

describe('extractLinks', () => {
  test('finds PRs and Linear pages in prose, markdown and escaped JSON, and dedupes', () => {
    const text = [
      'see https://github.com/a/b/pull/1, and (https://github.com/a/b/pull/1/files).',
      '[ENG-9](https://linear.app/acme/issue/ENG-9/x) and https://linear.app/acme/issue/ENG-9',
      '{"command":"gh pr view https://github.com/a/b/pull/2\\n"}',
      'https://github.com/a/b/actions/runs/5 https://github.com/a/b',
    ].join('\n')
    expect(extractLinks(text).map(l => l.url)).toEqual([
      'https://github.com/a/b/pull/1',
      'https://linear.app/acme/issue/ENG-9/x',
      'https://github.com/a/b/pull/2',
    ])
  })
  test('ignores other hosts', () => {
    expect(extractLinks('https://gitlab.com/a/b/pull/1 https://raw.githubusercontent.com/a/b/main/x https://example.com')).toEqual([])
  })
  test('strips trailing punctuation', () => {
    expect(extractLinks('Done: https://github.com/a/b/pull/3.')[0]?.url).toBe('https://github.com/a/b/pull/3')
  })
})

test('mergeLinks puts new links first, moves repeats up, and caps', () => {
  const l = (n: number) => ({ key: `k${n}`, url: `u${n}` })
  expect(mergeLinks([l(1), l(2), l(3)], [l(4), l(2)], 4).map(x => x.key)).toEqual(['k4', 'k2', 'k1', 'k3'])
  expect(mergeLinks([l(1), l(2), l(3)], [l(4)], 3).map(x => x.key)).toEqual(['k4', 'k1', 'k2'])
})

describe('parseColorArgs', () => {
  test('no color or reset goes back to the default, none drops the border', () => {
    expect(parseColorArgs([])).toEqual({ kind: 'clear' })
    expect(parseColorArgs(['reset'])).toEqual({ kind: 'clear' })
    expect(parseColorArgs(['none'])).toEqual({ kind: 'none' })
  })
  test('names, bright names, hex and theme keys set a border', () => {
    expect(parseColorArgs(['Red'])).toEqual({ kind: 'set', value: { color: 'red', isFill: false } })
    expect(parseColorArgs(['cyanbright'])).toEqual({ kind: 'set', value: { color: 'cyanBright', isFill: false } })
    expect(parseColorArgs(['#3B2A4A'])).toEqual({ kind: 'set', value: { color: '#3b2a4a', isFill: false } })
    expect(parseColorArgs(['promptborder'])).toEqual({ kind: 'set', value: { color: 'promptBorder', isFill: false } })
  })
  test('fill sets the background', () => {
    expect(parseColorArgs(['#123', 'fill'])).toEqual({ kind: 'set', value: { color: '#123', isFill: true } })
  })
  test('unknown colors and extra words are refused', () => {
    expect(parseColorArgs(['chartreuse'])).toEqual({ kind: 'invalid', color: 'chartreuse' })
    expect(parseColorArgs(['#12345'])).toEqual({ kind: 'invalid', color: '#12345' })
    expect(parseColorArgs(['red', 'border'])).toEqual({ kind: 'invalid', color: 'red border' })
  })
})

test('addKey appends once and drops the oldest past max', () => {
  expect(addKey(['a', 'b'], 'a', 5)).toEqual(['b', 'a'])
  expect(addKey(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd'])
})

describe('linksFromHistory', () => {
  const pr = (n: number) => `https://github.com/a/b/pull/${n}`

  test('newest message first, repeats move up', () => {
    expect(linksFromHistory([`see ${pr(1)}`, `and ${pr(2)}`, `back to ${pr(1)}`], 10).map(l => l.url)).toEqual([
      pr(1),
      pr(2),
    ])
  })
  test('skips system reminders and dismissed links, and caps', () => {
    const texts = [
      `<system-reminder>memory: ${pr(9)}</system-reminder> real ${pr(3)}`,
      `${pr(4)} ${pr(5)}`,
      pr(6),
    ]
    expect(linksFromHistory(texts, 3, ['github:a/b#5']).map(l => l.url)).toEqual([pr(6), pr(4), pr(3)])
    expect(linksFromHistory(texts, 2).map(l => l.url)).toEqual([pr(6), pr(4)])
  })
})

test('mergeLinks keeps dismissed links out', () => {
  const l = (n: number) => ({ key: `k${n}`, url: `u${n}` })
  expect(mergeLinks([l(1)], [l(2), l(3)], 10, ['k2']).map(x => x.key)).toEqual(['k3', 'k1'])
})

test('prRef reads a bare PR URL', () => {
  expect(prRef('https://github.com/acme/store/pull/791')).toEqual({ repo: 'acme/store', number: 791 })
  expect(prRef('https://linear.app/acme/issue/ENG-1')).toBe(undefined)
})

test('ciSummary', () => {
  expect(ciSummary([])).toBe('none')
  expect(ciSummary(null)).toBe('none')
  expect(ciSummary([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('pass')
  expect(ciSummary([{ __typename: 'CheckRun', status: 'QUEUED', conclusion: null, state: null }])).toBe('running')
  expect(ciSummary([{ __typename: 'StatusContext', state: 'PENDING' }])).toBe('running')
  expect(
    ciSummary([
      { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
    ]),
  ).toBe('fail')
})

test('ciSummary counts only the newest run of each check', () => {
  const run = (name: string, startedAt: string, status: string, conclusion = '') =>
    ({ __typename: 'CheckRun', workflowName: 'OpenAPI Client', name, startedAt, status, conclusion })
  // A run cancelled by a newer one no longer turns the PR red.
  const superseded = [
    run('Generate client', '2026-10-15T17:36:19Z', 'COMPLETED', 'CANCELLED'),
    run('Generate client', '2026-10-15T17:36:23Z', 'COMPLETED', 'SUCCESS'),
  ]
  expect(ciSummary(superseded)).toBe('pass')
  expect(ciSummary([...superseded, { ...run('Run Tests', '2026-10-15T17:36:22Z', 'IN_PROGRESS'), workflowName: 'Pull Request' }])).toBe('running')
  // A rerun that is still going replaces the failure it reruns.
  expect(ciSummary([run('Run Tests', '2026-10-15T17:00:00Z', 'COMPLETED', 'FAILURE'), run('Run Tests', '2026-10-15T17:30:00Z', 'IN_PROGRESS')])).toBe('running')
  // The same check name in two workflows is two checks.
  expect(ciSummary([run('Run Tests', '2026-10-15T17:30:00Z', 'COMPLETED', 'FAILURE'), { ...run('Run Tests', '2026-10-15T17:31:00Z', 'COMPLETED', 'SUCCESS'), workflowName: 'Other' }])).toBe('fail')
})

describe('parsePrJson', () => {
  test('state, draft and review', () => {
    const requested = { reviewRequests: [{ login: 'someone' }], latestReviews: [] }
    expect(parsePrJson(JSON.stringify({ state: 'OPEN', isDraft: true, reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [], ...requested }))).toEqual({
      state: 'draft',
      ci: 'none',
      review: 'pending',
    })
    expect(parsePrJson(JSON.stringify({ state: 'MERGED', isDraft: false, reviewDecision: 'APPROVED' }))).toEqual({
      state: 'merged',
      ci: 'none',
      review: 'approved',
    })
    expect(parsePrJson(JSON.stringify({ state: 'OPEN', isDraft: false, reviewDecision: 'CHANGES_REQUESTED' }))?.review).toBe('changes')
  })
  test('an open or draft PR with no reviewer requested or reviewing is unassigned', () => {
    const none = { reviewRequests: [], latestReviews: [] }
    expect(parsePrJson(JSON.stringify({ state: 'OPEN', isDraft: false, reviewDecision: '', ...none }))?.review).toBe('unassigned')
    expect(parsePrJson(JSON.stringify({ state: 'OPEN', isDraft: true, reviewDecision: 'REVIEW_REQUIRED', ...none }))?.review).toBe(
      'unassigned',
    )
    // a stacked PR's base requires no review, so GitHub gives no decision; the request still counts
    expect(
      parsePrJson(JSON.stringify({ state: 'OPEN', isDraft: false, reviewDecision: '', reviewRequests: [{ login: 'a' }], latestReviews: [] })),
    ).toEqual({ state: 'open', ci: 'none', review: 'pending' })
    // the author's own comment, and a bot's, are not a review
    const own = [{ author: { login: 'me' }, state: 'COMMENTED' }, { author: { login: 'claude' }, state: 'COMMENTED' }]
    expect(
      parsePrJson(JSON.stringify({ state: 'OPEN', isDraft: false, author: { login: 'me' }, reviewRequests: [], latestReviews: own }))?.review,
    ).toBe('unassigned')
    expect(parsePrJson(JSON.stringify({ state: 'MERGED', isDraft: false, reviewDecision: '', ...none }))?.review).toBe(undefined)
  })
  test('no review decision leaves review out', () => {
    expect(parsePrJson(JSON.stringify({ state: 'CLOSED', isDraft: false, reviewDecision: '' }))).toEqual({ state: 'closed', ci: 'none' })
  })
  test('lines added and deleted come through when both are numbers', () => {
    expect(parsePrJson(JSON.stringify({ state: 'CLOSED', isDraft: false, additions: 12, deletions: 0 }))).toEqual({
      state: 'closed',
      ci: 'none',
      additions: 12,
      deletions: 0,
    })
    expect(parsePrJson(JSON.stringify({ state: 'CLOSED', isDraft: false, additions: 12 }))?.additions).toBe(undefined)
  })
  test('garbage is undefined', () => {
    expect(parsePrJson('not json')).toBe(undefined)
    expect(parsePrJson('{}')).toBe(undefined)
  })
})

describe('nextStatus', () => {
  test('a failed check keeps what was known, or marks it unknown', () => {
    const prev = { state: 'open' as const, ci: 'pass' as const, checkedAt: 1 }
    expect(nextStatus(prev, undefined, 5)).toEqual({ ...prev, checkedAt: 5 })
    expect(nextStatus(undefined, undefined, 5)).toEqual({ state: 'unknown', ci: 'none', checkedAt: 5 })
  })
  test('ciSince starts when CI starts running and holds while it runs', () => {
    const first = nextStatus(undefined, { state: 'open', ci: 'running' }, 10)
    expect(first.ciSince).toBe(10)
    expect(nextStatus(first, { state: 'open', ci: 'running' }, 20).ciSince).toBe(10)
    expect(nextStatus(first, { state: 'open', ci: 'pass' }, 30)).toEqual({ state: 'open', ci: 'pass', checkedAt: 30 })
  })
})

test('isStale and shouldPoll', () => {
  expect(isStale(undefined, 100, 15)).toBe(true)
  expect(isStale({ state: 'open', ci: 'pass', checkedAt: 90 }, 100, 15)).toBe(false)
  expect(isStale({ state: 'open', ci: 'pass', checkedAt: 80 }, 100, 15)).toBe(true)
  const running = { state: 'open' as const, ci: 'running' as const, checkedAt: 100, ciSince: 0 }
  expect(shouldPoll(running, 100, 1000)).toBe(true)
  expect(shouldPoll(running, 2000, 1000)).toBe(false)
  expect(shouldPoll({ state: 'open', ci: 'pass', checkedAt: 100 }, 100, 1000)).toBe(false)
})

test('statusGlyphs', () => {
  expect(statusGlyphs(undefined)).toEqual({ pr: '…', ci: '', rv: '', isPending: true })
  expect(statusGlyphs({ state: 'unknown', ci: 'none', checkedAt: 0 })).toEqual({ pr: '?', ci: '', rv: '', isPending: true })
  expect(statusGlyphs({ state: 'draft', ci: 'fail', review: 'changes', checkedAt: 0 })).toEqual({
    pr: '📝',
    ci: '❌',
    rv: '✋',
    isPending: false,
  })
  expect(statusGlyphs({ state: 'closed', ci: 'none', checkedAt: 0 })).toEqual({ pr: '⚫', ci: '', rv: '', isPending: false })
  expect(statusGlyphs({ state: 'merged', ci: 'pass', review: 'approved', checkedAt: 0 }).rv).toBe('🌒')
  expect(statusGlyphs({ state: 'merged', ci: 'pass', review: 'pending', checkedAt: 0 }).rv).toBe('🌒')
  expect(statusGlyphs({ state: 'open', ci: 'pass', review: 'unassigned', checkedAt: 0 }).rv).toBe('🦯')
})

test('watchKeys picks open, draft and unread PRs not on the CI poll', () => {
  const at = (state: 'open' | 'draft' | 'merged' | 'closed' | 'unknown', ci: 'pass' | 'running' = 'pass', ciSince?: number) => ({
    state,
    ci,
    checkedAt: 0,
    ...(ciSince !== undefined ? { ciSince } : {}),
  })
  const known = {
    'github:a/b#1': at('open'),
    'github:a/b#2': at('draft'),
    'github:a/b#3': at('merged'),
    'github:a/b#4': at('closed'),
    'github:a/b#5': at('unknown'),
    'github:a/b#6': at('open', 'running', 0),
    'github:a/b#7': at('open', 'running', -10_000),
  }
  const keys = [...Object.keys(known), 'github:a/b#8', 'linear:acme/issue/eng-1']
  expect(watchKeys(keys, known, 100, 1000)).toEqual([
    'github:a/b#1',
    'github:a/b#2',
    'github:a/b#5',
    'github:a/b#7',
    'github:a/b#8',
  ])
})


describe('linkLabel', () => {
  test('a PR is its repo and number', () => {
    expect(linkLabel('https://github.com/acme/store/pull/802')).toEqual({ project: 'store', ref: '#802' })
  })
  test('a Linear issue is its id and slug words', () => {
    expect(linkLabel('https://linear.app/acme/issue/eng-4321/billing-page')).toEqual({ project: 'ENG-4321', ref: 'billing page' })
    expect(linkLabel('https://linear.app/acme/issue/ENG-1')).toEqual({ project: 'ENG-1', ref: '' })
  })
  test('another Linear page is its kind and name, the trailing id dropped', () => {
    expect(linkLabel('https://linear.app/acme/project/new-onboarding-0a1b2c3d4e5f')).toEqual({ project: 'project', ref: 'new onboarding' })
    expect(linkLabel('https://linear.app/acme/inbox')).toEqual({ project: 'inbox', ref: '' })
    // Two tabs of one project read apart.
    expect(linkLabel('https://linear.app/acme/project/new-onboarding-0a1b2c3d4e5f/overview')).toEqual({
      project: 'project',
      ref: 'new onboarding · overview',
    })
    expect(linkLabel('https://linear.app/acme/project/new-onboarding-0a1b2c3d4e5f/activity')?.ref).toBe('new onboarding · activity')
  })
})

describe('shortTitle', () => {
  const cases: [string, { tag?: string; text: string }][] = [
    ['feat(search): rank results by recency when the query is empty (T2)', { tag: 'search', text: 'rank results by recency' }],
    ['feat(cart): create the checkout session once its customer exists (T3b)', { tag: 'cart', text: 'create the checkout session' }],
    ['feat(cart): line items follow price_list_id (Pricing T3a)', { tag: 'cart', text: 'line items follow price_list_id' }],
    ["feat(api): find a user's profile, or create it once", { tag: 'api', text: "find a user's profile" }],
    ["fix(auth) Never reuse a member's session token for a different account (ENG-1234)", { tag: 'auth', text: "Never reuse a member's session token for a different account" }],
    ["perf(search): store a query's results so GET /search skips the index", { tag: 'search', text: "store a query's results" }],
    ['feat(rate_limits): cap each client by its plan, and seeds to raise and lower one (ENG-1235)', { tag: 'rate_limits', text: 'cap each client by its plan' }],
    ['feat(config): storage modes: production, sandbox or mock per backend (S3, GCS, Azure)', { tag: 'config', text: 'storage modes: production, sandbox or mock per backend (S3, GCS, Azure)' }],
    ['fix: remove legacyFlag', { text: 'remove legacyFlag' }],
    ['[Sprint 13/13] client: account status (DES-344)', { tag: 'client', text: 'account status' }],
    ['client: account status banners on the dashboard (port of #42)', { tag: 'client', text: 'account status banners on the dashboard' }],
    ['ENG-1236: Show the confirm step before payment for large orders', { text: 'Show the confirm step before payment for large orders' }],
    ['Give each instance a unique worker node so only one runs cron', { text: 'Give each instance a unique worker node' }],
    ['Mock mode table: tests reach the payment test service', { text: 'Mock mode table: tests reach the payment test service' }],
    ['Hide admin-only UI for guest accounts (ENG-1237, ENG-1238, ENG-1239)', { text: 'Hide admin-only UI for guest accounts' }],
    ['fix(x): stop so', { tag: 'x', text: 'stop so' }],
  ]
  for (const [title, expected] of cases) test(title, () => expect(shortTitle(title)).toEqual(expected))
})

test('cell pads a glyph to two cells', () => {
  expect(cell('🟢')).toBe('🟢')
  expect(cell('…')).toBe('… ')
  expect(cell('')).toBe('  ')
})

test('fitText cuts to the room with an ellipsis', () => {
  expect(fitText('remove legacyFlag', 20)).toBe('remove legacyFlag')
  expect(fitText('create the checkout session', 12)).toBe('create the…')
  expect(fitText('abc', 0)).toBe('')
})

describe('commented review', () => {
  const pr = (latestReviews: unknown[], extra: Record<string, unknown> = {}) =>
    parsePrJson(JSON.stringify({ state: 'OPEN', isDraft: false, author: { login: 'me' }, reviewDecision: 'REVIEW_REQUIRED', reviewRequests: [], latestReviews, ...extra }))?.review

  test("a person's comment review with no approval is commented", () => {
    expect(pr([{ author: { login: 'kay' }, state: 'COMMENTED' }])).toBe('commented')
  })
  test('an approval from anyone, or the decision, outranks it', () => {
    expect(pr([{ author: { login: 'kay' }, state: 'COMMENTED' }, { author: { login: 'jd' }, state: 'APPROVED' }])).toBe('pending')
    expect(pr([{ author: { login: 'kay' }, state: 'COMMENTED' }], { reviewDecision: 'APPROVED' })).toBe('approved')
    expect(pr([{ author: { login: 'kay' }, state: 'COMMENTED' }], { reviewDecision: 'CHANGES_REQUESTED' })).toBe('changes')
  })
  test('bots and the author do not count', () => {
    expect(pr([{ author: { login: 'claude' }, state: 'COMMENTED' }], { reviewRequests: [{ login: 'kay' }] })).toBe('pending')
    expect(pr([{ author: { login: 'dependabot[bot]' }, state: 'COMMENTED' }])).toBe('unassigned')
    expect(pr([{ author: { login: 'me' }, state: 'COMMENTED' }])).toBe('unassigned')
  })
  test('a merged PR is never commented', () => {
    expect(pr([{ author: { login: 'kay' }, state: 'COMMENTED' }], { state: 'MERGED' })).toBe('pending')
  })
  test('it shows as 💬', () => {
    expect(statusGlyphs({ state: 'open', ci: 'pass', review: 'commented', checkedAt: 0 }).rv).toBe('💬')
  })
})

test('authorInitials is two lowercase letters of the login', () => {
  expect(authorInitials('Octocat')).toBe('oc')
  expect(authorInitials('mreedr')).toBe('mr')
  expect(authorInitials('x')).toBe('x ')
  expect(parsePrJson(JSON.stringify({ state: 'OPEN', author: { login: 'mreedr' } }))?.author).toBe('mreedr')
})

describe('diffParts', () => {
  test('pads the additions so the deletions line up', () => {
    const s = { state: 'open' as const, ci: 'none' as const, checkedAt: 0, additions: 7, deletions: 120 }
    expect(diffParts(s, 3)).toEqual({ plus: '  +7', minus: '-120' })
    expect(diffParts({ ...s, additions: undefined }, 3)).toBe(undefined)
  })
})

describe('Linear issue status', () => {
  const text = (v: unknown, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(v) }], isError })

  test('issue keys and ids', () => {
    expect(isIssueKey('linear:acme/issue/eng-12')).toBe(true)
    expect(isIssueKey('https://linear.app/acme/project/x')).toBe(false)
    expect(issueId('linear:acme/issue/eng-12')).toBe('ENG-12')
  })

  test('parses a status name and type, or a status object', () => {
    expect(parseIssueResult(text({ id: 'ENG-1', status: 'Shipped', statusType: 'completed' }))).toEqual({ name: 'Shipped', type: 'completed' })
    expect(parseIssueResult(text({ id: 'ENG-1', state: { name: 'Todo', type: 'unstarted' } }))).toEqual({ name: 'Todo', type: 'unstarted' })
    expect(parseIssueResult(text({ id: 'ENG-1', status: 'Odd', statusType: 'weird' }))).toEqual({ name: 'Odd' })
  })

  test('an error or unreadable result is no status', () => {
    expect(parseIssueResult(text({ status: 'Todo' }, true))).toBe(undefined)
    expect(parseIssueResult({ content: [{ type: 'text', text: 'Issue not found' }], isError: false })).toBe(undefined)
    expect(parseIssueResult(text({ id: 'ENG-1' }))).toBe(undefined)
  })

  test('glyphs, and finished issues leave the watch', () => {
    expect(issueGlyph(undefined)).toBe('')
    expect(issueGlyph({ checkedAt: 1 })).toBe('?')
    expect(issueGlyph({ name: 'Odd', checkedAt: 1 })).toBe('•')
    expect(issueGlyph({ name: 'In review', type: 'started', checkedAt: 1 })).toBe('🟡')
    const keys = ['linear:a/issue/eng-1', 'linear:a/issue/eng-2', 'github:a/b#1']
    expect(issueWatchKeys(keys, { 'linear:a/issue/eng-2': { type: 'canceled', checkedAt: 1 } })).toEqual(['linear:a/issue/eng-1'])
  })
})

test('slug words keep the dashes inside dates', () => {
  expect(linkLabel('https://linear.app/acme/document/plan-2026-10-13-business-mic-0a1b2c3d4e5f')).toEqual({
    project: 'document',
    ref: 'plan 2026-10-13 business mic',
  })
})

test('a draft with no reviewer shows no review glyph; an open one shows 🦯', () => {
  expect(statusGlyphs({ state: 'draft', ci: 'pass', review: 'unassigned', checkedAt: 0 }).rv).toBe('')
  expect(statusGlyphs({ state: 'open', ci: 'pass', review: 'unassigned', checkedAt: 0 }).rv).toBe('🦯')
})

test('a merge conflict on an open PR takes the CI cell as 💥', () => {
  const at = (state: string, mergeable: string, isDraft = false) =>
    parsePrJson(JSON.stringify({ state, isDraft, reviewDecision: null, statusCheckRollup: [], mergeable }))
  expect(at('OPEN', 'CONFLICTING')?.hasConflict).toBe(true)
  expect(at('OPEN', 'CONFLICTING', true)?.hasConflict).toBe(true)
  // GitHub has not worked it out yet, or the PR is done.
  expect(at('OPEN', 'UNKNOWN')?.hasConflict).toBeUndefined()
  expect(at('OPEN', 'MERGEABLE')?.hasConflict).toBeUndefined()
  expect(at('MERGED', 'CONFLICTING')?.hasConflict).toBeUndefined()
  expect(statusGlyphs({ state: 'open', ci: 'pass', hasConflict: true, checkedAt: 0 }).ci).toBe('💥')
  expect(statusGlyphs({ state: 'open', ci: 'pass', checkedAt: 0 }).ci).toBe('✅')
})

describe('PR groups', () => {
  const band = [
    { key: 'github:acme/api#42', url: 'https://github.com/acme/api/pull/42' },
    { key: 'github:acme/web#42', url: 'https://github.com/acme/web/pull/42' },
    { key: 'github:acme/web#43', url: 'https://github.com/acme/web/pull/43' },
  ]

  test('a PR is a link, owner/repo#N, or a repo#N or #N naming one PR in the band', () => {
    expect(resolvePr('https://github.com/acme/api/pull/42/files', band)?.key).toBe('github:acme/api#42')
    expect(resolvePr('other/lib#7', band)).toEqual({ key: 'github:other/lib#7', url: 'https://github.com/other/lib/pull/7' })
    expect(resolvePr('web#43', band)?.key).toBe('github:acme/web#43')
    expect(resolvePr('#43', band)?.key).toBe('github:acme/web#43')
    expect(resolvePr('#42', band)).toBeUndefined()
    expect(resolvePr('cli#42', band)).toBeUndefined()
    expect(resolvePr('https://github.com/acme/api', band)).toBeUndefined()
    expect(resolvePr('https://linear.app/acme/issue/ENG-1/x', band)).toBeUndefined()
  })

  test('groups keep labels, text and PRs; unreadable and repeated PRs are reported', () => {
    const parsed = parseGroups(
      [
        { label: ' round   1 ', prs: ['api#42', 'web#43', 'nope'] },
        { label: 'round 2', text: 'run the checks after round 1' },
        { text: 'just a note' },
        { prs: ['https://github.com/acme/web/pull/43', 'other/lib#7'] },
        {},
        'junk',
      ],
      band,
    )
    expect(parsed.groups).toEqual([
      { label: 'round 1', prs: ['github:acme/api#42', 'github:acme/web#43'] },
      { label: 'round 2', text: 'run the checks after round 1', prs: [] },
      { text: 'just a note', prs: [] },
      { prs: ['github:other/lib#7'] },
    ])
    expect(parsed.links.map(l => l.key)).toEqual(['github:acme/api#42', 'github:acme/web#43', 'github:other/lib#7'])
    expect(parsed.skipped).toEqual(['nope'])
    expect(parsed.repeated).toEqual(['https://github.com/acme/web/pull/43'])
    expect(parseGroups(undefined, band).groups).toEqual([])
  })

  test('rows run through the groups, then the rest under other', () => {
    const [a, b, c] = band
    const groups = [{ label: 'round 1', prs: [c!.key, 'github:gone/x#1'] }, { label: 'round 2', text: 'checks', prs: [] }]
    expect(githubRows(groups, band, [a!])).toEqual([
      { kind: 'label', group: 0, text: 'round 1' },
      { kind: 'pr', item: c },
      { kind: 'label', group: 1, text: 'round 2' },
      { kind: 'text', group: 1, text: 'checks' },
      { kind: 'label', text: 'other' },
      { kind: 'pr', item: a },
    ])
    expect(githubRows([], band, [a!, b!])).toEqual([{ kind: 'pr', item: a }, { kind: 'pr', item: b }])
    expect(withoutPrs([{ prs: [c!.key] }, { label: 'x', prs: [c!.key] }], [c!.key])).toEqual([{ label: 'x', prs: [] }])
  })

  test('landed PRs leave their groups for the landed row, and a group whose PRs all landed is done', () => {
    const [a, b, c] = band
    const groups = [{ label: 'round 1', prs: [a!.key, b!.key] }, { text: 'step', prs: [c!.key] }, { label: 'note', prs: [] }]
    const landed = (isOpen: boolean) => ({
      items: [b!, c!],
      finished: new Set([b!.key, c!.key]),
      listed: new Set(band.map(i => i.key)),
      isOpen,
    })
    expect(githubRows(groups, band, [], landed(false))).toEqual([
      { kind: 'label', group: 0, text: 'round 1' },
      { kind: 'pr', item: a },
      { kind: 'text', group: 1, text: 'step', isDone: true },
      { kind: 'label', group: 2, text: 'note' },
      { kind: 'landed', count: 2, isOpen: false },
    ])
    expect(githubRows(groups, band, [], landed(true)).slice(-2)).toEqual([{ kind: 'pr', item: b }, { kind: 'pr', item: c }])
    // a sweep drops the groups it finished, and keeps notes
    expect(withoutDone(groups, [b!.key, c!.key])).toEqual([{ label: 'round 1', prs: [a!.key] }, { label: 'note', prs: [] }])
  })
})
