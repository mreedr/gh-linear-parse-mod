import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

import { canReuseTabs, defaultOpen } from '../hooks/browser'

const PROPS = { hasSurvey: false, isWorking: false, maxRows: 20 } as never
const URL = 'https://linear.app/acme/issue/ENG-1/x'
const out = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// A Mac whose commands answer as `answer` says; every argv run is recorded.
function mac(on: On, answer: (argv: string[]) => ReturnType<typeof out> = () => out('')) {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  mock.store(on)
  const runs: string[][] = []
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    if (argv[0] === 'uname') return out('Darwin\n')
    runs.push(argv)
    return answer(argv)
  })
  return runs
}

async function pressLink($: Parameters<TestBody>[0]) {
  await $.prompt.submit({ text: URL, wait: false, origin: { kind: 'composer' } })
  const ui = await $.ui.mount({ plugin: 'gh-linear-parse-mod', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'open:linear:acme/issue/eng-1' })
}

const brave = { options: { browser: 'Brave Browser' } }

describe('opening a link', () => {
  test('with no browser set it opens the system default', async ($, on) => {
    const runs = mac(on)
    await pressLink($)
    expect(runs).toEqual([['open', URL]])
  })

  test('a Chromium browser switches to a tab already on the link', brave, async ($, on) => {
    const runs = mac(on, argv => out(argv[0] === 'osascript' ? 'found\n' : ''))
    await pressLink($)
    expect(runs.map(r => r[0])).toEqual(['osascript'])
    expect(runs[0]?.slice(-2)).toEqual(['Brave Browser', URL])
  })

  test('with no tab on it, it opens a new one in that browser', brave, async ($, on) => {
    const runs = mac(on, argv => out(argv[0] === 'osascript' ? 'missing\n' : ''))
    await pressLink($)
    expect(runs.map(r => r.join(' '))).toEqual([expect.stringContaining('osascript') as never, `open -a Brave Browser ${URL}`])
  })

  test('a browser that will not open falls back to the default', { options: { browser: 'Safari' } }, async ($, on) => {
    const runs = mac(on, argv => out('', argv[1] === '-a' ? 1 : 0))
    await pressLink($)
    // Safari is not a Chromium browser, so no tab search
    expect(runs).toEqual([['open', '-a', 'Safari', URL], ['open', URL]])
  })
})

test('defaultOpen per platform, and which browsers reuse tabs', () => {
  expect(defaultOpen('mac', URL)).toEqual(['open', URL])
  expect(defaultOpen('linux', URL)).toEqual(['xdg-open', URL])
  expect(defaultOpen('windows', URL)).toEqual(['cmd', '/c', 'start', '""', URL])
  expect(canReuseTabs('Brave Browser')).toBe(true)
  expect(canReuseTabs('Safari')).toBe(false)
})
