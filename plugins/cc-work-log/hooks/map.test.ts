import { expect, test } from 'claude-code/testing'

import type { WorkLogAgent, WorkLogEntry } from '../types'
import { FLASH_MS, FLIGHT_MS, TICK_MS, cellWidth, fit, formatTokens, isMapAnimating, layoutMap, mainMood, type MapLine } from './map'

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
const plain = (segs: readonly { text: string }[] | undefined): string => (segs ?? []).map(seg => seg.text).join('')
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
    '│                                      │',
    '╰───────────────────┬──────────────────╯',
    '          ╭─────────┴─────────╮',
    '          │                   │',
    ' ╭────────┴────────╮ ╭────────┴────────╮',
    ' │ #1 Explore      │ │ #2 Explore      │',
    ' │ haiku-5-5       │ │ haiku-5-5       │',
    ' │ * 9秒           │ │ * 9秒           │',
    ' ╰─────────────────╯ ╰─────────────────╯',
  ])
  // 箱の1行目(番号と種類)は押せる。押すとそのエージェントの詳細を開く
  const title = layoutMap(twoAgents(), running, '', LATER, 30, 40)[8]
  expect(title?.segs.filter(seg => seg.press !== undefined).map(seg => [seg.text, seg.press])).toEqual([
    ['#1 ', 'agent-1'],
    ['Explore', 'agent-1'],
    ['#2 ', 'agent-2'],
    ['Explore', 'agent-2'],
  ])
})

test('サブエージェントが起動したものは、親の箱の下に並べる', () => {
  const agents = {
    'agent-1': agent(1),
    'agent-2': agent(2),
    'agent-3': agent(3, { parentId: 'agent-1', type: 'Plan', model: '' }),
    'agent-4': agent(4, { parentId: 'agent-1', type: 'Plan', model: '' }),
  }
  expect(still(draw(layoutMap(twoAgents(), agents, 'claude-haiku-5-5', LATER, 40, 60))).slice(5)).toEqual([
    '                    ╭─────────┴───────────────────╮',
    '                    │                             │',
    '           ╭────────┴────────╮           ╭────────┴────────╮',
    '           │ #1 Explore      │           │ #2 Explore      │',
    '           │ haiku-5-5       │           │ haiku-5-5       │',
    '           │ * 9秒           │           │ * 9秒           │',
    '           ╰────────┬────────╯           ╰─────────────────╯',
    '          ╭─────────┴─────────╮',
    '          │                   │',
    ' ╭────────┴────────╮ ╭────────┴────────╮',
    ' │ #3 Plan         │ │ #4 Plan         │',
    ' │ モデル不明      │ │ モデル不明      │',
    ' │ * 9秒           │ │ * 9秒           │',
    ' ╰─────────────────╯ ╰─────────────────╯',
  ])
})

test('起動したては、依頼の粒が親から子の箱へ流れる', () => {
  const at = (ms: number) => layoutMap(twoAgents(), running, '', T0 + ms, 30, 40)

  // 粒はメインの付け根の下から出て、横に分かれ、子の箱の上へ下りる
  expect(draw(at(0))[5]?.indexOf('●')).toBe(20)
  expect(draw(at(FLIGHT_MS - 1))[6]).toMatch(/●/)
  expect(toned(at(FLIGHT_MS), 'flow')).toEqual([])
  expect(toned(at(FLIGHT_MS / 2), 'flowTrail').length).toBeGreaterThan(0)
})

test('実行中の線には光が流れ、終えると箱が ✓ になって、結果の粒が親へ戻り、届くとカードが光る', () => {
  const lit = (now: number) => toned(layoutMap(twoAgents(), running, '', now, 30, 40), 'live').length
  expect(lit(LATER)).toBeGreaterThan(0)

  const end = T0 + 12_000
  const done = { ...running, 'agent-1': agent(1, { status: 'ok', durationMs: 12_000, endedAt: end, tokens: 12_345 }) }
  const list = twoAgents().map(one => (one.id === 'a1' ? { ...one, status: 'ok' as const } : one))
  const at = (ms: number) => layoutMap(list, done, '', end + ms, 30, 40)

  // 様子は ✓ と所要時間、消費トークンは下の枠、メインのカードにはその合計
  expect(draw(at(0))[10]).toMatch(/^ │ ✓ 12秒 +│/)
  expect(draw(at(0))[11]).toMatch(/^ ╰─+ 12\.3k tok ─╯/)
  expect(draw(at(0))[3]).toMatch(/サブエージェントのトークン 12\.3k/)
  // 終えた瞬間は箱の枠が光る
  expect(at(0)[7]?.segs.some(seg => seg.tone === 'hubFlash')).toBe(true)
  // 結果の粒は、子の箱の上から出て、メインの付け根へ戻る
  expect(draw(at(0))[6]).toMatch(/◆/)
  expect(draw(at(FLIGHT_MS - 1))[5]?.indexOf('◆')).toBe(20)
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

test('置くのは直近の依頼より後に起動したものと、まだ実行中のもの。次の依頼までは、終えたものも残す', () => {
  const agents = {
    'agent-1': agent(1, { status: 'ok', durationMs: 1000, startedAt: T0, endedAt: T0 + 1000 }),
    'agent-2': agent(2, { startedAt: T0 }),
    'agent-3': agent(3, { status: 'ok', durationMs: 1000, startedAt: T0 + 5000, endedAt: T0 + 6000 }),
  }
  const nos = (since: number | null, now: number) =>
    draw(layoutMap([], agents, '', now, 30, 72, { since })).flatMap(line => [...line.matchAll(/#(\d)/g)].map(m => m[1]))

  // 依頼(T0 + 3000)の前に終えた #1 は消え、前に起動してまだ動いている #2 は残る
  expect(nos(T0 + 3000, T0 + 60_000)).toEqual(['2', '3'])
  // 依頼がまだ無ければ、覚えているものをすべて置く
  expect(nos(null, T0 + 60_000)).toEqual(['1', '2', '3'])
  // 何もいなければ、メインのカードだけ
  const empty = draw(layoutMap([], {}, '', T0, 30, 40))
  expect(empty).toHaveLength(5)
  expect(empty[2]).toMatch(/サブエージェントはいません/)
})

test('avatar を渡すと、メインのカードの中の左にキャラの隙間を空け、隙間の左右を分けて持たせる', () => {
  const lines = layoutMap(twoAgents(), running, 'claude-opus-5-5', LATER, 40, 40, { avatar: 9 })
  const text = draw(lines)

  expect(text[0]).toMatch(/^╭─ メイン ─+ opus-5-5 ─╮$/)
  const inside = lines.filter(line => line.key.startsWith('hub:in:'))
  expect(inside).toHaveLength(4)
  expect(inside.map(line => plain(line.left))).toEqual(['│ ', '│ ', '│ ', '│ '])
  expect(still(inside.map(line => plain(line.right).trimEnd()))).toEqual([
    ' … 考えています             │',
    ' * 2 動作中  ✓ 0 完了       │',
    '                            │',
    '                            │',
  ])
  expect(text.slice(0, 6).every(line => cellWidth(line) === 40)).toBe(true)
  // 付け根はカードの真ん中
  expect(text[5]?.indexOf('┬')).toBe(20)
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

test('消費トークンは、850・12.3k・1.2M のように短く書く', () => {
  expect([formatTokens(850), formatTokens(12_345), formatTokens(1_234_567)]).toEqual(['850', '12.3k', '1.2M'])
})
