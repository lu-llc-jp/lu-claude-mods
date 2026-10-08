import { expect, test } from 'claude-code/testing'

import type { WorkLogAgent, WorkLogEntry } from '../types'
import { FLIGHT_MS, isMapAnimating, layoutMap, type MapLine } from './map'

const T0 = 1_000_000

const entry = (id: string, text: string, at: number, more: Partial<WorkLogEntry> = {}): WorkLogEntry => ({
  id,
  kind: 'tool',
  text,
  at,
  status: 'ok',
  ...more,
})

const agent = (no: number, more: Partial<WorkLogAgent> = {}): WorkLogAgent => ({
  no,
  name: `調べる${no}`,
  type: 'Explore',
  model: 'claude-haiku-5-5',
  spawnEntryId: `call-${no}`,
  status: 'running',
  startedAt: T0,
  ...more,
})

/** メインが2つのサブエージェントを起動し、#1 は「TODO」を検索中、#2 は `b.ts` を読み終えたところ */
const twoAgents = (): WorkLogEntry[] => [
  entry('call-1', 'サブエージェント #1 を起動', T0, { status: 'running' }),
  entry('call-2', 'サブエージェント #2 を起動', T0, { status: 'running' }),
  entry('a1', '「TODO」を検索', T0 + 100, { agentId: 'agent-1', status: 'running' }),
  entry('b1', '`b.ts` を読む', T0 + 200, { agentId: 'agent-2' }),
]
const running = { 'agent-1': agent(1), 'agent-2': agent(2) }

/** 色分けを外し、文字だけにして比べる */
const draw = (lines: readonly MapLine[]): string[] => lines.map(line => line.segs.map(seg => seg.text).join('').trimEnd())

test('メインを真ん中に置き、サブエージェントを上と下に1本ずつの枝でつなぐ', () => {
  // 起動から十分たち、粒はもう届いている
  const lines = draw(layoutMap(twoAgents(), running, 'claude-opus-5-5', T0 + 8_000, 30))

  expect(lines).toEqual([
    '╭────────● #1 Explore·haiku-5-5『調べる1』',
    '│           「TODO」を検索',
    '◉ メイン·opus-5-5',
    '╰────────● #2 Explore·haiku-5-5『調べる2』',
  ])
})

