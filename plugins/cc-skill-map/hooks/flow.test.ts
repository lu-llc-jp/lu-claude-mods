import { expect, test } from 'claude-code/testing'

import { hashText, headingFlow, parseFlow, resolveFlowModel } from './flow'

test('本文のハッシュは、同じ本文なら同じで、違えば変わる', () => {
  expect(hashText('abc')).toBe(hashText('abc'))
  expect(hashText('abc')).not.toBe(hashText('abd'))
  expect(hashText('')).toMatch(/^[0-9a-f]{8}-0$/)
})

test('抽出のモデルの設定を読む', () => {
  expect(resolveFlowModel('off', '')).toBeUndefined()
  expect(resolveFlowModel('haiku', '')).toBe('haiku')
  expect(resolveFlowModel('custom', ' my-model ')).toBe('my-model')
  // custom で空なら、モデルを使わない
  expect(resolveFlowModel('custom', '')).toBeUndefined()
})

const REPLY = JSON.stringify({
  summary: 'メモを整えて保存する',
  steps: [
    { id: 's1', title: 'メモを受け取る', actor: 'human' },
    { id: 's2', title: '整える', actor: 'ai', detail: '見出しを付ける', outputs: ['下書き'] },
    { id: 's3', title: '確かめる', actor: 'human', gate: true, next: ['s2', 's4'] },
    { id: 's4', title: '調べる', actor: 'subagent', agent: 'researcher' },
    { id: 's5', title: '保存する', actor: 'script', next: ['nowhere'] },
  ],
  outputs: [{ name: '整えたメモ', where: 'notes/' }, '記録'],
})

test('モデルの返事から流れを取り出す', () => {
  const flow = parseFlow(`はい。\n\`\`\`json\n${REPLY}\n\`\`\``)
  expect(flow?.by).toBe('model')
  expect(flow?.summary).toBe('メモを整えて保存する')
  expect(flow?.steps.map(one => [one.id, one.actor, one.gate ?? false])).toEqual([
    ['s1', 'human', false],
    ['s2', 'ai', false],
    ['s3', 'human', true],
    ['s4', 'subagent', false],
    ['s5', 'script', false],
  ])
  expect(flow?.steps[1].outputs).toEqual(['下書き'])
  expect(flow?.steps[2].next).toEqual(['s2', 's4'])
  expect(flow?.steps[3].agent).toBe('researcher')
  // 無い手順を指す next は捨てる
  expect(flow?.steps[4].next).toEqual([])
  expect(flow?.outputs).toEqual([{ name: '整えたメモ', where: 'notes/' }, { name: '記録' }])
})

test('担い手が分からない・id が重なる・名前の無い手順を整える', () => {
  const flow = parseFlow(
    JSON.stringify({ steps: [{ id: 'a', title: '一', actor: 'robot' }, { id: 'a', title: '二', actor: 'ai' }, { actor: 'ai' }] }),
  )
  expect(flow?.steps.map(one => [one.id, one.title, one.actor])).toEqual([
    ['a', '一', 'unknown'],
    ['a-2', '二', 'ai'],
  ])
})

test('形が崩れた返事は流れにしない', () => {
  expect(parseFlow('流れはありません')).toBeUndefined()
  expect(parseFlow('{"steps": ')).toBeUndefined()
  expect(parseFlow('{"steps": []}')).toBeUndefined()
  expect(parseFlow('{"summary": "x"}')).toBeUndefined()
})

test('見出しから簡易な流れを作る。コードブロックの中の # は見出しにしない', () => {
  const flow = headingFlow(
    [
      '---',
      'name: notes',
      'description: メモを整える',
      '---',
      '# メモ',
      '## 準備',
      '### 1. 受け取る',
      '```sh',
      '## これはコメント',
      '```',
      '### 2. 整える',
      '## 書き出し',
    ].join('\n'),
  )
  expect(flow.by).toBe('headings')
  expect(flow.summary).toBe('メモを整える')
  expect(flow.steps.map(one => one.title)).toEqual(['準備', '  1. 受け取る', '  2. 整える', '書き出し'])
  expect(flow.steps.every(one => one.actor === 'unknown')).toBe(true)
})
