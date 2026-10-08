import { expect, test } from 'claude-code/testing'

import type { WorkLogAgent, WorkLogEntry } from '../types'
import { layoutTree, type TreeLine } from './tree'

let clock = 0
const entry = (id: string, text: string, more: Partial<WorkLogEntry> = {}): WorkLogEntry => ({
  id,
  kind: 'tool',
  text,
  at: (clock += 1000),
  status: 'ok',
  ...more,
})

const explore: WorkLogAgent = {
  no: 1,
  name: 'テストを調べる',
  type: 'Explore',
  model: 'claude-haiku-5-5',
  spawnEntryId: 'call-a',
  status: 'ok',
  durationMs: 12_000,
}
const plan: WorkLogAgent = {
  no: 2,
  name: '方針を立てる',
  type: 'Plan',
  model: 'claude-sonnet-5-5',
  spawnEntryId: 'call-b',
  status: 'running',
}

/** 罫線・印・文・注記を1本の文字列にして比べる */
const draw = (lines: readonly TreeLine[]): string[] =>
  lines.map(line => {
    const mark = line.status === undefined ? '' : `${{ running: '…', ok: '✓', error: '✗' }[line.status]} `
    const note = line.note === undefined ? '' : ` (${line.note})`
    return line.tone === 'root' || line.tone === 'agent'
      ? `${line.guide}${line.text} ${mark}`.trimEnd() + note
      : `${line.guide}${mark}${line.text}${note}`
  })

/** メインが a.ts を読み、サブエージェントを2つ起動し、それぞれが作業している途中 */
const twoAgents = (): WorkLogEntry[] => [
  entry('r1', '`a.ts` を読む'),
  entry('call-a', 'サブエージェント #1 Explore·haiku-5-5『テストを調べる』を起動'),
  entry('call-b', 'サブエージェント #2 Plan·sonnet-5-5『方針を立てる』を起動', { status: 'running' }),
  entry('a1', '「TODO」を検索', { agentId: 'agent-a' }),
  entry('b1', '`b.ts` を読む', { agentId: 'agent-b' }),
  entry('a2', '`test/a.test.ts` を読む', { agentId: 'agent-a' }),
  entry('a-end', '作業を終えた(回答した(12秒))', { kind: 'turn', agentId: 'agent-a' }),
  entry('b2', 'テストを実行', { agentId: 'agent-b', status: 'running' }),
]

test('サブエージェント2つは2本の枝になり、作業がそれぞれの下にまとまる', () => {
  const lines = layoutTree(twoAgents(), { 'agent-a': explore, 'agent-b': plan }, 'claude-opus-5-5', 30)

  expect(draw(lines)).toEqual([
    'メイン·opus-5-5 …',
    '├─ ✓ `a.ts` を読む',
    '├─ #1 Explore·haiku-5-5『テストを調べる』 ✓ (12秒)',
    '│  ├─ ✓ 「TODO」を検索',
    '│  └─ ✓ `test/a.test.ts` を読む',
    '└─ #2 Plan·sonnet-5-5『方針を立てる』 …',
    '   ├─ ✓ `b.ts` を読む',
    '   └─ … テストを実行',
  ])
})

test('サブエージェントが起動したサブエージェントは入れ子にする', () => {
  const child: WorkLogAgent = {
    no: 2,
    name: '細かく調べる',
    type: 'Explore',
    model: '',
    parentId: 'agent-a',
    spawnEntryId: 'call-c',
    status: 'running',
  }
  const list = [
    entry('call-a', '起動', { status: 'running' }),
    entry('call-c', '起動', { agentId: 'agent-a', status: 'running' }),
    entry('c1', '`c.ts` を読む', { agentId: 'agent-c' }),
  ]
  const lines = layoutTree(list, { 'agent-a': { ...explore, status: 'running' }, 'agent-c': child }, '', 30)

  expect(draw(lines)).toEqual([
    'メイン …',
    '└─ #1 Explore·haiku-5-5『テストを調べる』 …',
    '   └─ #2 Explore『細かく調べる』 …',
    '      └─ ✓ `c.ts` を読む',
  ])
})

test('前のターンは「回答した(12秒)」の1行に畳み、今のターンだけをツリーにする', () => {
  const list = [
    entry('old', '`old.ts` を読む'),
    entry('turn:t1', '回答した(12秒)', { kind: 'turn' }),
    entry('summary:t1', 'old.ts を読んだ。', { kind: 'summary', status: undefined }),
    entry('new', '`new.ts` を編集', { status: 'running' }),
  ]
  const lines = layoutTree(list, {}, 'opus', 30)

  expect(lines.map(line => line.tone)).toEqual(['turn', 'summary', 'root', 'work'])
  expect(draw(lines).slice(1)).toEqual(['   old.ts を読んだ。', 'メイン·opus …', '└─ … `new.ts` を編集'])
  expect(draw(lines).join('\n')).not.toContain('old.ts` を読む')
})

test('ターンの合間は、終えたばかりのターンを開いたまま出す', () => {
  const list = [entry('r1', '`a.ts` を読む'), entry('turn:t1', '中断された(3秒)', { kind: 'turn', status: 'error' })]

  expect(draw(layoutTree(list, {}, 'opus', 30))).toEqual(['メイン·opus ✗ (中断された(3秒))', '└─ ✓ `a.ts` を読む'])
})

test('入りきらなければ、終えた枝の作業を畳み、実行中の枝を残す', () => {
  const lines = layoutTree(twoAgents(), { 'agent-a': explore, 'agent-b': plan }, 'claude-opus-5-5', 6)

  expect(draw(lines)).toEqual([
    'メイン·opus-5-5 …',
    '├─ ✓ `a.ts` を読む',
    '├─ #1 Explore·haiku-5-5『テストを調べる』 ✓ (12秒 · 作業 2 件を畳んだ)',
    '└─ #2 Plan·sonnet-5-5『方針を立てる』 …',
    '   ├─ ✓ `b.ts` を読む',
    '   └─ … テストを実行',
  ])
})

test('畳んでも入らなければ、前のターンとツリーの上のほうを省く', () => {
  const list = [entry('turn:t1', '回答した(1秒)', { kind: 'turn' }), ...twoAgents()]
  const lines = layoutTree(list, { 'agent-a': explore, 'agent-b': plan }, 'opus', 4)

  expect(draw(lines)).toEqual(['メイン·opus …', '⋮ 上の 3 行を省いた', '   ├─ ✓ `b.ts` を読む', '   └─ … テストを実行'])
})
