import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { clockTime } from '../hooks/parse'

const PROPS = { hasSurvey: false, isWorking: false, maxRows: 20 } as never

// The world beneath the mod: a clock the test moves, and prompts that just enter.
function world(on: On) {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  mock.store(on)
  return mock.clock(on)
}

const submit = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
// Each row's Button that opens its link, in drawing order.
const rows = async (ui: { findAll: (q: { type: string }) => Promise<{ key?: string; text: string }[]> }) =>
  (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('open:'))

const ran = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const pr = (state: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ state, isDraft: false, reviewDecision: null, statusCheckRollup: [], ...extra })

test('PR rows get status emoji under PR/CI/Rv labels; Linear rows stay blank', async ($, on) => {
  const clock = world(on)
  const calls: string[][] = []
  on('process.run', async (_$, e) => {
    calls.push([...e.argv])
    const number = e.argv[3]
    const stdout =
      number === '1'
        ? pr('OPEN', {
            reviewDecision: 'APPROVED',
            statusCheckRollup: [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }],
          })
        : pr('MERGED', { statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }] })
    return ran(stdout)
  })

  await $.prompt.submit(
    submit('see https://github.com/a/b/pull/1, https://github.com/a/b/pull/2 and https://linear.app/acme/issue/ENG-1/x'),
  )
  await clock.advance(10)

  expect(calls.map(c => c.slice(0, 6))).toEqual([
    ['gh', 'pr', 'view', '1', '-R', 'a/b'],
    ['gh', 'pr', 'view', '2', '-R', 'a/b'],
  ])

  const ui = await $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect((await ui.find({ key: 'label-pr' }))?.text).toBe('PR')
  expect((await ui.find({ key: 'label-ci' }))?.text).toBe('CI')
  expect((await ui.find({ key: 'label-rv' }))?.text).toBe('Rv')

  // The status cells are two wide, so each row lines up under PR, CI and Rv.
  const texts = (await rows(ui)).map(b => b.text)
  // The Linear group is its own table, without the PR columns.
  expect(texts).toEqual(['🟢 ⏳ 🚀 b | #1', '🟣 ✅    b | #2', 'ENG-1 | x'])
  const merged = (await rows(ui)).find(b => b.text === '🟣 ✅    b | #2')
  expect(JSON.stringify(merged)).toContain('"dimColor":true')
})

test('PRs sit above a Linear divider whatever the mention order, projects padded to line up', async ($, on) => {
  const clock = world(on)
  on('process.run', async () => ran(pr('OPEN')))
  await $.prompt.submit(submit('https://github.com/acme/store/pull/802 https://github.com/acme/ui/pull/3'))
  await $.prompt.submit(submit('https://linear.app/acme/issue/ENG-4321/billing-page and https://linear.app/acme/project/new-onboarding-0a1b2c3d4e5f'))
  await clock.advance(10)

  const ui = await $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect((await rows(ui)).map(b => b.text)).toEqual([
    '🟢    🦯 store | #802',
    '🟢    🦯 ui    | #3',
    'ENG-4321 | billing page',
    'project  | new onboarding',
  ])
  expect((await ui.find({ key: 'linear-header' }))?.text).toContain('Linear')
})

