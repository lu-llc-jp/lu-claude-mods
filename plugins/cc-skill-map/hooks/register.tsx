import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FlowActor, FlowCache, FlowState, SkillInfo } from '../types'
import { discoverSkills, sourceLabel, type FsLike } from './discover'
import { FLOW_SYSTEM, flowPrompt, hashText, headingFlow, parseFlow, resolveFlowModel } from './flow'
import { BOX_MIN, fit, flowAgents, layoutFlow, type FlowLine, type FlowSeg, type FlowTone } from './layout'

const PANE = 'cc-skill-map'
const COMMAND = 'cc-skill-map'

// セッションの値は $.state に置く(ホットリロードでモジュール変数は消えるため)
const skillsAtom = atom({ plugin: 'cc-skill-map', key: 'skills' } as const, null as SkillInfo[] | null)
const scanErrorAtom = atom({ plugin: 'cc-skill-map', key: 'scanError' } as const, null as string | null)
const selectedAtom = atom({ plugin: 'cc-skill-map', key: 'selected' } as const, null as string | null)
const flowsAtom = atom({ plugin: 'cc-skill-map', key: 'flows' } as const, {} as Record<string, FlowState>)
const promptsAtom = atom({ plugin: 'cc-skill-map', key: 'prompts' } as const, {} as Record<string, string>)

/** 組み込みのスキルの本文として覚えておく長さの上限 */
const PROMPT_MAX = 60_000

const errorText = (err: unknown): string => {
  const text = err instanceof Error ? err.message : String(err)
  return fit(text.replace(/\s+/g, ' '), 120)
}

const fsOf = ($: EngineInterface): FsLike => ({
  read: async path => {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : ''
  },
  list: path => $.fs.list(path),
  exists: path => $.fs.exists(path),
})

const cacheKey = (name: string): string => `flow:${name}`

/** セッションで使えるスキルを読み直す。SKILL.md の場所とサブエージェントの対応もここで探す */
const scan = async ($: EngineInterface): Promise<void> => {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const breakdown = usage.context.breakdown
    const listed = breakdown?.skills?.skillFrontmatter ?? []
    const home = (await $.env.get('HOME')) ?? ''
    const cfg = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
    const skills = await discoverSkills(fsOf($), {
      listed: listed.map(one => ({ name: one.name, source: one.source, ...(one.pluginName === undefined ? {} : { pluginName: one.pluginName }) })),
      ...(breakdown === undefined ? {} : { agentTypes: breakdown.agents.map(one => one.agentType) }),
      cfg,
      home,
      root: await $.session.root(),
    })
    await update($, skillsAtom, () => skills)
    await update($, scanErrorAtom, () => (breakdown === undefined ? 'コンテキストの内訳が取れませんでした' : null))
  } catch (err) {
    await update($, skillsAtom, previous => previous ?? [])
    await update($, scanErrorAtom, () => errorText(err))
  }
}

const setFlow = ($: EngineInterface, name: string, state: FlowState) =>
  update($, flowsAtom, map => ({ ...map, [name]: state }))

/** スキルの本文。SKILL.md があればそれを、無ければ呼ばれたときに覚えた本文を使う */
const skillText = async ($: EngineInterface, skill: SkillInfo): Promise<string | undefined> => {
  if (skill.path !== undefined) {
    try {
      const text = await $.fs.read(skill.path)
      if (typeof text === 'string') return text
    } catch {
      // 消えた・読めないときは、覚えた本文に頼る
    }
  }
  return (await read($, promptsAtom))[skill.name]
}

/**
 * 流れを読み取る。本文が前と同じなら何もしない。
 * モデルを使うなら、$.store に同じ本文とモデルで抽出したものがあれば使い回し、無ければ抽出する。
 * モデルを使わないとき・抽出に失敗したときは、見出しだけの流れにする
 */
