import { expect, test } from 'claude-code/testing'

import type { WorkLogAgent, WorkLogEntry } from '../types'
import { FLASH_MS, FLIGHT_MS, TICK_MS, isMapAnimating } from './map'

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