test('a PR row shows its short title after the label, the labels padded to line up', async ($, on) => {
  const clock = world(on)
  on('process.run', async (_$, e) =>
    ran(
      pr('OPEN', {
        author: { login: e.argv[3] === '802' ? 'mreedr' : 'octocat' },
        title: e.argv[3] === '802' ? 'feat(cart): create the checkout session once its customer exists (T3b)' : 'fix: remove legacyFlag',
      }),
    ),
  )
  await $.prompt.submit(submit('https://github.com/acme/store/pull/802 https://github.com/acme/ui/pull/3'))
  await clock.advance(10)

  const ui = await $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  // The whole row past the `x` is the one Button that opens the PR.
  expect((await rows(ui)).map(b => b.text)).toEqual([
    '🟢    🦯 store | #802  mr cart · create the checkout session',
    '🟢    🦯 ui    | #3    oc remove legacyFlag',
  ])
  // The label is the slate blue, the description all gray.
  const json = JSON.stringify((await rows(ui))[0])
  expect(json).toContain('"color":"#8b95b8"')
  expect(json).toContain('{"type":"Text","props":{"dimColor":true},"children":["  mr cart · create the checkout session"]}')

  // In a narrow band the description is cut to fit: 50 columns less the border (4) and `x ` (2).
  const narrow = await $.ui.mount({
    plugin: 'gh-linear-parse-mod',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { ...(PROPS as object), bodyColumns: 50 } as never,
  })
  const cut = (await rows(narrow)).map(b => b.text)
  expect(cut).toEqual(['🟢    🦯 store | #802  mr cart · create the…', '🟢    🦯 ui    | #3    oc remove legacyFlag'])
})

test('a PR row shows its lines added and deleted, then its short title, both lined up', async ($, on) => {
  const clock = world(on)
  on('process.run', async (_$, e) => {
    const big = e.argv[3] === '802'
    return ran(
      pr('OPEN', {
        author: { login: big ? 'mreedr' : 'octocat' },
        title: big ? 'feat(cart): one session' : 'fix: remove legacyFlag',
        additions: big ? 1204 : 3,
        deletions: big ? 88 : 4,
      }),
    )
  })
  await $.prompt.submit(submit('https://github.com/acme/store/pull/802 https://github.com/acme/ui/pull/3 https://linear.app/acme/issue/ENG-1/x'))
  await clock.advance(10)

  const ui = await $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ key: 'view' })).toBeUndefined()
  expect((await rows(ui)).map(b => b.text)).toEqual([
    '🟢    🦯 store | #802  mr +1204 -88  cart · one session',
    '🟢    🦯 ui    | #3    oc    +3 -4   remove legacyFlag',
    'ENG-1 | x',
  ])
  const json = JSON.stringify((await rows(ui))[0])
  expect(json).toContain('{"type":"Text","props":{"color":"green","dimColor":false},"children":["+1204"]}')
  expect(json).toContain('{"type":"Text","props":{"color":"red","dimColor":false},"children":["-88"]}')
  const band = JSON.parse(String((await $.tool.call({ tool: 'mcp__gh-linear-parse-mod__links_band' })).result))
  expect(band.links[0]).toMatchObject({ additions: 1204, deletions: 88 })

  // The counts stay whole and the title takes what is left.
  const narrow = await $.ui.mount({
    plugin: 'gh-linear-parse-mod',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 52 } as never,
  })
  expect((await rows(narrow))[0]?.text).toBe('🟢    🦯 store | #802  mr +1204 -88  cart · o…')
})

test('a session start reads again the PRs checked before counts were fetched', async ($, on) => {
  const clock = world(on)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', async (_$, e) => ({ value: { tool: e.name } }))
  let withCounts = false
  const calls: string[] = []
  on('process.run', async (_$, e) => {
    calls.push(e.argv[3]!)
    return ran(pr('OPEN', withCounts ? { additions: 5, deletions: 2 } : {}))
  })
  await $.prompt.submit(submit('https://github.com/a/b/pull/1'))
  await clock.advance(10)
  withCounts = true

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  expect(calls).toEqual(['1', '1'])
  const ui = await $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect((await rows(ui))[0]?.text).toBe('🟢    🦯 b | #1  +5 -2')
})

// A Linear MCP server under `server` whose issues have the given statuses.
function linear(on: On, server: string, statuses: Record<string, [string, string]>, listed: string[] = []) {
  const calls: string[] = []
  on('tool.list', async () => ({ value: listed.map(name => ({ name, description: '', mcp: true })) }))
  on('mcp.call', async (_$, e) => {
    if (e.server !== server || e.tool !== 'get_issue') throw new Error(`no server ${e.server}`)
    const id = String(e.args.id)
    calls.push(id)
    const s = statuses[id]
    const text = s ? JSON.stringify({ id, status: s[0], statusType: s[1] }) : 'Issue not found'
    return { value: { content: [{ type: 'text', text }], isError: !s } }
  })
  return calls
}

