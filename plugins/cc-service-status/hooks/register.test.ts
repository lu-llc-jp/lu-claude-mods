import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseSummary, statusLine } from './summary'

const summary = (overrides: {
  indicator?: string
  description?: string
  consoleStatus?: string
  incidents?: unknown[]
}) =>
  JSON.stringify({
    status: {
      indicator: overrides.indicator ?? 'none',
      description: overrides.description ?? 'All Systems Operational',
    },
    components: [
      { name: 'claude.ai', status: 'operational', group: false },
      {
        name: 'Claude Console (platform.claude.com)',
        status: overrides.consoleStatus ?? 'operational',
        group: false,
      },
      { name: 'Claude API (api.anthropic.com)', status: 'operational', group: false },
    ],
    incidents: overrides.incidents ?? [],
    scheduled_maintenances: [],
  })

const OUTAGE = summary({
  indicator: 'minor',
  description: 'Minor Service Outage',
  consoleStatus: 'partial_outage',
  incidents: [
    {
      name: 'Elevated errors on platform.claude.com',
      status: 'identified',
      impact: 'major',
      updated_at: '2026-10-07T17:28:02.593Z',
      shortlink: 'https://stspg.io/example',
    },
  ],
})

/** ステータスラインへの表示を拾う */
const captureStatus = (on: On) => {
  const lines: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  return lines
}

/** http.fetch の応答を差し替える */
const answerFetch = (on: On, answer: () => { status: number; text: string }) => {
  on('http.fetch', () => {
    const { status, text } = answer()
    return { value: { status, ok: status >= 200 && status < 300, headers: {}, text } }
  })
}

const answerCommandAndPane = (on: On) => {
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

const runCommand = ($: Engine) =>
  $.command.run({
    command: 'cc-service-status',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

test('全コンポーネントが正常なら「正常」と出す', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-08T00:00:00Z') })
  const lines = captureStatus(on)
  answerFetch(on, () => ({ status: 200, text: summary({}) }))
  answerCommandAndPane(on)

  const { text } = await runCommand($)

  expect(text).toBe('Claude: 正常')
  expect(lines.at(-1)).toBe('Claude: 正常')
})

test('障害中のコンポーネント名を出す', async ($, on) => {
  mock.clock(on)
  const lines = captureStatus(on)
  answerFetch(on, () => ({ status: 200, text: OUTAGE }))
  answerCommandAndPane(on)

  await runCommand($)

  expect(lines.at(-1)).toBe('Claude: 一部障害 — Claude Console')
})

test('取得に失敗しても前回の値を残す', async ($, on) => {
  mock.clock(on)
  const lines = captureStatus(on)
  let fail = false
  answerFetch(on, () => (fail ? { status: 500, text: '' } : { status: 200, text: OUTAGE }))
  answerCommandAndPane(on)

  await runCommand($)
  fail = true
  await runCommand($)

  expect(lines.at(-1)).toBe('Claude: 一部障害 — Claude Console(更新失敗)')
})

test('一度も取得できていなければそう出す', async ($, on) => {
  mock.clock(on)
  const lines = captureStatus(on)
  answerFetch(on, () => ({ status: 503, text: '' }))
  answerCommandAndPane(on)

  await runCommand($)

  expect(lines.at(-1)).toBe('Claude: 状態を取得できません')
})

test('セッション開始時と5分ごとに取得する', async ($, on) => {
  const clock = mock.clock(on)
  const lines = captureStatus(on)
  let calls = 0
  answerFetch(on, () => {
    calls += 1
    return { status: 200, text: summary({}) }
  })
  answerCommandAndPane(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(calls).toBe(1)
  expect(lines.at(-1)).toBe('Claude: 正常')

  await clock.advance(5 * 60 * 1000)
  expect(calls).toBe(2)
})

test('ペインに状態とインシデントを描く', async ($, on) => {
  mock.clock(on)
  captureStatus(on)
  answerFetch(on, () => ({ status: 200, text: OUTAGE }))
  answerCommandAndPane(on)
  await runCommand($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'cc-service-status',
      surface,
      component: 'Pane',
      requestId: 'cc-service-status',
      props: {
        title: 'Claude status',
        isFocused: false,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    })
    expect(await ui.find({ text: /Elevated errors on platform\.claude\.com/ })).toBeDefined()
    expect(await ui.find({ text: /一部停止/ })).toBeDefined()
    await ui.unmount()
  }
})

test('形の崩れた JSON でも落ちない', () => {
  const s = parseSummary('{"components":[{"name":1}],"incidents":"x"}', 0)
  expect(s.indicator).toBe('unknown')
  expect(s.incidents).toEqual([])
  expect(s.components).toEqual([])
  expect(statusLine(s)).toBe('Claude: 不明')
})
