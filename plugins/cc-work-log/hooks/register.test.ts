import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { WorkLogEntry } from '../types'
import { describeTool, describeTurnEnd, resolveSummaryModel, shortModel } from './describe'

const CWD = '/work/app'

/** ツールの呼び出しにエンジンの代わりに答える。fail に入れたツールは失敗にする */
const answerTools = (on: On, fail: string[] = []) => {
  on('tool.call', ($, e) =>
    fail.includes(String(e.tool))
      ? ({ isError: true, result: undefined, text: 'failed' } as never)
      : ({ result: {}, text: 'ok' } as never),
  )
}

/** mod が $.state に書いた値を拾う(テストの $ には state が無いため) */
const state: Record<string, unknown> = {}

const answerBasics = (on: On, { openPane = true } = {}) => {
  for (const key of Object.keys(state)) delete state[key]
  const clock = mock.clock(on, { now: Date.parse('2026-10-08T05:00:00Z') })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  if (openPane) on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('state.set', ($, e, next) => {
    if (e.plugin === 'cc-work-log') state[e.key] = e.value
    return next(e)
  })
  return clock
}

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

const endTurn = ($: Engine, turnId = 't1', reason: 'answer' | 'aborted' | 'error' = 'answer') =>
  $.turn.complete({ answer: '', durationMs: 12_000, isAborted: reason === 'aborted', turnId, reason })

const entries = async (_$: Engine): Promise<WorkLogEntry[]> => (state.entries ?? []) as WorkLogEntry[]

/** ワークフローなど、Agent ツールを介さずにサブエージェントを起動する */
const spawnExplore = ($: Engine, toolUseId = 'workflow-1') =>
  $.agent.spawn({
    tool_use_id: toolUseId,
    prompt: '調べて',
    description: 'テストを調べる',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'opus',
    background: false,
    fork: false,
  })

const texts = async ($: Engine) => (await entries($)).map(one => one.text)

test('主なツールを日本語の1行にする', () => {
  expect(describeTool('Read', { file_path: `${CWD}/src/a.ts` }, CWD)).toBe('`src/a.ts` を読む')
  expect(describeTool('Edit', { file_path: `${CWD}/src/a.ts` }, CWD)).toBe('`src/a.ts` を編集')
  expect(describeTool('Write', { file_path: '/etc/hosts' }, CWD)).toBe('`/etc/hosts` を書き込む')
  expect(describeTool('Agent', { description: 'テストを調べる' }, CWD)).toBe('サブエージェント『テストを調べる』を起動')
  expect(describeTool('Grep', { pattern: 'TODO' }, CWD)).toBe('「TODO」を検索')
  expect(describeTool('mcp__github__create_issue', {}, CWD)).toBe('MCP github の create_issue を呼ぶ')
  expect(describeTool('SomethingNew', {}, CWD)).toBe('SomethingNew を使う')
})

test('Bash は日本語の description を使い、無いか日本語でなければコマンドの先頭を出す', () => {
  expect(describeTool('Bash', { command: 'git status', description: '作業ツリーの状態を見る' }, CWD)).toBe(
    '作業ツリーの状態を見る',
  )
  expect(describeTool('Bash', { command: 'git status' }, CWD)).toBe('`git status` を実行')
  // 日本語でない説明は使わず、コマンドを出す
  expect(describeTool('Bash', { command: 'ls hooks', description: 'List plugin directory' }, CWD)).toBe(
    '`ls hooks` を実行',
  )
  expect(describeTool('Bash', { command: 'x'.repeat(100) }, CWD)).toBe(`\`${'x'.repeat(39)}…\` を実行`)
})

test('ターンの終わり方を日本語にする', () => {
  expect(describeTurnEnd('answer', 12_000)).toBe('回答した(12秒)')
  expect(describeTurnEnd('aborted', 75_000)).toBe('中断された(1分15秒)')
  expect(describeTurnEnd('error', 0)).toBe('エラーで終わった(0秒)')
})