test('Linear issues show their status, the names lined up and finished ones dimmed', async ($, on) => {
  const clock = world(on)
  on('process.run', async () => ran(pr('OPEN')))
  linear(on, 'linear-server', { 'ENG-1': ['In progress', 'started'], 'ENG-22': ['Deployed', 'completed'] })
  await $.prompt.submit(
    submit('https://github.com/acme/store/pull/802 https://linear.app/acme/issue/ENG-1/fix-cart https://linear.app/acme/issue/ENG-22/x'),
  )
  await clock.advance(10)

  const ui = await $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect((await rows(ui)).map(b => b.text)).toEqual([
    '🟢    🦯 store | #802',
    '🟡 ENG-1  | fix cart  In progress',
    '🟣 ENG-22 | x         Deployed',
  ])
  expect(JSON.stringify((await rows(ui))[2])).toContain('"bold":false,"dimColor":true')
  // Its own header row labels the status column St.
  const divider = (await ui.find({ key: 'linear-header' }))?.text ?? ''
  expect(divider).toContain('St')
  expect(divider).toContain('Linear')
  const band = JSON.parse(String((await $.tool.call({ tool: 'mcp__gh-linear-parse-mod__links_band' })).result))
  expect(band.links[1]).toMatchObject({ status: 'In progress', statusType: 'started' })
})

test('a Linear-only band with statuses gets one status cell and a Refresh button', async ($, on) => {
  const clock = world(on)
  const calls = linear(on, 'linear-server', { 'ENG-3': ['Triage', 'triage'] })
  await $.prompt.submit(submit('https://linear.app/acme/issue/ENG-3/z'))
  await clock.advance(10)

  const ui = await $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect((await rows(ui))[0]?.text).toBe('📥 ENG-3 | z  Triage')
  expect(await ui.find({ key: 'label-pr' })).toBe(undefined)
  expect((await ui.find({ key: 'label-st' }))?.text).toBe('St')
  await ui.press({ key: 'refresh' })
  await clock.advance(10)
  expect(calls).toEqual(['ENG-3', 'ENG-3'])
})

test('the Linear server is found from the tool list', async ($, on) => {
  const clock = world(on)
  linear(on, 'claude_ai_Linear', { 'ENG-5': ['Icebox', 'backlog'] }, ['mcp__claude_ai_Linear__get_issue'])
  await $.prompt.submit(submit('https://linear.app/acme/issue/ENG-5'))
  await clock.advance(10)

  const ui = await $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect((await rows(ui))[0]?.text).toBe('💤 ENG-5  Icebox')
})