test('起動したては、依頼の粒がメインから外へ流れていく', () => {
  const at = (ms: number) => draw(layoutMap(twoAgents(), running, '', T0 + ms, 30))

  expect(at(0)[0]).toBe('╭▸───────● #1 Explore·haiku-5-5『調べる1』')
  expect(at(FLIGHT_MS / 2)[0]).toBe('╭────▸───● #1 Explore·haiku-5-5『調べる1』')
  expect(at(FLIGHT_MS - 1)[0]).toMatch(/^╭───────▸[●○] #1/)
  expect(at(FLIGHT_MS)[0]).toBe('╭────────● #1 Explore·haiku-5-5『調べる1』')
  // もう1本の枝にも同じように流れる
  expect(at(0)[3]).toBe('╰▸───────● #2 Explore·haiku-5-5『調べる2』')
})

test('実行中の点は明滅し、終えると ✓ と所要時間に変わって、結果の粒がメインへ戻る', () => {
  const blink = [T0 + 8_000, T0 + 8_400].map(now => draw(layoutMap(twoAgents(), running, '', now, 30))[0])
  expect(blink).toEqual([
    '╭────────● #1 Explore·haiku-5-5『調べる1』',
    '╭────────○ #1 Explore·haiku-5-5『調べる1』',
  ])

  const end = T0 + 12_000
  const done = { ...running, 'agent-1': agent(1, { status: 'ok', durationMs: 12_000, endedAt: end }) }
  const list = twoAgents().map(one => (one.id === 'a1' ? { ...one, status: 'ok' as const } : one))
  const at = (ms: number) => draw(layoutMap(list, done, '', end + ms, 30))

  // 今のツールの行は消え、結果の粒が右から左へ戻る
  expect(at(0)).toEqual(['╭───────◂✓ #1 Explore·haiku-5-5『調べる1』 12秒', '◉ メイン', '╰────────● #2 Explore·haiku-5-5『調べる2』'])
  expect(at(FLIGHT_MS - 1)[0]).toBe('╭◂───────✓ #1 Explore·haiku-5-5『調べる1』 12秒')
  expect(at(FLIGHT_MS)[0]).toBe('╭────────✓ #1 Explore·haiku-5-5『調べる1』 12秒')
})

test('メインがツールを使っているときは、中心の点が光り、そのツールを添える', () => {
  const list = [...twoAgents(), entry('m1', '`a.ts` を編集', T0 + 300, { status: 'running' })]
  const hub = (now: number) => layoutMap(list, running, '', now, 30)[2]

  expect(draw([hub(T0 + 8_000)!])).toEqual(['◉ メイン  `a.ts` を編集'])
  expect(draw([hub(T0 + 8_400)!])).toEqual(['◎ メイン  `a.ts` を編集'])
  expect(hub(T0 + 8_000)?.segs[0]?.tone).toBe('hub')
})

test('サブエージェントが起動したサブエージェントは、親の外側に一段ずらして置く', () => {
  const agents = {
    'agent-1': agent(1),
    'agent-2': agent(2),
    'agent-3': agent(3, { parentId: 'agent-1', type: 'Plan', model: '' }),
    'agent-4': agent(4, { parentId: 'agent-2', type: 'Plan', model: '' }),
  }
  const lines = draw(layoutMap(twoAgents(), agents, '', T0 + 8_000, 30))

  expect(lines).toEqual([
    '         ╭────● #3 Plan『調べる3』',
    '╭────────● #1 Explore·haiku-5-5『調べる1』',
    '│           「TODO」を検索',
    '◉ メイン',
    '╰────────● #2 Explore·haiku-5-5『調べる2』',
    '         ╰────● #4 Plan『調べる4』',
  ])
})

test('入りきらなければ、終えたものを古い順に省き、次に今のツールの行を省く', () => {
  const agents: Record<string, WorkLogAgent> = {}
  const list: WorkLogEntry[] = []
  for (let no = 1; no <= 8; no += 1) {
    agents[`agent-${no}`] = agent(no, no <= 3 ? { status: 'ok', durationMs: 1000, endedAt: T0 + 100 } : {})
    list.push(entry(`call-${no}`, '起動', T0))
    if (no > 3) list.push(entry(`w${no}`, '作業', T0, { agentId: `agent-${no}`, status: 'running' }))
  }

  // 実行中5体(各2行)+中心+省いた目印 = 12 行。終えた3体を省けば入る
  const fit = draw(layoutMap(list, agents, '', T0 + 8_000, 12))
  expect(fit.length).toBe(12)
  expect(fit.some(line => line.includes('#3'))).toBe(false)
  expect(fit.at(-1)).toBe('  ほか 3 体を省いた')

  // さらに狭ければ今のツールの行も省き、それでも入らなければ新しいものから省く
  const narrow = draw(layoutMap(list, agents, '', T0 + 8_000, 6))
  expect(narrow.length).toBe(6)
  expect(narrow.some(line => line.includes('作業'))).toBe(false)
  expect(narrow.filter(line => line.includes('#')).map(line => /#\d/.exec(line)?.[0])).toEqual(['#6', '#4', '#5', '#7'])
  expect(narrow.at(-1)).toBe('  ほか 4 体を省いた')
})

test('前のターンに終えたサブエージェントは置かず、何もいなければそう出す', () => {
  const done = { 'agent-1': agent(1, { status: 'ok', durationMs: 1000, endedAt: T0 + 500 }) }
  const list = [
    entry('call-1', '起動', T0),
    entry('turn:t1', '回答した(2秒)', T0 + 1000, { kind: 'turn' }),
    entry('r1', '`a.ts` を読む', T0 + 2000),
  ]

  expect(draw(layoutMap(list, done, '', T0 + 3000, 30))).toEqual(['◉ メイン', '  サブエージェントは動いていません'])
  // ターンを終えた直後はまだ置いておく
  expect(draw(layoutMap(list.slice(0, 2), done, '', T0 + 5000, 30))).toEqual([
    '╭────────✓ #1 Explore·haiku-5-5『調べる1』 1秒',
    '◉ メイン ✓ 回答した(2秒)',
  ])
})

test('動いているものが無いときだけ、アニメーションは止まっている', () => {
  expect(isMapAnimating(twoAgents(), running, T0 + 8_000)).toBe(true)

  const done = { 'agent-1': agent(1, { status: 'ok', endedAt: T0 + 5000 }) }
  const list = [entry('call-1', '起動', T0)]
  // 結果の粒が流れているあいだは動いている
  expect(isMapAnimating(list, done, T0 + 5000 + FLIGHT_MS - 1)).toBe(true)
  expect(isMapAnimating(list, done, T0 + 5000 + FLIGHT_MS)).toBe(false)
  // メインがツールを使っているあいだも動いている
  expect(isMapAnimating([...list, entry('m', '検索', T0, { status: 'running' })], done, T0 + 60_000)).toBe(true)
})