test('ツールを呼ぶたびに行が増え、成功は ok・失敗は error になる', async ($, on) => {
  answerBasics(on)
  answerTools(on, ['Bash'])
  await start($)

  await $.tool.call({ tool: 'Read', file_path: `${CWD}/src/a.ts` })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'テストを実行' })

  const list = await entries($)
  expect(list.map(one => [one.text, one.status])).toEqual([
    ['`src/a.ts` を読む', 'ok'],
    ['テストを実行', 'error'],
  ])
})

test('ツールの結果をそのまま返す', async ($, on) => {
  answerBasics(on)
  answerTools(on, ['Bash'])
  await start($)

  const ok = await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts` })
  const ng = await $.tool.call({ tool: 'Bash', command: 'false' })

  expect(ok.text).toBe('ok')
  expect(ng.isError).toBe(true)
})

test('ターンの終わりに区切りの行を出す', async ($, on) => {
  answerBasics(on)
  answerTools(on)
  await start($)

  await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts` })
  await endTurn($, 't1', 'aborted')

  expect((await texts($)).at(-1)).toBe('中断された(12秒)')
})

test('ペインに残すのは直近 50 件', async ($, on) => {
  answerBasics(on)
  answerTools(on)
  await start($)

  for (let i = 0; i < 55; i += 1) await $.tool.call({ tool: 'Read', file_path: `${CWD}/f${i}.ts` })

  const list = await texts($)
  expect(list.length).toBe(50)
  expect(list[0]).toBe('`f5.ts` を読む')
})

test('ツールを介さないサブエージェントの起動を1行出し、id と名前を覚える', async ($, on) => {
  answerBasics(on)
  answerTools(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  await start($)

  await spawnExplore($)

  expect(state.agents).toEqual({ 'agent-1': { no: 1, name: 'テストを調べる', type: 'Explore', model: 'haiku' } })
  expect((await texts($)).at(-1)).toBe('サブエージェント #1 Explore·haiku『テストを調べる』を起動')
})

test('Agent ツールの起動の行に、番号・種類・モデルを書き足す', async ($, on) => {
  answerBasics(on)
  answerTools(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'agent-1' }))
  await start($)

  await $.tool.call({ tool: 'Agent', description: 'テストを調べる', prompt: '調べて' })
  const line = (await entries($)).at(-1)
  await spawnExplore($, line?.id)

  expect(await texts($)).toEqual(['サブエージェント #1 Explore·haiku-5-5『テストを調べる』を起動'])
})

test('SubagentHandback はログに出さない', async ($, on) => {
  answerBasics(on)
  answerTools(on)
  await start($)

  await $.tool.call({ tool: 'SubagentHandback', report: '終わりました' } as never)

  expect(await texts($)).toEqual([])
})

test('モデル ID を短くする', () => {
  expect(shortModel('claude-haiku-5-5')).toBe('haiku-5-5')
  expect(shortModel('claude-sonnet-4-5-20250929')).toBe('sonnet-4-5')
  expect(shortModel('opus')).toBe('opus')
})

test('サブエージェントの行は、そのエージェントの名前を付けて区別して描く', async ($, on) => {
  answerBasics(on)
  answerTools(on, ['Bash'])
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  await start($)

  await spawnExplore($)
  // テストの $.tool.call では agentId(どのエージェントの呼び出しか)を渡せないので、サブエージェントのターン終了で確かめる
  await $.turn.complete({
    answer: '',
    durationMs: 3_000,
    isAborted: false,
    turnId: 'sub-1',
    reason: 'answer',
    agentId: 'agent-1',
  })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'テストを実行' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ text: /↳ #1 Explore·haiku ── 作業を終えた\(回答した\(3秒\)\)/ })).toBeDefined()
    expect(await ui.find({ text: /✗ テストを実行/ })).toBeDefined()
    await ui.unmount()
  }
})

