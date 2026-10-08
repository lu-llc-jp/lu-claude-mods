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

test('文字幅は日本語を2マスと数え、はみ出すぶんは … にする', () => {
  expect(cellWidth('ab調べる')).toBe(8)
  expect(fit('テストを調べる', 9)).toBe('テストを…')
  expect(fit('abc', 3)).toBe('abc')
})

test('メインを枠のカードにして上に置き、その下の幹からサブエージェントを起動順に吊るす', () => {
  const lines = still(draw(layoutMap(twoAgents(), running, 'claude-opus-5-5', LATER, 30, 40)))

  expect(lines).toEqual([
    '╭─ ◉ メイン ──────────────── opus-5-5 ─╮',
    '│ … 考えています                       │',
    '│ * 2 動作中  ✓ 0 完了                 │',
    '╰──┬───────────────────────────────────╯',
    '   │',
    '   ├─────* #1 Explore  調べる1       9秒',
    '   │       「TODO」を検索',
    '   │',
    '   ╰─────* #2 Explore  調べる2       9秒',
  ])
  // 幅があれば、メインと違うモデルを種類に添える。狭ければ名前を優先してモデルを外す
  expect(draw(layoutMap(twoAgents(), running, 'claude-opus-5-5', LATER, 30, 60))[5]).toMatch(/#1 Explore·haiku-5-5 {2}調べる1 +9秒$/)
  // カードの4行も名前の行も、ちょうど幅いっぱいに収まる
  for (const i of [0, 1, 2, 3, 5]) expect(cellWidth(lines[i] ?? '')).toBe(40)
})

test('経過時間を右端にそろえて数え、終えたら所要時間にする', () => {
  const at = (now: number, agents: Record<string, WorkLogAgent>) =>
    draw(layoutMap(twoAgents(), agents, 'claude-haiku-5-5', now, 30, 40))

  // メインと同じモデルなら書かない
  expect(at(T0 + 3_000, running)[5]).toMatch(/#1 Explore {2}調べる1 +3秒$/)
  expect(cellWidth(at(T0 + 3_000, running)[5] ?? '')).toBe(40)
  const done = { ...running, 'agent-2': agent(2, { status: 'ok', durationMs: 4_000, endedAt: T0 + 4_000 }) }
  expect(at(T0 + 20_000, done)[8]).toMatch(/╰─────✓ #2 Explore {2}調べる2 +4秒$/)
})

test('実行中の点はスピナーで回り、道筋には光が外へ流れる', () => {
  const spins = [0, 1, 2].map(i => draw(layoutMap(twoAgents(), running, '', LATER + i * TICK_MS, 30, 40))[5]?.at(9))
  expect(new Set(spins).size).toBe(3)

  const lit = (now: number) =>
    layoutMap(twoAgents(), running, '', now, 30, 40)
      .map(line => line.segs.findIndex(seg => seg.tone === 'live'))
      .join(',')
  // 光は1コマごとに位置を変える
  expect(lit(LATER)).not.toBe(lit(LATER + TICK_MS))
})

test('起動したては、依頼の粒がメインから点へ流れ、名前を打ち出していく', () => {
  const at = (ms: number) => layoutMap(twoAgents(), running, '', T0 + ms, 30, 40)

  // 粒は幹の上から出て、点の手前に着く
  expect(draw(at(0))[4]).toBe('   ●')
  expect(draw(at(FLIGHT_MS - 1))[5]).toMatch(/^ {3}├─*●[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] #1/)
  expect(toned(at(FLIGHT_MS), 'flow')).toEqual([])
  // 尾を引く
  expect(toned(at(FLIGHT_MS / 2), 'flowTrail').length).toBeGreaterThan(0)

  expect(draw(at(TYPE_MS / 2))[5]).toMatch(/調べ▍ +0秒$/)
  expect(draw(at(TYPE_MS))[5]).toMatch(/調べる1 +\d+秒$/)
})

test('終えると ✓ になり、結果の粒がメインへ戻って、届くとカードが光る', () => {
  const end = T0 + 12_000
  const done = { ...running, 'agent-1': agent(1, { status: 'ok', durationMs: 12_000, endedAt: end }) }
  const list = twoAgents().map(one => (one.id === 'a1' ? { ...one, status: 'ok' as const } : one))
  const at = (ms: number) => layoutMap(list, done, '', end + ms, 30, 40)

  // 今のツールの行は消え、結果の粒が点の手前から戻り始める
  expect(draw(at(0))[5]).toMatch(/^ {3}├────◆✓ #1/)
  expect(draw(at(FLIGHT_MS - 1))[4]).toBe('   ◆')
  expect(toned(at(FLIGHT_MS - 1), 'hubFlash')).toEqual([])
  // 届くとカードの枠が光り、しばらくして戻る
  expect(toned(at(FLIGHT_MS), 'hubFlash').length).toBeGreaterThan(0)
  expect(toned(at(FLIGHT_MS), 'back')).toEqual([])
  expect(toned(at(FLIGHT_MS + FLASH_MS), 'hubFlash')).toEqual([])
  expect(draw(at(FLIGHT_MS))[2]).toMatch(/1 動作中 {2}✓ 1 完了/)
})

test('メインがツールを使っているときは、カードにスピナーとそのツールを出す', () => {
  const list = [...twoAgents(), entry('m1', '`a.ts` を編集', T0 + 300, { status: 'running' })]
  const card = layoutMap(list, running, '', LATER, 30, 40)

  expect(still(draw(card))[1]).toBe('│ * `a.ts` を編集                      │')
  expect(card[0]?.segs[0]?.tone).toBe('hub')
})

test('サブエージェントが起動したサブエージェントは、親の点から下ろした枝に一段ずらして吊るす', () => {
  const agents = {
    'agent-1': agent(1),
    'agent-2': agent(2),
    'agent-3': agent(3, { parentId: 'agent-1', type: 'Plan', model: '' }),
  }
  const lines = still(draw(layoutMap(twoAgents(), agents, 'claude-haiku-5-5', LATER, 30, 40)))

  expect(lines.slice(4)).toEqual([
    '   │',
    '   ├─────* #1 Explore  調べる1       9秒',
    '   │     │ 「TODO」を検索',
    '   │     ╰───* #3 Plan  調べる3      9秒',
    '   │',
    '   ╰─────* #2 Explore  調べる2       9秒',
  ])
})

test('入りきらなければ、空き行、終えたもの(古い順)、今のツールの行、新しいもの、の順に省く', () => {
  const agents: Record<string, WorkLogAgent> = {}
  const list: WorkLogEntry[] = []
  for (let no = 1; no <= 8; no += 1) {
    agents[`agent-${no}`] = agent(no, no <= 3 ? { status: 'ok', durationMs: 1000, endedAt: T0 + 100 } : {})
    list.push(entry(`call-${no}`, '起動', T0))
    if (no > 3) list.push(entry(`w${no}`, '作業', T0, { agentId: `agent-${no}`, status: 'running' }))
  }
  const at = (rows: number) => draw(layoutMap(list, agents, '', LATER, rows, 40))

  // カード4行+あいだ1行+実行中5体(各2行)+省いた目印 = 16 行。空き行を詰め、終えた3体を省けば入る
  const fit16 = at(16)
  expect(fit16.length).toBe(16)
  expect(fit16.some(line => line.includes('#3'))).toBe(false)
  expect(fit16.filter(line => line.includes('作業')).length).toBe(5)
  expect(fit16.at(-1)).toBe('   ほか 3 体を省いた')

  // さらに狭ければ今のツールの行も省き、それでも入らなければ新しいものから省く
  const narrow = at(10)
  expect(narrow.length).toBe(10)
  expect(narrow.some(line => line.includes('作業'))).toBe(false)
  expect(narrow.filter(line => line.includes('#')).map(line => /#\d/.exec(line)?.[0])).toEqual(['#4', '#5', '#6', '#7'])
  expect(narrow.at(-1)).toBe('   ほか 4 体を省いた')
})

test('終えたものは、ターンが進んでも RECENT_MS のあいだ残し、何もいなければそう出す', () => {
  const done = { 'agent-1': agent(1, { status: 'ok', durationMs: 1000, endedAt: T0 + 500 }) }
  const list = [
    entry('call-1', '起動', T0),
    entry('turn:t1', '回答した(2秒)', T0 + 1000, { kind: 'turn' }),
    entry('r1', '`a.ts` を読む', T0 + 2000),
  ]

  expect(draw(layoutMap(list, done, '', T0 + 60_000, 30, 40)).some(line => /✓ #1/.test(line))).toBe(true)
  const gone = draw(layoutMap(list, done, '', T0 + 500 + RECENT_MS, 30, 40))
  expect(gone).toHaveLength(4)
  expect(gone[2]).toMatch(/サブエージェントはいません/)
  expect(gone[3]).toMatch(/^╰─+╯$/)
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

test('avatar を渡すと、メインのカードをその幅だけ狭め、◉ と幹の付け根を外す(キャラを左に置くため)', () => {
  const lines = draw(layoutMap(twoAgents(), running, 'claude-opus-5-5', LATER, 30, 40, 10))

  expect(lines[0]).toMatch(/^╭─ メイン ─+ opus-5-5 ─╮$/)
  expect(lines.slice(0, 4).every(line => cellWidth(line) === 30)).toBe(true)
  expect(lines[3]).toMatch(/^╰─+╯$/)
  // 幹はキャラの下から下ろす
  expect(lines[4]).toBe('   │')
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
