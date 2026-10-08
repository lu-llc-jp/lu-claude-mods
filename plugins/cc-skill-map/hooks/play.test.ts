import { expect, test } from 'claude-code/testing'

import type { SkillFlow } from '../types'
import { WORK_MS, frameAt, playLength, timeline, visitOrder } from './play'

const step = (id: string, extra: Partial<SkillFlow['steps'][number]> = {}) => ({ id, title: id, actor: 'ai' as const, ...extra })
const flowOf = (steps: SkillFlow['steps']): SkillFlow => ({ by: 'model', steps, outputs: [] })

test('並びのとおりにたどる', () => {
  expect(visitOrder(flowOf([step('a'), step('b'), step('c')]))).toEqual([0, 1, 2])
})

test('戻りは1回だけたどってから先へ進む', () => {
  const flow = flowOf([step('a'), step('b'), step('c', { next: ['b', 'd'] }), step('d')])
  expect(visitOrder(flow)).toEqual([0, 1, 2, 1, 2, 3])
})

test('飛び先へ進み、終わりの手順で止まる', () => {
  const flow = flowOf([step('a', { next: ['c'] }), step('b', { next: [] }), step('c', { next: [] }), step('d')])
  expect(visitOrder(flow)).toEqual([0, 2])
})

test('戻りしかない輪でも止まる', () => {
  const flow = flowOf([step('a'), step('b', { next: ['a'] })])
  expect(visitOrder(flow)).toEqual([0, 1, 0, 1])
})

test('時間割は、サブエージェントへの依頼と結果、承認の待ちを分けて並べる', () => {
  const flow = flowOf([step('a'), step('b', { actor: 'subagent', agent: 'x' }), step('c', { gate: true, actor: 'human' })])
  expect(timeline(flow).map(beat => beat.kind)).toEqual(['work', 'travel', 'dispatch', 'work', 'return', 'travel', 'wait'])
  // 横に出さないときは、サブエージェントも1つの作業にする
  expect(timeline(flow, false).map(beat => beat.kind)).toEqual(['work', 'travel', 'work', 'travel', 'wait'])
})

test('1コマには、今の手順・終えた手順・出てきた成果物を入れる。最後まで行ったら終えた姿になる', () => {
  const flow: SkillFlow = {
    by: 'model',
    steps: [step('a', { outputs: ['メモ'] }), step('b', { outputs: ['メモ', '記録'] })],
    outputs: [{ name: '記録', where: 'log/' }, { name: 'まとめ' }],
  }
  const beats = timeline(flow)
  expect(frameAt(flow, beats, 0)).toEqual(expect.objectContaining({ current: 0, done: [], outputs: [], isFinished: false }))

  const second = frameAt(flow, beats, playLength(beats) - 1)
  expect(second.current).toBe(1)
  expect(second.done).toEqual([0])
  expect(second.outputs).toEqual([{ text: 'メモ', at: WORK_MS }])

  const end = frameAt(flow, beats, playLength(beats) + 1)
  expect(end.isFinished).toBe(true)
  expect(end.done).toEqual([0, 1])
  // 同じ名前の成果物は1つにまとめる
  expect(end.outputs.map(one => one.text)).toEqual(['メモ', '記録', 'まとめ'])
})
