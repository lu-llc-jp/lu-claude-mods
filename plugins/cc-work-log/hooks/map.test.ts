import { expect, test } from 'claude-code/testing'

import type { WorkLogAgent, WorkLogEntry } from '../types'
import { FLASH_MS, FLIGHT_MS, RECENT_MS, TICK_MS, TYPE_MS, cellWidth, fit, isMapAnimating, layoutMap, mainMood, type MapLine } from './map'

const T0 = 1_000_000
/** 起動から十分たち、粒も打ち出しも終わっている時刻。光の位置がそろうよう TICK_MS の倍数にする */
const LATER = T0 + 60 * TICK_MS

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
/** スピナーのコマを * にそろえる */
const still = (lines: readonly string[]): string[] => lines.map(line => line.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '*'))
/** その色の区切りの文字を集める */
const toned = (lines: readonly MapLine[], tone: string): string[] =>
  lines.flatMap(line => line.segs.filter(seg => seg.tone === tone).map(seg => seg.text))

test('組織図のように、メインのカードの下に子の箱を横に並べ、線で分けてつなぐ', () => {
  const lines = still(draw(layoutMap(twoAgents(), running, 'claude-opus-5-5', LATER, 30, 40)))

  expect(lines).toEqual([
    '╭─ ◉ メイン ──────────────── opus-5-5 ─╮',
    '│ … 考えています                       │',
    '│ * 2 動作中  ✓ 0 完了                 │',
    '╰───────────────────┬──────────────────╯',
    '          ╭─────────┴─────────╮',
    '          │                   │',
    ' ╭────────┴────────╮ ╭────────┴────────╮',
    ' │ #1 Explore      │ │ #2 Explore      │',
    ' │ 調べる1         │ │ 調べる2         │',
    ' │ * 「TODO」を検… │ │ * 考えています  │',
    ' ╰─────────── 9秒 ─╯ ╰─────────── 9秒 ─╯',
  ])
  // 箱の1行目には、メインと違うモデルを入るときだけ添える
  const wide = draw(layoutMap(twoAgents(), running, 'claude-opus-5-5', LATER, 30, 60))
  expect(wide.some(line => line.includes('#1 Explore·haiku-5-5'))).toBe(true)
})

test('サブエージェントが起動したものは、親の箱の下に並べる', () => {
  const agents = {
    'agent-1': agent(1),
    'agent-2': agent(2),
    'agent-3': agent(3, { parentId: 'agent-1', type: 'Plan', model: '' }),
    'agent-4': agent(4, { parentId: 'agent-1', type: 'Plan', model: '' }),
  }
  expect(still(draw(layoutMap(twoAgents(), agents, 'claude-haiku-5-5', LATER, 40, 60))).slice(4)).toEqual([
    '                    ╭─────────┴───────────────────╮',
    '                    │                             │',
    '           ╭────────┴────────╮           ╭────────┴────────╮',
    '           │ #1 Explore      │           │ #2 Explore      │',
    '           │ 調べる1         │           │ 調べる2         │',
    '           │ * 「TODO」を検… │           │ * 考えています  │',
    '           ╰────────┬── 9秒 ─╯           ╰─────────── 9秒 ─╯',
    '          ╭─────────┴─────────╮',
    '          │                   │',
    ' ╭────────┴────────╮ ╭────────┴────────╮',
    ' │ #3 Plan         │ │ #4 Plan         │',
    ' │ 調べる3         │ │ 調べる4         │',
    ' │ * 考えています  │ │ * 考えています  │',
    ' ╰─────────── 9秒 ─╯ ╰─────────── 9秒 ─╯',
  ])
})

test('起動したては、依頼の粒が親から子の箱へ流れ、説明を打ち出していく', () => {
  const at = (ms: number) => layoutMap(twoAgents(), running, '', T0 + ms, 30, 40)

  // 粒はメインの付け根の下から出て、横に分かれ、子の箱の上へ下りる
  expect(draw(at(0))[4]?.indexOf('●')).toBe(20)
  expect(draw(at(FLIGHT_MS - 1))[5]).toMatch(/●/)
  expect(toned(at(FLIGHT_MS), 'flow')).toEqual([])
  expect(toned(at(FLIGHT_MS / 2), 'flowTrail').length).toBeGreaterThan(0)
  expect(draw(at(TYPE_MS / 2))[8]).toMatch(/│ 調べ▍ +│/)
})

test('実行中の線には光が流れ、終えると箱が ✓ になって、結果の粒が親へ戻り、届くとカードが光る', () => {
  const lit = (now: number) => toned(layoutMap(twoAgents(), running, '', now, 30, 40), 'live').length
  expect(lit(LATER)).toBeGreaterThan(0)

  const end = T0 + 12_000
  const done = { ...running, 'agent-1': agent(1, { status: 'ok', durationMs: 12_000, endedAt: end }) }
  const list = twoAgents().map(one => (one.id === 'a1' ? { ...one, status: 'ok' as const } : one))
  const at = (ms: number) => layoutMap(list, done, '', end + ms, 30, 40)

  expect(draw(at(0))[9]).toMatch(/│ ✓ 回答した +│/)
  expect(draw(at(0))[10]).toMatch(/12秒/)
  // 終えた瞬間は箱の枠が光る
  expect(at(0)[6]?.segs.some(seg => seg.tone === 'hubFlash')).toBe(true)
  // 結果の粒は、子の箱の上から出て、メインの付け根へ戻る
  expect(draw(at(0))[5]).toMatch(/◆/)
  expect(draw(at(FLIGHT_MS - 1))[4]?.indexOf('◆')).toBe(20)
  // 届くとメインのカードが光り、しばらくして戻る
  expect(at(FLIGHT_MS)[0]?.segs[0]?.tone).toBe('hubFlash')
  expect(at(FLIGHT_MS + FLASH_MS)[0]?.segs[0]?.tone).toBe('hub')
})