test('each kind of link has its own section: Status, GitHub, then Linear', async ($, on) => {
  const clock = world(on)
  on('process.run', async () => ran(pr('OPEN')))
  await $.prompt.submit(submit('https://linear.app/acme/issue/ENG-2'))
  const ui = await $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect((await rows(ui))[0]?.text).toBe('ENG-2')
  expect((await ui.find({ key: 'linear-header' }))?.text).toBe('Linear')
  expect(await ui.find({ key: 'github-header' })).toBe(undefined)
  expect(await ui.find({ key: 'status-header' })).toBe(undefined)

  await $.prompt.submit(submit('https://github.com/a/b/pull/1'))
  await $.tool.call({ tool: 'mcp__gh-linear-parse-mod__set_status', text: 'reviewing' })
  await clock.advance(10)
  const tree = JSON.stringify(await ui.drawn())
  expect((await ui.find({ key: 'github-header' }))?.text).toBe('PRCIRvGitHub')
  const order = ['status-header', 'github-header', 'linear-header'].map(k => tree.indexOf(`"key":"${k}"`))
  expect(order.every(i => i > 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
})

test('the header shows when PRs were last read, and Refresh reads them again', async ($, on) => {
  const clock = world(on)
  let calls = 0
  let release = () => {}
  on('process.run', async () => {
    calls++
    if (calls === 2) await new Promise<void>(r => (release = r))
    return ran(pr('OPEN'))
  })
  await $.prompt.submit(submit('https://github.com/a/b/pull/1'))
  await clock.advance(10)

  const ui = await $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const first = clock.now()
  expect((await ui.find({ key: 'updated' }))?.text).toBe(`· updated ${clockTime(first)}`)

  await clock.advance(60_000)
  await ui.press({ key: 'refresh' })
  await clock.advance(10)
  expect((await ui.find({ key: 'refresh' }))?.text).toBe('Refreshing…')
  release()
  await clock.advance(10)
  expect(calls).toBe(2)
  expect((await ui.find({ key: 'refresh' }))?.text).toBe('Refresh')
  expect((await ui.find({ key: 'updated' }))?.text).not.toBe(`· updated ${clockTime(first)}`)
})

test('a Linear-only band has no updated time or Refresh button', async ($, on) => {
  world(on)
  await $.prompt.submit(submit('https://linear.app/acme/issue/ENG-3/z'))
  const ui = await $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ key: 'updated' })).toBe(undefined)
  expect(await ui.find({ key: 'refresh' })).toBe(undefined)
})

test('Linear-only bands have no status columns', async ($, on) => {
  world(on)
  await $.prompt.submit(submit('https://linear.app/acme/issue/ENG-2/y'))
  const ui = await $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ key: 'label-pr' })).toBe(undefined)
  expect((await rows(ui))[0]?.text).toBe('ENG-2 | y')
})

test('a PR with CI running is polled every 90s until CI settles', async ($, on) => {
  const clock = world(on)
  let calls = 0
  on('process.run', async () => {
    calls++
    const status = calls < 3 ? 'IN_PROGRESS' : 'COMPLETED'
    const stdout = pr('OPEN', { statusCheckRollup: [{ __typename: 'CheckRun', status, conclusion: status === 'COMPLETED' ? 'SUCCESS' : '' }] })
    return ran(stdout)
  })

  await $.prompt.submit(submit('https://github.com/a/b/pull/7'))
  await clock.advance(10)
  expect(calls).toBe(1)
  await clock.advance(90_000)
  expect(calls).toBe(2)
  await clock.advance(90_000)
  expect(calls).toBe(3)
  await clock.advance(90_000)
  expect(calls).toBe(3)

  const ui = await $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect((await rows(ui))[0]?.text).toBe('🟢 ✅ 🦯 b | #7')
})

describe('5-minute watch', () => {
  const FIVE_MIN = 5 * 60_000
  const command = (args: string) => ({
    command: 'gh-linear-parse-mod',
    args,
    origin: { kind: 'composer' as const },
    presentation: { isFullscreen: true, columns: 120 },
  })

  // Two PRs, #1 open with CI passed and #2 merged; counts gh calls per PR.
  function prs(on: On) {
    const calls: Record<string, number> = {}
    on('process.run', async (_$, e) => {
      const number = String(e.argv[3])
      calls[number] = (calls[number] ?? 0) + 1
      const checks = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }]
      return ran(pr(number === '1' ? 'OPEN' : 'MERGED', { statusCheckRollup: checks }))
    })
    return calls
  }

  test('re-checks open PRs in view, not merged ones', async ($, on) => {
    const clock = world(on)
    const calls = prs(on)
    await $.prompt.submit(submit('https://github.com/a/b/pull/1 https://github.com/a/b/pull/2'))
    await clock.advance(10)
    expect(calls).toEqual({ 1: 1, 2: 1 })
    await clock.advance(FIVE_MIN)
    expect(calls).toEqual({ 1: 2, 2: 1 })
    await clock.advance(FIVE_MIN)
    expect(calls).toEqual({ 1: 3, 2: 1 })
  })

  test('watch off stops it and watch on starts it again', async ($, on) => {
    const clock = world(on)
    const calls = prs(on)
    await $.prompt.submit(submit('https://github.com/a/b/pull/1'))
    await clock.advance(10)
    expect((await $.command.run(command('watch off'))).text).toContain('off')
    await clock.advance(FIVE_MIN)
    expect(calls[1]).toBe(1)
    await $.command.run(command('watch on'))
    await clock.advance(FIVE_MIN)
    expect(calls[1]).toBe(2)
  })

  test('a hidden band is not watched', async ($, on) => {
    const clock = world(on)
    const calls = prs(on)
    await $.prompt.submit(submit('https://github.com/a/b/pull/1'))
    await clock.advance(10)
    await $.command.run(command('off'))
    await clock.advance(FIVE_MIN)
    expect(calls[1]).toBe(1)
  })
})