const loadFlow = async ($: EngineInterface, skill: SkillInfo, model: string | undefined): Promise<void> => {
  const text = await skillText($, skill)
  if (text === undefined) {
    await setFlow($, skill.name, {
      status: 'none',
      reason:
        skill.source === 'built-in'
          ? '組み込みのスキルは SKILL.md がありません。このセッションで一度呼ぶと、そのときの本文から流れを出します'
          : 'SKILL.md が見つかりませんでした',
    })
    return
  }
  const hash = hashText(text)
  const current = (await read($, flowsAtom))[skill.name]
  if (current?.status === 'loading') return
  // 失敗して見出しで代えたもの(note あり)は、開くたびに読み取りをやり直す
  if (current?.status === 'ready' && current.hash === hash && current.model === model && current.note === undefined) return

  if (model === undefined) {
    await setFlow($, skill.name, { status: 'ready', flow: headingFlow(text), hash })
    return
  }
  const cached = (await $.store.get(cacheKey(skill.name)).catch(() => undefined)) as FlowCache | undefined
  if (cached !== undefined && cached !== null && cached.hash === hash && cached.model === model) {
    await setFlow($, skill.name, { status: 'ready', flow: cached.flow, hash, model })
    return
  }

  await setFlow($, skill.name, { status: 'loading', model })
  const fallback = (reason: string) =>
    setFlow($, skill.name, { status: 'ready', flow: headingFlow(text), hash, note: `流れを読み取れず、見出しで代えました(${model}): ${reason}` })
  let result: Awaited<ReturnType<EngineInterface['model']['complete']>>
  try {
    result = await $.model.complete({
      model,
      system: FLOW_SYSTEM,
      prompt: flowPrompt(skill.name, text),
      maxTokens: 4000,
      effort: 'low',
      timeoutMs: 90_000,
    })
  } catch (err) {
    await fallback(errorText(err))
    return
  }
  if (!result.isAnswered) {
    await fallback(
      result.reason === 'api-error' ? `API エラー(${result.status ?? '応答なし'} ${result.error})` : result.reason === 'empty-reply' ? '空の応答' : '時間切れ・中断',
    )
    return
  }
  const flow = parseFlow(result.text)
  if (flow === undefined) {
    await fallback('応答の形が崩れていました')
    return
  }
  const entry: FlowCache = { hash, model, flow }
  await $.store.set(cacheKey(skill.name), entry).catch(() => undefined)
  await setFlow($, skill.name, { status: 'ready', flow, hash, model })
}

/** スキルを開く。流れの読み取りは後ろで行い、押した操作を待たせない */
const openSkill = async ($: EngineInterface, name: string, model: string | undefined): Promise<void> => {
  await update($, selectedAtom, () => name)
  const skill = (await read($, skillsAtom))?.find(one => one.name === name)
  if (skill === undefined) return
  await $.clock.after(0, () => void loadFlow($, skill, model).catch(() => undefined))
}

/** 一覧を読み直し、開いているスキルがあれば流れも読み直す */
const reload = async ($: EngineInterface, model: string | undefined): Promise<void> => {
  await scan($)
  const name = await read($, selectedAtom)
  if (name !== null) await openSkill($, name, model)
}

