import { expect, test } from 'claude-code/testing'

import type { WorkLogAgent, WorkLogEntry } from '../types'
import { CARD_ROWS, layoutCards, type Card } from './cards'
import { FLASH_MS, FLIGHT_MS, RECENT_MS, TICK_MS, TYPE_MS, type MapSeg } from './map'

const T0 = 1_000_000
/** 起動から十分たち、粒も打ち出しも終わっている時刻 */
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

/** メインが2つのサブエージェントを起動し、#1 は「TODO」を検索中 */
const twoAgents = (): WorkLogEntry[] => [
  entry('call-1', '起動', T0, { status: 'running' }),
  entry('call-2', '起動', T0, { status: 'running' }),
  entry('a1', '「TODO」を検索', T0 + 100, { agentId: 'agent-1', status: 'running' }),
]
const running = { 'agent-1': agent(1), 'agent-2': agent(2) }

const plain = (segs: readonly MapSeg[]): string => segs.map(seg => seg.text).join('')
const gutter = (card: Card | undefined): string[] => (card?.gutter ?? []).map(plain)
const still = (text: string): string => text.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '*')

test('メインのカードに、今していることとサブエージェントの数を出す', () => {
  const list = [...twoAgents(), entry('m1', '`a.ts` を編集', T0 + 300, { status: 'running' })]
  const { main } = layoutCards(list, running, 'claude-opus-5-5', LATER, 40)

  expect(plain(main.title)).toBe('メイン · opus-5-5')
  expect(still(plain(main.name))).toBe('* `a.ts` を編集')
  expect(still(plain(main.activity))).toBe('* 2 動作中  ✓ 0 完了')
  expect(main.tone).toBe('live')
  expect(main.sprite.kind).toBe('main')
  expect([main.sprite.raster.columns, main.sprite.raster.rows]).toEqual([8, 3])
})

test('サブエージェントのカードに、何者か・何を頼まれたか・今何をしているかを出す', () => {
  const { cards } = layoutCards(twoAgents(), running, 'claude-opus-5-5', LATER, 40)
  const [first, second] = cards

  // メインと違うモデルだけ添える
  expect(plain(first?.title ?? [])).toBe('#1 Explore · haiku-5-5')
  expect(plain(layoutCards(twoAgents(), running, 'claude-haiku-5-5', LATER, 40).cards[0]?.title ?? [])).toBe('#1 Explore')
  expect(first?.time?.text).toBe('9秒')
  expect(plain(first?.name ?? [])).toBe('調べる1')
  expect(still(plain(first?.activity ?? []))).toBe('* 「TODO」を検索')
  expect(still(plain(second?.activity ?? []))).toBe('* 考えています')
  expect(first?.sprite.kind).toBe('explore')
  expect([first?.sprite.raster.columns, first?.sprite.raster.rows]).toEqual([6, 3])
})

test('カードの左にツリーの線を引き、真ん中の行で枠につなぐ', () => {
  const agents = {
    'agent-1': agent(1),
    'agent-2': agent(2),
    'agent-3': agent(3, { parentId: 'agent-1', type: 'Plan' }),
  }
  // 粒も光も無い時刻にそろえるため、終えた形で比べる
  const quiet = Object.fromEntries(
    Object.entries(agents).map(([id, one]) => [id, { ...one, status: 'ok' as const, endedAt: T0 + 1000, durationMs: 1000 }]),
  )
  const { cards } = layoutCards([], quiet, '', LATER, 40)

  expect(cards.map(card => card.key)).toEqual(['agent-1', 'agent-3', 'agent-2'])
  expect(cards.map(card => card.depth)).toEqual([0, 1, 0])
  expect(gutter(cards[0])).toEqual([' │ ', ' │ ', ' ├─', ' │ ', ' │ '])
  // 入れ子は1段右へずれ、親の段の線は、親の兄弟(#2)がまだ下にあるので通す
  expect(gutter(cards[1])).toEqual([' │  │ ', ' │  │ ', ' │  ╰─', ' │    ', ' │    '])
  expect(gutter(cards[2])).toEqual([' │ ', ' │ ', ' ╰─', '   ', '   '])
  expect(cards.every(card => card.gutter.length === CARD_ROWS)).toBe(true)
})

test('起動したては依頼の粒が線を下り、説明を打ち出す。終えたら結果の粒が戻り、枠が光る', () => {
  const at = (now: number, agents: Record<string, WorkLogAgent>) => layoutCards(twoAgents(), agents, '', now, 40).cards[0]

  expect(gutter(at(T0, running))[0]).toBe(' ● ')
  expect(gutter(at(T0 + FLIGHT_MS - 1, running))[2]).toBe(' ├●')
  expect(plain(at(T0 + TYPE_MS / 2, running)?.name ?? [])).toBe('調べ▍')

  const end = T0 + 12_000
  const done = { ...running, 'agent-1': agent(1, { status: 'ok', durationMs: 12_000, endedAt: end }) }
  expect(gutter(at(end, done))[2]).toBe(' ├◆')
  expect(gutter(at(end + FLIGHT_MS - 1, done))[0]).toBe(' ◆ ')
  expect(at(end, done)?.tone).toBe('flash')
  expect(at(end + FLASH_MS, done)?.tone).toBe('done')
  expect(plain(at(end + FLASH_MS, done)?.activity ?? [])).toBe('✓ 回答した')
  expect(at(end + FLASH_MS, done)?.time?.text).toBe('12秒')

  // 結果がメインに届くと、メインのカードが光る
  const main = (now: number) => layoutCards(twoAgents(), done, '', now, 40).main
  expect(main(end + FLIGHT_MS).tone).toBe('flash')
  expect(main(end + FLIGHT_MS + FLASH_MS).tone).toBe('live')
})

test('入りきらなければ、終えたもの(古い順)、新しいもの、の順に省く', () => {
  const agents: Record<string, WorkLogAgent> = {}
  for (let no = 1; no <= 5; no += 1) {
    agents[`agent-${no}`] = agent(no, no <= 2 ? { status: 'ok', durationMs: 1000, endedAt: T0 + 100 } : {})
  }
  const nos = (rows: number) => layoutCards([], agents, '', LATER, rows).cards.map(card => card.key)

  // メイン + 3枚 + 省いた目印 = 21 行
  expect(nos(21)).toEqual(['agent-3', 'agent-4', 'agent-5'])
  expect(layoutCards([], agents, '', LATER, 21).omitted).toBe(2)
  expect(nos(16)).toEqual(['agent-3', 'agent-4'])
})

test('終えたものは、ターンが進んでも RECENT_MS のあいだ残す', () => {
  const done = { 'agent-1': agent(1, { status: 'ok', durationMs: 1000, endedAt: T0 + 500 }) }
  const list = [entry('call-1', '起動', T0), entry('turn:t1', '回答した(2秒)', T0 + 1000, { kind: 'turn' })]

  expect(layoutCards(list, done, '', T0 + 60_000, 40).cards).toHaveLength(1)
  const gone = layoutCards(list, done, '', T0 + 500 + RECENT_MS, 40)
  expect(gone.cards).toHaveLength(0)
  expect(plain(gone.main.activity)).toBe('サブエージェントはいません')
})