test('a /clear empties the band, its statuses and dismissals, and keeps the color', async ($, on) => {
  const clock = world(on)
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('process.run', async () => ran(pr('OPEN')))
  const command = (args: string) => ({
    command: 'gh-linear-parse-mod',
    args,
    origin: { kind: 'composer' as const },
    presentation: { isFullscreen: true, columns: 120 },
  })
  await $.prompt.submit(submit('https://github.com/a/b/pull/1 https://linear.app/acme/issue/ENG-1/x'))
  await clock.advance(10)
  await $.command.run(command('color red'))
  const ui = await $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'dismiss:github:a/b#1' })
  const band = async () => JSON.parse(String((await $.tool.call({ tool: 'mcp__gh-linear-parse-mod__links_band' })).result))
  expect((await band()).dismissed).toEqual(['github:a/b#1'])
  expect((await band()).links).toHaveLength(1)

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })

  const state = await band()
  expect(state.links).toEqual([])
  expect(state.dismissed).toEqual([])
  expect(state.lastCheckedAt).toBe(null)
  expect(state.color).toEqual({ color: 'red', isFill: false })

  await $.prompt.submit(submit('https://github.com/a/b/pull/1'))
  expect((await band()).links.map((l: { url: string }) => l.url)).toEqual(['https://github.com/a/b/pull/1'])
})

test('set_status puts a status line atop the band; x, an empty text and /clear take it down', async ($, on) => {
  const clock = world(on)
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  const setStatus = (text?: string) =>
    $.tool.call({ tool: 'mcp__gh-linear-parse-mod__set_status', ...(text === undefined ? {} : { text }) })
  const mount = () => $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const band = async () => JSON.parse(String((await $.tool.call({ tool: 'mcp__gh-linear-parse-mod__links_band' })).result))

  // No links yet: the band is just the status line.
  expect(String((await setStatus('  waiting on\n CI for #812 ')).result)).toBe('Status set: waiting on CI for #812')
  const time = clockTime(clock.now())
  expect((await (await mount()).find({ key: 'status' }))?.text).toBe(`xwaiting on CI for #812  ${time}`)
  expect((await band()).agentStatus).toMatchObject({ text: 'waiting on CI for #812' })

  // With links it sits under the header.
  await $.prompt.submit(submit('https://linear.app/acme/issue/ENG-1/x'))
  await clock.advance(10)
  const ui = await mount()
  expect((await ui.find({ key: 'status' }))?.text).toBe(`xwaiting on CI for #812  ${time}`)
  await ui.press({ key: 'dismiss:status' })
  expect(await ui.find({ key: 'status' })).toBeUndefined()
  expect((await band()).agentStatus).toBeNull()

  await setStatus('reviewing')
  expect(String((await setStatus('')).result)).toBe('Status cleared.')
  expect((await band()).agentStatus).toBeNull()

  await setStatus('reviewing')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect((await band()).agentStatus).toBeNull()
})