export const register: Register = (on, options) => {
  const flowModel = resolveFlowModel(String(options.flowModel ?? 'haiku'), String(options.flowModelCustom ?? ''))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: '使えるスキルの一覧と、その手順の流れをペインに表示する(引数にスキル名を渡すとそのスキルを開く)',
    })
    return next(e)
  })

  // 組み込みのスキルは SKILL.md を持たないので、呼ばれたときの本文を覚えておく。本文は変えない
  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    try {
      const skill = (await read($, skillsAtom))?.find(one => one.name === e.skill)
      if (skill?.path === undefined) {
        await update($, promptsAtom, map => ({ ...map, [e.skill]: e.text.slice(0, PROMPT_MAX) }))
      }
    } catch {
      // 覚えられなくてもスキルは止めない
    }
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'スキルの流れ' })
    await scan($)
    const name = e.args.trim()
    if (name === '') {
      await update($, selectedAtom, () => null)
      return { text: 'スキルの一覧を開きました' }
    }
    const skills = (await read($, skillsAtom)) ?? []
    if (!skills.some(one => one.name === name)) return { text: `スキル「${name}」はこのセッションにありません` }
    await openSkill($, name, flowModel)
    return { text: `スキル「${name}」の流れを開きました` }
  }).catch(() => ({ text: 'スキルの一覧を開けませんでした' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const skills = await read($, skillsAtom)
    const scanError = await read($, scanErrorAtom)
    const selected = await read($, selectedAtom)
    const width = Math.max(10, e.props.bodyColumns)

    if (skills === null) {
      return (
        <Box flexDirection="column" width={width}>
          <Text dimColor>スキルを読んでいます…</Text>
        </Box>
      )
    }

    const skill = selected === null ? undefined : skills.find(one => one.name === selected)
    if (skill !== undefined) {
      const state = (await read($, flowsAtom))[skill.name]
      const agents = [...new Set([...skill.agents, ...(state?.status === 'ready' ? flowAgents(state.flow) : [])])]
      return (
        <Box flexDirection="column" width={width}>
          <Box flexDirection="row" gap={1}>
            <Button key="back" hotkey="b" onPress={() => void update($, selectedAtom, () => null)}>
              一覧に戻る
            </Button>
            <Button key="reload" hotkey="r" dimColor onPress={() => reload($, flowModel)}>
              読み直す
            </Button>
          </Box>
          <Text wrap="truncate">
            <Text bold>{skill.name}</Text>
            <Text dimColor> · {sourceLabel(skill.source)}</Text>
          </Text>
          {skill.agents.length === 0 ? null : (
            <Text wrap="truncate">
              <Text dimColor>持たせているサブエージェント: </Text>
              <Text color="permission">{skill.agents.join('、')}</Text>
            </Text>
          )}
          {agents.length > skill.agents.length ? (
            <Text wrap="truncate">
              <Text dimColor>流れに出てくるサブエージェント: </Text>
              <Text color="permission">{agents.filter(one => !skill.agents.includes(one)).join('、')}</Text>
            </Text>
          ) : null}
          <FlowBody Box={Box} Text={Text} state={state} width={width} />
          {skill.path === undefined ? null : (
            <Text dimColor wrap="truncate">
              {skill.path}
            </Text>
          )}
        </Box>
      )
    }

    // 一覧。出どころごとにまとめ、スキル名を押すとその流れを開く
    const groups: Array<{ source: string; list: SkillInfo[] }> = []
    for (const one of skills) {
      const last = groups.at(-1)
      if (last !== undefined && last.source === one.source) last.list.push(one)
      else groups.push({ source: one.source, list: [one] })
    }
    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" gap={1}>
          <Text bold>スキル {skills.length} 件</Text>
          <Button key="reload" hotkey="r" dimColor onPress={() => reload($, flowModel)}>
            読み直す
          </Button>
        </Box>
        {scanError === null ? null : (
          <Text color="warning" wrap="wrap">
            {scanError}
          </Text>
        )}
        {groups.map(group => (
          <Box key={`group:${group.source}`} flexDirection="column">
            <Text dimColor>
              ── {sourceLabel(group.source)}({group.list.length})
            </Text>
            {group.list.map(one => {
              const note = [
                ...(one.agents.length === 0 ? [] : [`← ${one.agents.join('、')}`]),
                ...(one.description === undefined ? [] : [one.description]),
              ].join('  ')
              return (
                <Box key={`row:${one.name}`} flexDirection="row" gap={1}>
                  <Button key={`skill:${one.name}`} plain onPress={() => openSkill($, one.name, flowModel)}>
                    {one.name}
                  </Button>
                  {note === '' ? null : (
                    <Text dimColor wrap="truncate">
                      {note}
                    </Text>
                  )}
                </Box>
              )
            })}
          </Box>
        ))}
      </Box>
    )
  })
}

