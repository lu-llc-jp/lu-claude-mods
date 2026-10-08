import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { hashText } from './flow'
import { memoryFs } from './memory-fs.test-helper'

const HOME = '/home/u'
const CFG = `${HOME}/.config-claude`
const ROOT = `${HOME}/work/app`
const NOTES = `${CFG}/skills/notes/SKILL.md`

const NOTES_MD = [
  '---',
  'name: notes',
  'description: メモを整える',
  '---',
  '# メモ',
  '## 受け取る',
  '## 整える',
  '## 承認',
  '## 保存',
].join('\n')

const REPLY = JSON.stringify({
  summary: 'メモを整えて保存する',
  steps: [
    { id: 's1', title: 'メモを受け取る', actor: 'human' },
    { id: 's2', title: '整える', actor: 'ai', outputs: ['下書き'] },
    { id: 's3', title: '確かめる', actor: 'human', gate: true, next: ['s2', 's4'] },
    { id: 's4', title: '調べる', actor: 'subagent', agent: 'researcher' },
    { id: 's5', title: '保存する', actor: 'script' },
  ],
  outputs: [{ name: '整えたメモ', where: 'notes/' }],
})

const LISTED = [
  { name: 'notes', source: 'userSettings', tokens: 10 },
  { name: 'kit:review', source: 'plugin', pluginName: 'kit', tokens: 10 },
  { name: 'loop', source: 'built-in', tokens: 10 },
]

type World = { files: Record<string, string>; modelCalls: Array<{ model: string; prompt: string }>; reply: () => unknown }

/** エンジンの代わりに、コンテキストの内訳・ファイル・モデル・保存領域・時計に答える */
const answerWorld = (on: On, world: World, stored: Record<string, unknown> = {}) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-09T05:00:00Z') })
  mock.store(on, stored)
  mock.env(on, { HOME, CLAUDE_CONFIG_DIR: CFG })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'cc-skill-map', isShown: true }] as never }))
  on('session.root', () => ({ value: ROOT }))
  // スキルの本文は、エンジンが展開したまま返す
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('session.usage', () => ({
    value: {
      context: {
        breakdown: {
          skills: { totalSkills: LISTED.length, includedSkills: LISTED.length, tokens: 30, skillFrontmatter: LISTED },
          agents: [{ agentType: 'writer', source: 'userSettings', tokens: 10 }],
        },
      },
    } as never,
  }))
  // ファイルは world.files を毎回読むので、テストの途中で書き換えられる
  const fs = () => memoryFs(world.files)
  on('fs.read', async ($, e) => ({ value: await fs().read(e.path) }))
  on('fs.list', async ($, e) => ({ value: (await fs().list(e.path)).map(one => ({ ...one, size: 0, mtimeMs: 0, isLink: false })) as never }))
  on('fs.exists', async ($, e) => ({ value: await fs().exists(e.path) }))
  on('model.complete', ($, e) => {
    world.modelCalls.push({ model: e.model, prompt: String(e.prompt) })
    return { value: world.reply() as never }
  })
  return clock
}

const USAGE = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const newWorld = (): World => ({
  files: {
    [NOTES]: NOTES_MD,
    [`${CFG}/agents/writer.md`]: '---\nname: writer\nskills:\n  - notes\n---\n',
  },
  modelCalls: [],
  reply: () => ({ isAnswered: true, text: REPLY, usage: USAGE }),
})

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const run = ($: Engine, args = '') =>
  $.command.run({
    command: 'cc-skill-map',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

const mountPane = ($: Engine, surface: 'terminal' | 'desktop', bodyColumns = 60) =>
  $.ui.mount({
    plugin: 'cc-skill-map',
    surface,
    component: 'Pane',
    requestId: 'cc-skill-map',
    props: {
      title: 'スキルの流れ',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })

test('/cc-skill-map で、スキルを出どころごとに並べ、持たせているサブエージェントを添える', async ($, on) => {
  answerWorld(on, newWorld())
  await start($)

  const { text } = await run($)
  expect(text).toBe('スキルの一覧を開きました')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ text: 'スキル 3 件' })).toBeDefined()
    expect(await ui.find({ text: /── ユーザー\(1\)/ })).toBeDefined()
    expect(await ui.find({ text: /── プラグイン\(1\)/ })).toBeDefined()
    expect(await ui.find({ text: /── 組み込み\(1\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'notes' })).toBeDefined()
    expect(await ui.find({ text: /← writer {2}メモを整える/ })).toBeDefined()
    await ui.unmount()
  }
})