test('a long status is cut to the band, its time kept whole', async ($, on) => {
  const clock = world(on)
  await $.tool.call({ tool: 'mcp__gh-linear-parse-mod__set_status', text: 'x'.repeat(200) })
  const ui = await $.ui.mount({
    plugin: 'gh-linear-parse-mod',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 40 } as never,
  })
  const text = (await ui.find({ key: 'status' }))?.text ?? ''
  expect(text.endsWith(`  ${clockTime(clock.now())}`)).toBe(true)
  expect(text).toContain('…')
})

test('the header counts the links, puts its actions last and drops the time when narrow', async ($, on) => {
  const clock = world(on)
  on('process.run', async () => ran(pr('OPEN', { isDraft: true })))
  await $.prompt.submit(submit([1, 2, 3, 4, 5, 6, 7].map(n => `https://github.com/a/b/pull/${n}`).join(' ')))
  await clock.advance(10)
  const mount = (bodyColumns: number) =>
    $.ui.mount({
      plugin: 'gh-linear-parse-mod',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns } as never,
    })

  const ui = await mount(120)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('Session links (7)')
  expect((await ui.find({ key: 'expand' }))?.text).toBe('Show 2 more')
  expect(await ui.find({ key: 'updated' })).toBeDefined()
  expect(tree.indexOf('"spacer"')).toBeLessThan(tree.indexOf('"refresh"'))
  // A draft is not asking for review yet, so it gets no 🦯.
  expect((await rows(ui))[0]?.text).toBe('📝       b | #1')

  expect(await (await mount(50)).find({ key: 'updated' })).toBeUndefined()
})

test('a resumed session gets its links and dismissals back from the store', async ($, on) => {
  const clock = world(on)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', async (_$, e) => ({ value: { tool: e.name } }))
  on('session.id', async () => ({ value: 's1' }))
  const calls: string[] = []
  on('process.run', async (_$, e) => {
    calls.push(e.argv[3]!)
    return ran(pr('OPEN'))
  })
  await $.prompt.submit(submit('https://github.com/a/b/pull/1 https://github.com/a/b/pull/2'))
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'dismiss:github:a/b#2' })
  await ui.unmount()

  // The band empties as a restart's would; the store still holds this session's links.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  const band = async () => JSON.parse(String((await $.tool.call({ tool: 'mcp__gh-linear-parse-mod__links_band' })).result))
  expect((await band()).links).toEqual([])
  calls.length = 0

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  const resumed = await $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect((await rows(resumed)).map(b => b.text)).toEqual(['🟢    🦯 b | #1'])
  expect((await band()).dismissed).toEqual(['github:a/b#2'])
  expect(calls).toEqual(['1'])
})

test('an unknown option shows the help and leaves the band as it is; a bare color name sets the color', async ($, on) => {
  world(on)
  const command = (args: string) =>
    $.command.run({ command: 'gh-linear-parse-mod', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } })
  const band = async () => JSON.parse(String((await $.tool.call({ tool: 'mcp__gh-linear-parse-mod__links_band' })).result))

  expect(String((await command('frobnicate')).text)).toContain('Unknown option "frobnicate". Use no option')
  expect((await band()).isHidden).toBe(false)

  expect(String((await command('red')).text)).toBe('Band border set to red for this session.')
  expect((await band()).color).toEqual({ color: 'red', isFill: false })
  expect(String((await command('cyan fill')).text)).toBe('Band fill set to cyan for this session.')
  expect((await band()).isHidden).toBe(false)

  expect(String((await command('')).text)).toBe('Session links hidden.')
})