type Elements = ReturnType<EngineInterface['ui']['resolve']>
type TextElement = Elements['Text']
type BoxElement = Elements['Box']

/** 流れの本体。読み取りの様子に応じて、待ち・理由・箱の並びを出す */
const FlowBody = ({ Box, Text, state, width }: { Box: BoxElement; Text: TextElement; state: FlowState | undefined; width: number }) => {
  if (state === undefined || state.status === 'loading') {
    return <Text dimColor>流れを読み取っています…{state === undefined ? '' : `(${state.model})`}</Text>
  }
  if (state.status === 'none') {
    return (
      <Text color="warning" wrap="wrap">
        {state.reason}
      </Text>
    )
  }
  if (width < BOX_MIN) {
    return <Text dimColor wrap="wrap">流れは幅 {BOX_MIN} マス以上で出します</Text>
  }
  const flow = state.flow
  return (
    <Box flexDirection="column">
      {flow.summary === undefined ? null : <Text wrap="wrap">{flow.summary}</Text>}
      {state.note === undefined ? null : (
        <Text color="warning" wrap="wrap">
          {state.note}
        </Text>
      )}
      {flow.by === 'headings' ? <Text dimColor wrap="wrap">見出しから作った簡易な流れです(担い手・承認・成果物は出ません)</Text> : null}
      {flow.steps.length === 0 ? <Text dimColor>手順の見出しがありません</Text> : null}
      {flow.by === 'model' ? <Legend Text={Text} /> : null}
      {layoutFlow(flow, width).map(line => (
        <FlowRow key={line.key} Text={Text} line={line} />
      ))}
    </Box>
  )
}

type FlowStyle = { color?: string; dimColor?: boolean; bold?: boolean; italic?: boolean }

/** 流れの色分け。色はテーマのキーにして、明るいテーマでも読めるようにする */
const FLOW_STYLE: Record<FlowTone, FlowStyle> = {
  edge: { color: 'subtle' },
  no: { dimColor: true },
  title: { bold: true },
  detail: { dimColor: true },
  actor: {},
  gate: { color: 'warning' },
  output: { color: 'success' },
  branch: { color: 'suggestion' },
  head: { bold: true },
  note: { dimColor: true },
}

/** 担い手の色 */
const ACTOR_COLOR: Record<FlowActor, string | undefined> = {
  ai: 'claude',
  human: 'warning',
  script: 'suggestion',
  subagent: 'permission',
  unknown: undefined,
}

/** 担い手の色の見方 */
const Legend = ({ Text }: { Text: TextElement }) => (
  <Text wrap="truncate">
    <Text color={ACTOR_COLOR.ai}>AI</Text>
    <Text dimColor> · </Text>
    <Text color={ACTOR_COLOR.human}>人</Text>
    <Text dimColor> · </Text>
    <Text color={ACTOR_COLOR.script}>スクリプト</Text>
    <Text dimColor> · </Text>
    <Text color={ACTOR_COLOR.subagent}>サブエージェント</Text>
    <Text dimColor> · </Text>
    <Text color="warning">⏸ 承認</Text>
    <Text dimColor> · </Text>
    <Text color="success">▸ 成果物</Text>
  </Text>
)

const FlowRow = ({ Text, line }: { Text: TextElement; line: FlowLine }) => (
  <Text wrap="truncate">
    {/* 空の行も1行の高さを取るよう、空白を置く */}
    {line.segs.length === 0 ? ' ' : null}
    {line.segs.map((seg: FlowSeg, i: number) => (
      <Text
        key={String(i)}
        {...FLOW_STYLE[seg.tone]}
        {...(seg.actor === undefined ? {} : { color: ACTOR_COLOR[seg.actor], bold: true })}
      >
        {seg.text}
      </Text>
    ))}
  </Text>
)