test('スキルを押すと、モデルで読み取った流れを、担い手・承認・成果物つきの箱で出す', async ($, on) => {
  const world = newWorld()
  const clock = answerWorld(on, world)
  await start($)
  await run($)

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'skill:notes' })
  await clock.settle()
  expect(world.modelCalls).toHaveLength(1)
  expect(world.modelCalls[0].model).toBe('haiku')
  expect(world.modelCalls[0].prompt).toContain('## 整える')

  // 読み取れたら頭から再生する。最後まで進めて、終えた姿を見る
  await clock.advance(60_000)
  expect(await ui.find({ text: 'メモを整えて保存する' })).toBeDefined()
  expect(await ui.find({ text: /持たせているサブエージェント: writer/ })).toBeDefined()
  expect(await ui.find({ text: /流れに出てくるサブエージェント: researcher/ })).toBeDefined()
  expect(await ui.find({ text: /╭─ 1 ─+ 人 ─╮/ })).toBeDefined()
  // 幅 60 では、サブエージェントの手順はメインの列から横に線を出した箱
  expect(await ui.find({ text: /├─+▶│ 調べる ✓ +│/ })).toBeDefined()
  expect(await ui.find({ text: /⏸ ここで人の承認を待つ/ })).toBeDefined()
  expect(await ui.find({ text: /↩ 2「整える」へ戻る/ })).toBeDefined()
  expect(await ui.find({ text: /▸ 整えたメモ — notes\// })).toBeDefined()
  expect(await ui.find({ text: NOTES })).toBeDefined()

  // 一覧に戻れる
  await ui.press({ key: 'back' })
  expect(await ui.find({ text: 'スキル 3 件' })).toBeDefined()
  await ui.unmount()
})

test('開くと手順の順に再生し、止める・もう一度ができる', async ($, on) => {
  const world = newWorld()
  const clock = answerWorld(on, world)
  await start($)
  await run($)

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'skill:notes' })
  await clock.settle()
  // 再生中: 手順1を進めていて、成果物はまだ無い
  await clock.advance(300)
  expect(await ui.find({ type: 'Button', text: '止める' })).toBeDefined()
  expect(await ui.find({ text: /│ メモを受け取る [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] +│/ })).toBeDefined()
  expect(await ui.find({ text: 'まだありません' })).toBeDefined()

  // 2 つめの手順へ進むと、1 つめに ✓ が付く
  await clock.advance(1500)
  expect(await ui.find({ text: /│ メモを受け取る ✓ +│/ })).toBeDefined()

  // 止めると、再生前の姿に戻る
  await ui.press({ key: 'stop' })
  expect(await ui.find({ type: 'Button', text: '▶ 再生' })).toBeDefined()
  expect(await ui.find({ text: /│ メモを受け取る +│/ })).toBeDefined()

  // 再生して最後まで行くと、もう一度を出す
  await ui.press({ key: 'play' })
  await clock.advance(60_000)
  expect(await ui.find({ type: 'Button', text: '▶ もう一度' })).toBeDefined()
  expect(await ui.find({ text: /│ 保存する ✓ +│/ })).toBeDefined()
  await ui.unmount()
})

test('2回目は使い回してモデルを呼ばず、SKILL.md が変わったら読み取り直す', async ($, on) => {
  const world = newWorld()
  const clock = answerWorld(on, world)
  await start($)
  await run($)

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'skill:notes' })
  await clock.settle()
  await ui.press({ key: 'back' })
  await ui.press({ key: 'skill:notes' })
  await clock.settle()
  expect(world.modelCalls).toHaveLength(1)

  world.files[NOTES] = `${NOTES_MD}\n## 片付け`
  await ui.press({ key: 'reload' })
  await clock.settle()
  expect(world.modelCalls).toHaveLength(2)
  await ui.unmount()
})