test('🧹 dismisses merged and closed PRs and shows only when there are some', async ($, on) => {
  const clock = world(on)
  const states: Record<string, string> = { '1': 'OPEN', '2': 'MERGED', '3': 'CLOSED' }
  on('process.run', async (_$, e) => ran(pr(states[e.argv[3]!]!)))
  await $.prompt.submit(
    submit('https://github.com/a/b/pull/1 https://github.com/a/b/pull/2 https://github.com/a/b/pull/3 https://linear.app/acme/issue/ENG-1/x'),
  )
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const band = async () => JSON.parse(String((await $.tool.call({ tool: 'mcp__gh-linear-parse-mod__links_band' })).result))

  expect((await ui.find({ key: 'sweep' }))?.text).toBe('🧹')
  await ui.press({ key: 'sweep' })
  expect((await rows(ui)).map(b => b.text)).toEqual(['🟢    🦯 b | #1', 'ENG-1 | x'])
  expect((await band()).dismissed).toEqual(['github:a/b#2', 'github:a/b#3'])
  expect(await ui.find({ key: 'sweep' })).toBe(undefined)

  await $.prompt.submit(submit('https://github.com/a/b/pull/2'))
  expect((await band()).links.map((l: { url: string }) => l.url)).not.toContain('https://github.com/a/b/pull/2')
})

test('add <url> puts a link in the band, brings back a dismissed one and shows a hidden band', async ($, on) => {
  const clock = world(on)
  const calls: string[] = []
  on('process.run', async (_$, e) => {
    calls.push(e.argv[3]!)
    return ran(pr('OPEN'))
  })
  const command = async (args: string) =>
    String(
      (
        await $.command.run({
          command: 'gh-linear-parse-mod',
          args,
          origin: { kind: 'composer' as const },
          presentation: { isFullscreen: true, columns: 120 },
        })
      ).text,
    )
  const band = async () => JSON.parse(String((await $.tool.call({ tool: 'mcp__gh-linear-parse-mod__links_band' })).result))

  expect(await command('add')).toBe('No GitHub PR or Linear link found. Use "add <url>".')
  expect(await command('add https://github.com/a/b')).toBe('No GitHub PR or Linear link found. Use "add <url>".')

  expect(await command('add https://github.com/a/b/pull/1')).toBe('Added https://github.com/a/b/pull/1.')
  await clock.advance(10)
  expect(calls).toEqual(['1'])
  const ui = await $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect((await rows(ui)).map(b => b.text)).toEqual(['🟢    🦯 b | #1'])

  await ui.press({ key: 'dismiss:github:a/b#1' })
  await command('off')
  await $.prompt.submit(submit('https://github.com/a/b/pull/1'))
  expect((await band()).links).toEqual([])

  await command('add https://github.com/a/b/pull/1')
  await clock.advance(10)
  const state = await band()
  expect(state.links.map((l: { url: string }) => l.url)).toEqual(['https://github.com/a/b/pull/1'])
  expect(state.dismissed).toEqual([])
  expect(state.isHidden).toBe(false)
  expect(calls).toEqual(['1', '1'])
})