const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({
    plugin: 'cc-work-log',
    surface,
    component: 'Pane',
    requestId: 'cc-work-log',
    props: {
      title: '作業ログ',
      isFocused: false,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  })

test('ペインの先頭にメインのモデルを出す', async ($, on) => {
  answerBasics(on)
  answerTools(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  await start($)

  await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts` })

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: /メイン: opus-5-5/ })).toBeDefined()
  await ui.unmount()
})

test('/cc-work-log でペインを開く', async ($, on) => {
  answerBasics(on, { openPane: false })
  let opened = ''
  on('ui.open', ($, e) => {
    opened = e.id
    return { value: { isPlaced: true } }
  })
  await start($)

  const { text } = await $.command.run({
    command: 'cc-work-log',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  expect(text).toBe('作業ログのペインを開きました')
  expect(opened).toBe('cc-work-log')
})

test('要約は初期値オフで、モデルを呼ばない', async ($, on) => {
  answerBasics(on)
  answerTools(on)
  let calls = 0
  on('model.complete', () => {
    calls += 1
    return { value: { isAnswered: true, text: '要約', usage: USAGE } }
  })
  await start($)

  await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts` })
  await endTurn($)

  expect(calls).toBe(0)
  expect((await entries($)).some(one => one.kind === 'summary')).toBe(false)
})

const USAGE = {
  input_tokens: 10,
  output_tokens: 10,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

test('haiku にすると、ターンの終わりに要約の行が出る', { options: { summaryModel: 'haiku' } }, async ($, on) => {
  const clock = answerBasics(on)
  answerTools(on)
  let asked: { model: string; prompt: string } | undefined
  on('model.complete', ($, e) => {
    asked = { model: e.model, prompt: e.prompt }
    return { value: { isAnswered: true, text: 'a.ts を読んでテストを実行した。', usage: USAGE } }
  })
  await start($)

  await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts` })
  await endTurn($)
  await clock.settle()

  expect(asked?.model).toBe('haiku')
  expect(asked?.prompt).toContain('`a.ts` を読む')
  const last = (await entries($)).at(-1)
  expect(last?.kind).toBe('summary')
  expect(last?.text).toBe('a.ts を読んでテストを実行した。')
})

test(
  '存在しないモデルでも作業ログは止まらず、要約を止めた理由が出る',
  { options: { summaryModel: 'custom', summaryModelCustom: 'no-such-model' } },
  async ($, on) => {
    const clock = answerBasics(on)
    answerTools(on)
    let calls = 0
    on('model.complete', () => {
      calls += 1
      // エンジンが送る前に断る場合(モデルが無い・許可されていない)は、呼び出しが reject される
      return { deny: 'model not found: no-such-model' }
    })
    await start($)

    await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts` })
    await endTurn($, 't1')
    await clock.settle()

    const notice = (await entries($)).at(-1)
    expect(notice?.kind).toBe('notice')
    expect(notice?.text).toContain('要約を止めました(no-such-model)')
    expect(notice?.text).toContain('model not found')

    // 次のターンも作業ログは出るが、モデルはもう呼ばない
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/a.ts`, old_string: 'a', new_string: 'b' })
    await endTurn($, 't2')
    await clock.settle()
    expect(calls).toBe(1)
    expect((await texts($)).slice(-2)).toEqual(['`a.ts` を編集', '回答した(12秒)'])
  },
)

test(
  '権限のないモデル(403)なら要約を止め、混雑(529)なら次のターンでまた試す',
  { options: { summaryModel: 'opus' } },
  async ($, on) => {
    const clock = answerBasics(on)
    answerTools(on)
    let status = 529
    on('model.complete', () => ({
      value: {
        isAnswered: false,
        reason: 'api-error',
        status,
        error: status === 529 ? 'overloaded' : 'permission_error',
        usage: USAGE,
      },
    }) as never)
    await start($)

    await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts` })
    await endTurn($, 't1')
    await clock.settle()
    expect((await texts($)).at(-1)).toContain('今回は要約できませんでした')

    status = 403
    await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts` })
    await endTurn($, 't2')
    await clock.settle()
    expect((await texts($)).at(-1)).toContain('要約を止めました(opus)')
  },
)

test('custom で空なら要約しない理由を出す', () => {
  expect(resolveSummaryModel('off', 'x')).toBeUndefined()
  expect(resolveSummaryModel('haiku', '')).toBe('haiku')
  expect(resolveSummaryModel('custom', ' claude-haiku-5-5 ')).toBe('claude-haiku-5-5')
  expect(resolveSummaryModel('custom', '')).toBe('')
})
