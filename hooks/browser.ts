import type { EngineInterface } from 'claude-code'

type $ = EngineInterface

// Chromium browsers share the AppleScript dictionary that lists and selects tabs.
const CHROMIUM = ['Brave Browser', 'Google Chrome', 'Google Chrome Canary', 'Microsoft Edge', 'Chromium', 'Vivaldi']
export const canReuseTabs = (browser: string) => CHROMIUM.includes(browser)

// A tab already on `url` (or a page under it, such as a PR's /files) is brought to the front.
export const FIND_TAB = `function run(argv) {
  const [name, url] = argv
  const app = Application(name)
  if (!app.running()) return 'missing'
  const want = url.toLowerCase()
  for (const w of app.windows()) {
    const urls = w.tabs.url()
    for (let i = 0; i < urls.length; i++) {
      const t = (urls[i] || '').toLowerCase()
      if (t === want || ['/', '?', '#'].some(c => t.startsWith(want + c))) {
        w.activeTabIndex = i + 1
        w.index = 1
        app.activate()
        return 'found'
      }
    }
  }
  return 'missing'
}`

export type Platform = 'mac' | 'linux' | 'windows'

let platform: Platform | undefined

async function detectPlatform($: $): Promise<Platform> {
  if (platform) return platform
  const ran = await $.process.run(['uname', '-s'], { timeoutMs: 5_000 }).catch(() => null)
  const name = ran?.exitCode === 0 ? ran.stdout.trim() : ''
  platform = name === 'Darwin' ? 'mac' : name ? 'linux' : 'windows'
  return platform
}

export function defaultOpen(p: Platform, url: string): string[] {
  if (p === 'mac') return ['open', url]
  if (p === 'linux') return ['xdg-open', url]
  return ['cmd', '/c', 'start', '""', url]
}

async function ok($: $, argv: string[]) {
  return (await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => null))?.exitCode === 0
}

// `browser` empty opens the system default. Named, on macOS, it opens there, first
// switching to a tab already on the link when the browser is a Chromium one.
export async function openLink($: $, url: string, browser: string) {
  const p = await detectPlatform($)
  if (browser && p === 'mac') {
    if (canReuseTabs(browser)) {
      const found = await $.process.run(['osascript', '-l', 'JavaScript', '-e', FIND_TAB, browser, url], { timeoutMs: 10_000 }).catch(() => null)
      if (found?.exitCode === 0 && found.stdout.trim() === 'found') return
    }
    if (await ok($, ['open', '-a', browser, url])) return
    $.ui.toast(`Could not open ${browser}; used the default browser.`)
  }
  await ok($, defaultOpen(p, url))
}
