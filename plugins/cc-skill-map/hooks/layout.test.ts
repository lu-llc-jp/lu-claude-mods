import { expect, test } from 'claude-code/testing'

import type { SkillFlow } from '../types'
import { actorLabel, cellWidth, flowAgents, layoutFlow } from './layout'

const FLOW: SkillFlow = {
  by: 'model',
  steps: [
    { id: 's1', title: 'メモを受け取る', actor: 'human' },
    { id: 's2', title: '整える', actor: 'ai', detail: '見出しを付ける', outputs: ['下書き'] },
    { id: 's3', title: '確かめる', actor: 'human', gate: true, next: ['s2', 's4'] },
    { id: 's4', title: '調べる', actor: 'subagent', agent: 'researcher' },
    { id: 's5', title: '保存する', actor: 'script' },
  ],
  outputs: [{ name: '整えたメモ', where: 'notes/' }],
}

const textOf = (line: { segs: Array<{ text: string }> }) => line.segs.map(seg => seg.text).join('')

test('手順を番号と担い手つきの箱にし、上から下へ線でつなぐ', () => {
  const lines = layoutFlow(FLOW, 30).map(textOf)
  expect(lines.slice(0, 4)).toEqual([
    '╭─ 1 ─────────────────── 人 ─╮',
    '│ メモを受け取る             │',
    '╰──────────────┬─────────────╯',
    '               ▼',
  ])
  expect(lines).toContain('│ 見出しを付ける             │')
  expect(lines).toContain('│ ▸ 下書き                   │')
  expect(lines).toContain('╭─ 4 ─ サブエージェント re… ─╮')
  // 最後の手順からは線を下ろさない
  expect(lines).toContain(`╰${'─'.repeat(28)}╯`)
})

test('承認を待つ所に印を付け、戻りと飛び先を箱の下に添える', () => {
  const lines = layoutFlow(FLOW, 40).map(textOf)
  expect(lines).toContain('│ ⏸ ここで人の承認を待つ               │')
  expect(lines).toContain('  ↩ 2「整える」へ戻る')
  // s4 へは並びのまま進むので、飛び先としては出さず、線を下ろす
  expect(lines.some(line => line.includes('↪'))).toBe(false)
  const gate = lines.findIndex(line => line.includes('⏸'))
  expect(lines[gate + 1]).toMatch(/┬/)
})

test('スキル全体の成果物を末尾にまとめる', () => {
  const lines = layoutFlow(FLOW, 40).map(textOf)
  expect(lines.slice(-2)).toEqual(['成果物', '▸ 整えたメモ — notes/'])
})

test('どの行も箱の幅に収める', () => {
  for (const width of [20, 33, 80]) {
    for (const line of layoutFlow(FLOW, width)) {
      expect(cellWidth(textOf(line))).toBeLessThanOrEqual(Math.max(width, 20))
    }
  }
})

test('飛び先だけを持つ手順からは線を下ろさず、飛び先を出す', () => {
  const flow: SkillFlow = {
    by: 'model',
    steps: [
      { id: 'a', title: '判定する', actor: 'ai', next: ['c'] },
      { id: 'b', title: '断る', actor: 'ai', next: [] },
      { id: 'c', title: '進める', actor: 'ai' },
    ],
    outputs: [],
  }
  const lines = layoutFlow(flow, 30).map(textOf)
  expect(lines).toContain('  ↪ 3「進める」へ進む')
  expect(lines).toContain('  ここで終わる')
  expect(lines.filter(line => line.includes('▼'))).toHaveLength(0)
})

test('担い手の呼び名と、流れに出てくるサブエージェント', () => {
  expect(actorLabel({ actor: 'script' })).toBe('スクリプト')
  expect(actorLabel({ actor: 'subagent' })).toBe('サブエージェント')
  expect(actorLabel({ actor: 'unknown' })).toBe('')
  expect(flowAgents(FLOW)).toEqual(['researcher'])
})