test('group_prs lays out the GitHub section; group asks Claude and group clear drops it', async ($, on) => {
  const prompts: unknown[] = []
  on('prompt.submit', async (_$, e) => {
    prompts.push(e)
    return { text: e.text }
  })
  mock.store(on)
  const clock = mock.clock(on)
  on('process.run', async () => ran(pr('OPEN')))
  const command = async (args: string) =>
    String(
      (
        await $.command.run({
          command: 'gh-linear-parse-mod',
          args,
          origin: { kind: 'composer' as const },
          presentation: { isFullscreen: true, columns: 120 },
        })
      ).text,
    )
  const group = async (groups: unknown) =>
    String((await $.tool.call({ tool: 'mcp__gh-linear-parse-mod__group_prs', groups } as never)).result)
  const band = async () => JSON.parse(String((await $.tool.call({ tool: 'mcp__gh-linear-parse-mod__links_band' })).result))
  const mount = () => $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const lines = async () =>
    (await (await mount()).findAll({ type: 'Box' }))
      .filter(b => b.key?.startsWith('group-') || b.key?.startsWith('github:'))
      .map(b => b.text.replace(/^x/, '').trim())

  expect(await command('group by merge order')).toBe('Asked Claude to group the PRs in the band.')
  await clock.advance(10)
  const asked = prompts.at(-1) as { text: string; origin: { asUser?: boolean } }
  expect(asked.text).toContain('mcp__gh-linear-parse-mod__group_prs: by merge order.')
  expect(asked.origin.asUser).toBe(true)

  await $.prompt.submit(submit('https://github.com/a/b/pull/1 https://github.com/a/b/pull/2 https://github.com/a/c/pull/3'))
  await clock.advance(10)
  expect(
    await group([
      { label: 'round 1', prs: ['c#3', 'https://github.com/a/b/pull/1'] },
      { label: 'round 2', text: 'run the checks after round 1' },
      { text: 'a note', prs: ['a/d#4', 'nope'] },
    ]),
  ).toBe(
    'Grouped the GitHub section: round 1 (2 PRs), round 2 (0 PRs), text (1 PR). Skipped (not a PR link, owner/repo#N, or a repo#N in the band): nope.',
  )
  await clock.advance(10)
  expect(await lines()).toEqual([
    '── round 1 ──',
    '🟢    🦯 c | #3',
    '🟢    🦯 b | #1',
    '── round 2 ──',
    'run the checks after round 1',
    'a note',
    '🟢    🦯 d | #4',
    '── other ──',
    '🟢    🦯 b | #2',
  ])
  expect((await band()).groups[0]).toEqual({ label: 'round 1', prs: ['https://github.com/a/c/pull/3', 'https://github.com/a/b/pull/1'] })

  // A mention does not move a grouped PR; x on a PR or a label takes it out.
  await $.prompt.submit(submit('https://github.com/a/b/pull/1'))
  const ui = await mount()
  await ui.press({ key: 'dismiss:github:a/c#3' })
  await ui.press({ key: 'dismiss:group-label:1' })
  expect(await lines()).toEqual(['── round 1 ──', '🟢    🦯 b | #1', 'a note', '🟢    🦯 d | #4', '── other ──', '🟢    🦯 b | #2'])

  expect(await command('group clear')).toBe('Grouping cleared; the GitHub section is newest first again.')
  expect((await band()).groups).toBe(null)
  expect(await lines()).toEqual(['🟢    🦯 b | #1', '🟢    🦯 d | #4', '🟢    🦯 b | #2'])
  expect(await group([])).toBe('Grouping cleared; the GitHub section is newest first again.')
})

test('a resumed session gets its PR groups back', async ($, on) => {
  const clock = world(on)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', async (_$, e) => ({ value: { tool: e.name } }))
  on('session.id', async () => ({ value: 's1' }))
  on('process.run', async () => ran(pr('OPEN')))
  const band = async () => JSON.parse(String((await $.tool.call({ tool: 'mcp__gh-linear-parse-mod__links_band' })).result))
  await $.prompt.submit(submit('https://github.com/a/b/pull/1 https://github.com/a/b/pull/2'))
  await $.tool.call({ tool: 'mcp__gh-linear-parse-mod__group_prs', groups: [{ label: 'first', text: 'then the rest', prs: ['b#2'] }] } as never)
  await clock.advance(10)

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect((await band()).groups).toBe(null)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  expect((await band()).groups).toEqual([{ label: 'first', text: 'then the rest', prs: ['https://github.com/a/b/pull/2'] }])
})

test('a session start redraws the band and drops the old Diff setting', async ($, on) => {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  mock.clock(on)
  const store = new Map<string, unknown>([['isDiff', true]])
  on('store.get', async (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', async (_$, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', async (_$, e) => (store.delete(e.key), { value: undefined }))
  on('store.keys', async () => ({ value: [...store.keys()] }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', async (_$, e) => ({ value: { tool: e.name } }))
  on('session.id', async () => ({ value: 's1' }))
  const invalidated: string[] = []
  on('ui.invalidate', async (_$, e) => {
    invalidated.push(String((e as { event?: string }).event ?? e))
    return { value: undefined }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(invalidated).toHaveLength(1)
  expect(store.has('isDiff')).toBe(false)
})
