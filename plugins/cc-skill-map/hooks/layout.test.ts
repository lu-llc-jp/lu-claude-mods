import { expect, test } from 'claude-code/testing'

import type { SkillFlow } from '../types'
import { actorLabel, cellWidth, flowAgents, hasSideAgents, layoutFlow, type FlowLine } from './layout'
import { DISPATCH_MS, TRAVEL_MS, WAIT_MS, WORK_MS, frameAt, timeline } from './play'

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

const textOf = (line: FlowLine) => line.segs.map(seg => seg.text).join('')
const toneAt = (line: FlowLine, ch: string) => line.segs.find(seg => seg.text.includes(ch))?.tone

test('手順を番号と担い手つきの箱にし、上から下へ線でつなぐ', () => {
  const lines = layoutFlow(FLOW, 30).map(textOf)
  expect(lines.slice(0, 5)).toEqual([
    '╭─ 1 ─────────────────── 人 ─╮',
    '│ メモを受け取る             │',
    '╰──────────────┬─────────────╯',
    '               │',
    '               ▼',
  ])
  expect(lines).toContain('│ 見出しを付ける             │')
  expect(lines).toContain('│ ▸ 下書き                   │')
  // 横に並べる幅が無ければ、サブエージェントの手順もメインの列に置く
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

test('幅があれば、サブエージェントの手順はメインの列から横に線を出した箱にする', () => {
  expect(hasSideAgents(FLOW, 60)).toBe(true)
  expect(hasSideAgents(FLOW, 41)).toBe(false)
  expect(hasSideAgents({ ...FLOW, steps: FLOW.steps.filter(one => one.actor !== 'subagent') }, 80)).toBe(false)

  const lines = layoutFlow(FLOW, 60).map(textOf)
  const top = lines.findIndex(line => line.includes('researcher'))
  // メインの列は幅 29、真ん中の 14 マス目に幹の線。手順名の行から横に線を出す
  expect(lines[top]).toMatch(/^ {14}│ {20}╭─ 4 ─+ researcher ─╮$/)
  expect(lines[top + 1]).toMatch(/^ {14}├─{19}▶│ 調べる +│$/)
  // 箱の上の線は幹につながり、サブエージェントの後は ▼ でメインの箱へ戻る
  expect(lines[top - 1]).toBe(`${' '.repeat(14)}│`)
  expect(lines[top + 4]).toBe(`${' '.repeat(14)}▼`)
})

test('スキル全体の成果物を末尾にまとめる', () => {
  const lines = layoutFlow(FLOW, 40).map(textOf)
  expect(lines.slice(-2)).toEqual(['成果物', '▸ 整えたメモ — notes/'])
})

test('どの行も幅に収める', () => {
  for (const width of [20, 33, 42, 60, 80, 140]) {
    const beats = timeline(FLOW, hasSideAgents(FLOW, width) ? ['subagent'] : [])
    for (const elapsed of [undefined, 0, 1000, 5000, 99_999]) {
      const frame = elapsed === undefined ? undefined : frameAt(FLOW, beats, elapsed)
      for (const line of layoutFlow(FLOW, width, frame)) {
        expect(cellWidth(textOf(line))).toBeLessThanOrEqual(Math.max(width, 20))
      }
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

// ---- 再生 ----

const beats = timeline(FLOW, ['subagent'])
const at = (elapsed: number) => layoutFlow(FLOW, 60, frameAt(FLOW, beats, elapsed))

test('再生では、進めている手順を光らせて回る印を付け、終えた手順に ✓ を付ける', () => {
  // 手順1を進めている
  const first = at(100)
  expect(toneAt(first[0], '╭─')).toBe('live')
  expect(textOf(first[1])).toMatch(/│ メモを受け取る [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] +│/)
  // 手順2を進めている。手順1は ✓ で沈んだ枠
  const second = at(WORK_MS + TRAVEL_MS + 100)
  expect(textOf(second[1])).toMatch(/│ メモを受け取る ✓ +│/)
  expect(toneAt(second[0], '╭─')).toBe('doneEdge')
})

test('再生では、手順のあいだの線を依頼の粒が下りる', () => {
  // 手順1を終えて、手順2へ線を渡っている途中(前半は1行目、後半は2行目)
  const early = at(WORK_MS + 100).map(textOf)
  const late = at(WORK_MS + TRAVEL_MS - 100).map(textOf)
  const link = early.findIndex(line => line.trim() === '●')
  expect(link).toBeGreaterThan(0)
  expect(late[link]).toBe(`${' '.repeat(14)}│`)
  expect(late[link + 1]).toBe(`${' '.repeat(14)}●`)
})

test('再生では、承認の所で止まって点滅し、戻りをたどるときは戻りの行を光らせる', () => {
  // 1 → 2 → 3(承認)
  const gateAt = WORK_MS * 2 + TRAVEL_MS * 2
  const waiting = at(gateAt + 100).map(textOf)
  expect(waiting.some(line => line.includes('⏸ 人の承認を待っています…'))).toBe(true)
  // 承認を終えたら、2 へ1回だけ戻る
  const back = at(gateAt + WAIT_MS + 100)
  const line = back.find(one => textOf(one).includes('↩ 2「整える」へ戻る'))
  expect(line === undefined ? undefined : textOf(line)).toBe('● ↩ 2「整える」へ戻る')
  expect(line?.segs[0].tone).toBe('branchLive')
})

test('再生では、サブエージェントへ依頼の粒が横に渡り、結果の粒が戻る', () => {
  const start = beats.findIndex(beat => beat.kind === 'dispatch')
  const t = beats.slice(0, start).reduce((sum, beat) => sum + beat.ms, 0)
  const wire = (elapsed: number) => textOf(at(elapsed).find(one => textOf(one).includes('▶')) as FlowLine)
  expect(wire(t + 10)).toMatch(/├●─+▶/)
  expect(wire(t + DISPATCH_MS - 10)).toMatch(/├─+●▶/)
  expect(wire(t + DISPATCH_MS + WORK_MS + 10)).toMatch(/├─+◆▶/)
  expect(wire(t + DISPATCH_MS * 2 + WORK_MS - 10)).toMatch(/├◆─+▶/)
})

test('再生では、成果物は手順を終えたときに出て、出たばかりのものは光る。最後にスキル全体の成果物を足す', () => {
  const outputs = (elapsed: number) => {
    const lines = at(elapsed)
    const head = lines.findIndex(one => textOf(one) === '成果物')
    return lines.slice(head + 1).map(one => [textOf(one), one.segs[0].tone])
  }
  expect(outputs(100)).toEqual([['まだありません', 'note']])
  // 手順2を終えた直後
  const t = WORK_MS * 2 + TRAVEL_MS
  expect(outputs(t + 100)).toEqual([['▸ 下書き', 'outputNew']])
  expect(outputs(t + 2000)).toEqual([['▸ 下書き', 'output']])
  expect(outputs(99_999)).toEqual([
    ['▸ 下書き', 'output'],
    ['▸ 整えたメモ — notes/', 'output'],
  ])
})

test('戻り先しか書かれていない手順からも、次の手順へ線を下ろす', () => {
  const flow: SkillFlow = {
    by: 'model',
    steps: [
      { id: 'a', title: '確かめる', actor: 'human' },
      { id: 'b', title: '直す', actor: 'ai', next: ['a'] },
      { id: 'c', title: '書き出す', actor: 'script' },
    ],
    outputs: [],
  }
  const lines = layoutFlow(flow, 30).map(textOf)
  const back = lines.indexOf('  ↩ 1「確かめる」へ戻る')
  expect(back).toBeGreaterThan(0)
  expect(lines[back - 1]).toMatch(/┬/)
  expect(lines[back + 2]).toBe(`${' '.repeat(15)}▼`)
})

test('担い手の呼び名と、流れに出てくるサブエージェント', () => {
  expect(actorLabel({ actor: 'script' })).toBe('スクリプト')
  expect(actorLabel({ actor: 'subagent' })).toBe('サブエージェント')
  expect(actorLabel({ actor: 'unknown' })).toBe('')
  expect(flowAgents(FLOW)).toEqual(['researcher'])
})