test('メインがツールを使っているときは、カードにスピナーとそのツールを出す', () => {
  const list = [...twoAgents(), entry('m1', '`a.ts` を編集', T0 + 300, { status: 'running' })]
  const card = layoutMap(list, running, '', LATER, 30, 40)

  expect(still(draw(card))[1]).toBe('│ * `a.ts` を編集                      │')
  expect(card[0]?.segs[0]?.tone).toBe('hub')
})

test('横か縦に入りきらなければ、終えたもの(古い順)、新しいもの、の順に省く', () => {
  const agents: Record<string, WorkLogAgent> = {}
  for (let no = 1; no <= 5; no += 1) {
    agents[`agent-${no}`] = agent(no, no <= 2 ? { status: 'ok', durationMs: 1000, endedAt: T0 + 100 } : {})
  }
  const nos = (columns: number) =>
    draw(layoutMap([], agents, '', LATER, 30, columns)).flatMap(line => [...line.matchAll(/#(\d)/g)].map(m => m[1]))

  // 40 マスには、14 マスの箱が2つまで
  expect(nos(40)).toEqual(['3', '4'])
  expect(draw(layoutMap([], agents, '', LATER, 30, 40)).at(-1)).toBe('ほか 3 体を省いた')
  // 60 マスなら4つ。終えたものから省く
  expect(nos(60)).toEqual(['2', '3', '4', '5'])
  // 縦に入らなければ、入れ子の段ごと省く
  const nested = { ...agents, 'agent-6': agent(6, { parentId: 'agent-3' }) }
  expect(draw(layoutMap([], nested, '', LATER, 12, 72)).some(line => line.includes('#6'))).toBe(false)
})

test('終えたものは、ターンが進んでも RECENT_MS のあいだ残し、何もいなければカードだけ出す', () => {
  const done = { 'agent-1': agent(1, { status: 'ok', durationMs: 1000, endedAt: T0 + 500 }) }
  const list = [
    entry('call-1', '起動', T0),
    entry('turn:t1', '回答した(2秒)', T0 + 1000, { kind: 'turn' }),
    entry('r1', '`a.ts` を読む', T0 + 2000),
  ]

  expect(draw(layoutMap(list, done, '', T0 + 60_000, 30, 40)).some(line => line.includes('#1 Explore'))).toBe(true)
  const gone = draw(layoutMap(list, done, '', T0 + 500 + RECENT_MS, 30, 40))
  expect(gone).toHaveLength(4)
  expect(gone[2]).toMatch(/サブエージェントはいません/)
  expect(gone[3]).toMatch(/^╰─+╯$/)
})

test('avatar を渡すと、メインのカードをその幅だけ狭めて ◉ を外し、付け根はカードの真ん中に付ける', () => {
  const lines = draw(layoutMap(twoAgents(), running, 'claude-opus-5-5', LATER, 30, 40, 10))

  expect(lines[0]).toMatch(/^╭─ メイン ─+ opus-5-5 ─╮$/)
  expect(lines.slice(0, 4).every(line => cellWidth(line) === 30)).toBe(true)
  // カードは描く側が 10 列ずらして置くので、付け根はカードの中の 15 列目、線は全体の 25 列目から下りる
  expect(lines[3]?.indexOf('┬')).toBe(15)
  expect([...(lines[4] ?? '')].indexOf('┴')).toBe(25)
})

test('文字幅は日本語を2マスと数え、はみ出すぶんは … にする', () => {
  expect(cellWidth('ab調べる')).toBe(8)
  expect(fit('テストを調べる', 9)).toBe('テストを…')
  expect(fit('abc', 3)).toBe('abc')
})

test('動いているものが無いときだけ、アニメーションは止まっている', () => {
  expect(isMapAnimating(twoAgents(), running, LATER)).toBe(true)

  const done = { 'agent-1': agent(1, { status: 'ok', endedAt: T0 + 5000 }) }
  const list = [entry('call-1', '起動', T0)]
  // 結果の粒が流れ、カードが光っているあいだは動いている
  expect(isMapAnimating(list, done, T0 + 5000 + FLIGHT_MS + FLASH_MS - 1)).toBe(true)
  expect(isMapAnimating(list, done, T0 + 5000 + FLIGHT_MS + FLASH_MS)).toBe(false)
  // メインがツールを使っているあいだも動いている
  expect(isMapAnimating([...list, entry('m', '検索', T0, { status: 'running' })], done, T0 + 60_000)).toBe(true)
})

test('メインのキャラの様子は、結果が届いた・ツールを使っている・考えている・終えた、の順に決まる', () => {
  expect(mainMood(twoAgents(), running, LATER)).toBe('thinking')
  expect(mainMood([...twoAgents(), entry('m1', '検索', T0, { status: 'running' })], running, LATER)).toBe('busy')
  const end = T0 + 12_000
  const done = { ...running, 'agent-1': agent(1, { status: 'ok', durationMs: 12_000, endedAt: end }) }
  expect(mainMood(twoAgents(), done, end + FLIGHT_MS)).toBe('flash')
  const finished = [...twoAgents(), entry('turn:t1', '回答した(2秒)', T0 + 1000, { kind: 'turn', status: 'ok' })]
  expect(mainMood(finished, {}, LATER)).toBe('done')
})
