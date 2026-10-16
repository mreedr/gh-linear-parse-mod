import { expect, mock, test } from 'claude-code/testing'

test('links_band reports the band state', async $ => {
  const ran = await $.tool.call({ tool: 'mcp__gh-linear-parse-mod__links_band' })
  expect(ran.deny).toBe(undefined)
  expect(JSON.parse(String(ran.result))).toEqual({
    links: [],
    dismissed: [],
    isHidden: false,
    isExpanded: false,
    shownInBand: 0,
    groups: null,
    hidesAwaitingReview: false,
    isWatching: true,
    isNudging: true,
    agentStatus: null,
    lastCheckedAt: null,
    color: { color: 'gray', isFill: false },
  })
})

test("links_band reports each PR's CI state; Linear links carry none", async ($, on) => {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  const clock = mock.clock(on)
  on('process.run', async (_$, e) => {
    const status = e.argv[3] === '1' ? 'IN_PROGRESS' : 'COMPLETED'
    const conclusion = e.argv[3] === '1' ? '' : e.argv[3] === '2' ? 'FAILURE' : 'SUCCESS'
    const stdout = JSON.stringify({
      state: 'OPEN',
      isDraft: false,
      reviewDecision: null,
      statusCheckRollup: [{ __typename: 'CheckRun', status, conclusion }],
    })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.prompt.submit({
    text: 'https://github.com/a/b/pull/1 https://github.com/a/b/pull/2 https://github.com/a/b/pull/3 https://linear.app/acme/issue/ENG-1/x',
    wait: false,
    origin: { kind: 'composer' },
  })
  await clock.advance(10)

  const ran = await $.tool.call({ tool: 'mcp__gh-linear-parse-mod__links_band' })
  const { links } = JSON.parse(String(ran.result)) as { links: { url: string; ci?: string }[] }
  expect(links.map(l => [l.url, l.ci])).toEqual([
    ['https://github.com/a/b/pull/1', 'running'],
    ['https://github.com/a/b/pull/2', 'fail'],
    ['https://github.com/a/b/pull/3', 'pass'],
    ['https://linear.app/acme/issue/ENG-1/x', undefined],
  ])
})

test('the status nudge is in the system prompt by default, only with set_status, and nudge off takes it out', async ($, on) => {
  mock.store(on)
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))
  const STATUS = 'mcp__gh-linear-parse-mod__set_status'
  const compose = (tools: string[]) =>
    $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools, outputStyle: null, traits: [] })
  const ids = async (tools: string[]) => (await compose(tools)).sections.map(s => s.id)
  const command = (args: string) =>
    $.command.run({ command: 'gh-linear-parse-mod', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } })
  const band = async () => JSON.parse(String((await $.tool.call({ tool: 'mcp__gh-linear-parse-mod__links_band' })).result))

  expect(await ids([STATUS])).toEqual(['intro', 'gh-linear-parse-mod:status-nudge'])
  expect((await compose([STATUS])).sections[1]).toMatchObject({ scope: 'session' })
  expect(await ids(['Bash'])).toEqual(['intro'])

  expect(String((await command('nudge off')).text)).toContain('no longer asked')
  expect(await ids([STATUS])).toEqual(['intro'])
  expect((await band()).isNudging).toBe(false)

  expect(String((await command('nudge')).text)).toContain('are asked')
  expect(await ids([STATUS])).toEqual(['intro', 'gh-linear-parse-mod:status-nudge'])
  expect(String((await command('nudge maybe')).text)).toBe('Use "nudge on" or "nudge off".')
})