test('前のセッションで読み取った流れは、本文とモデルが同じならモデルを呼ばずに使う', async ($, on) => {
  const world = newWorld()
  const flow = { summary: '前に読み取った流れ', steps: [{ id: 's1', title: '受け取る', actor: 'human' }], outputs: [], by: 'model' }
  const clock = answerWorld(on, world, { 'flow:notes': { hash: hashText(NOTES_MD), model: 'haiku', flow } })
  await start($)
  await run($, 'notes')
  await clock.settle()

  const ui = await mountPane($, 'terminal')
  expect(world.modelCalls).toHaveLength(0)
  expect(await ui.find({ text: '前に読み取った流れ' })).toBeDefined()
  await ui.unmount()
})

test('保存した流れでも、読み取ったモデルが今の設定と違えば読み取り直す', { options: { flowModel: 'sonnet' } }, async ($, on) => {
  const world = newWorld()
  const flow = { steps: [{ id: 's1', title: '受け取る', actor: 'human' }], outputs: [], by: 'model' }
  const clock = answerWorld(on, world, { 'flow:notes': { hash: hashText(NOTES_MD), model: 'haiku', flow } })
  await start($)
  await run($, 'notes')
  await clock.settle()

  expect(world.modelCalls.map(one => one.model)).toEqual(['sonnet'])
})

test('flowModel を off にすると、モデルを呼ばず見出しだけの流れを出す', { options: { flowModel: 'off' } }, async ($, on) => {
  const world = newWorld()
  const clock = answerWorld(on, world)
  await start($)

  expect((await run($, 'notes')).text).toBe('スキル「notes」の流れを開きました')
  await clock.settle()

  const ui = await mountPane($, 'terminal')
  expect(world.modelCalls).toHaveLength(0)
  expect(await ui.find({ text: /見出しから作った簡易な流れです/ })).toBeDefined()
  expect(await ui.find({ text: /│ 整える +│/ })).toBeDefined()
  await ui.unmount()
})

test('読み取りに失敗したら、理由を添えて見出しの流れで代える', async ($, on) => {
  const world = newWorld()
  world.reply = () => ({ isAnswered: true, text: '流れはありません', usage: USAGE })
  const clock = answerWorld(on, world)
  await start($)
  await run($, 'notes')
  await clock.settle()

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: /流れを読み取れず、見出しで代えました\(haiku\): 応答の形が崩れていました/ })).toBeDefined()
  expect(await ui.find({ text: /│ 保存 +│/ })).toBeDefined()
  await ui.unmount()
})

test('組み込みのスキルは、呼ばれるまでは理由を出し、呼ばれたらその本文から流れを出す', async ($, on) => {
  const world = newWorld()
  const clock = answerWorld(on, world)
  await start($)
  await run($, 'loop')
  await clock.settle()

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: /組み込みのスキルは SKILL.md がありません/ })).toBeDefined()
  expect(world.modelCalls).toHaveLength(0)

  const called = await $.skill.prompt({ skill: 'loop', text: '# 繰り返し\n## 間隔を決める\n## 実行する' })
  // 本文は変えない
  expect(called.text).toBe('# 繰り返し\n## 間隔を決める\n## 実行する')
  await ui.press({ key: 'reload' })
  await clock.settle()
  expect(world.modelCalls).toHaveLength(1)
  expect(world.modelCalls[0].prompt).toContain('## 間隔を決める')
  expect(await ui.find({ text: 'メモを整えて保存する' })).toBeDefined()
  await ui.unmount()
})

test('このセッションに無いスキル名を渡したら、そう答える', async ($, on) => {
  answerWorld(on, newWorld())
  await start($)
  expect((await run($, 'nothing')).text).toBe('スキル「nothing」はこのセッションにありません')
})
