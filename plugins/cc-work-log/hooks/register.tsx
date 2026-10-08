import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { WorkLogAgent, WorkLogEntry, WorkLogStatus, WorkLogSummaryStop, WorkLogView } from '../types'
import {
  HIDDEN_TOOLS,
  SUMMARY_SYSTEM,
  agentLabel,
  appendEntry,
  currentTurnEntries,
  describeSpawn,
  describeTool,
  describeTurnEnd,
  oneLine,
  resolveSummaryModel,
  shortModel,
  summaryPrompt,
} from './describe'
import { TICK_MS, isMapAnimating, layoutMap, type MapLine, type MapTone } from './map'
import { layoutPixelMap } from './pixelmap'
import { layoutTree, type TreeLine } from './tree'

const PANE = 'cc-work-log'
const COMMAND = 'cc-work-log'

// セッションの値は $.state に置く(ホットリロードでモジュール変数は消えるため)
const entries = atom({ plugin: 'cc-work-log', key: 'entries' } as const, [] as WorkLogEntry[])
const agents = atom({ plugin: 'cc-work-log', key: 'agents' } as const, {} as Record<string, WorkLogAgent>)
const cwdAtom = atom({ plugin: 'cc-work-log', key: 'cwd' } as const, '')
const summaryStop = atom(
  { plugin: 'cc-work-log', key: 'summaryStop' } as const,
  null as WorkLogSummaryStop | null,
)
const viewAtom = atom({ plugin: 'cc-work-log', key: 'view' } as const, null as WorkLogView | null)

const push = async ($: EngineInterface, entry: Omit<WorkLogEntry, 'at'>): Promise<void> => {
  const at = await $.clock.now()
  await update($, entries, list => appendEntry(list, { ...entry, at }))
}

const setStatus = async ($: EngineInterface, id: string, status: WorkLogEntry['status']) => {
  await update($, entries, list => list.map(one => (one.id === id ? { ...one, status } : one)))
}

/** ボタンで回す見せ方の順と、そのボタンの文言(押すと次の見せ方になる) */
const NEXT_VIEW: Record<WorkLogView, WorkLogView> = { list: 'tree', tree: 'map', map: 'list' }
const VIEW_BUTTON: Record<WorkLogView, string> = { list: 'ツリーで見る', tree: 'マップで見る', map: '一覧で見る' }

const isView = (value: unknown): value is WorkLogView => value === 'list' || value === 'tree' || value === 'map'

const errorText = (err: unknown): string => oneLine(err instanceof Error ? err.message : String(err), 120)

// マップの描き直しのタイマー。動いているものがあるあいだだけ回す。ホットリロードではエンジンが止める
let ticker: Timer | undefined

const stopTicker = (): void => {
  ticker?.cancel()
  ticker = undefined
}

const tick = async ($: EngineInterface, configView: WorkLogView): Promise<void> => {
  const view = (await read($, viewAtom)) ?? configView
  const shown = view === 'map' && (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
  if (!shown) {
    stopTicker()
    return
  }
  // 止めるときも1回描き直し、最後の様子(粒が届いた・点が ✓ になった)を残す
  $.ui.invalidate('ui.render')
  if (!isMapAnimating(await read($, entries), await read($, agents), await $.clock.now())) stopTicker()
}

/** 何かが動き出したときに呼ぶ。マップを見ていなければ、次の1回で止まる */
const animate = ($: EngineInterface, configView: WorkLogView): void => {
  if (ticker !== undefined) return
  ticker = $.clock.every(TICK_MS, () => void tick($, configView).catch(stopTicker))
}

/** このターンの作業をモデルで要約し、ペインに1行足す。失敗しても作業ログは止めない */
const summarize = async (
  $: EngineInterface,
  model: string,
  turnId: string,
  list: readonly WorkLogEntry[],
): Promise<void> => {
  const stop = async (reason: string) => {
    await update($, summaryStop, () => ({ model, reason }))
    await push($, { id: `summary-stop:${turnId}`, kind: 'notice', text: `要約を止めました(${model}): ${reason}` })
  }

  const stopped = await read($, summaryStop)
  if (stopped !== null && stopped.model === model) return
  if (model === '') {
    await stop('summaryModelCustom が空です')
    return
  }

  let result: Awaited<ReturnType<EngineInterface['model']['complete']>>
  try {
    result = await $.model.complete({
      model,
      system: SUMMARY_SYSTEM,
      prompt: summaryPrompt(list, await read($, agents)),
      maxTokens: 300,
      effort: 'low',
      timeoutMs: 30_000,
    })
  } catch (err) {
    // 送る前に断られた(モデルが無い・組織が許可していない など)。設定を直すまで止める
    await stop(errorText(err))
    return
  }

  if (result.isAnswered) {
    await push($, { id: `summary:${turnId}`, kind: 'summary', text: oneLine(result.text, 200) })
    return
  }
  if (result.reason === 'api-error') {
    const reason = `API エラー(${result.status ?? '応答なし'} ${result.error})`
    // 4xx はモデル名や権限の問題で、繰り返しても直らない。混雑や一時的な障害なら次のターンでまた試す
    if (result.status !== null && result.status >= 400 && result.status < 500 && result.status !== 429) {
      await stop(reason)
    } else {
      await push($, { id: `summary:${turnId}`, kind: 'notice', text: `今回は要約できませんでした: ${reason}` })
    }
    return
  }
  const reason = result.reason === 'empty-reply' ? '空の応答' : '時間切れ・中断'
  await push($, { id: `summary:${turnId}`, kind: 'notice', text: `今回は要約できませんでした: ${reason}` })
}

export const register: Register = (on, options) => {
  const summaryModel = resolveSummaryModel(
    String(options.summaryModel ?? 'off'),
    String(options.summaryModelCustom ?? ''),
  )
  const configView: WorkLogView = isView(options.view) ? options.view : 'list'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'エージェントの作業ログを日本語でペインに表示する',
    })
    await update($, cwdAtom, () => e.cwd)

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await $.ui.open({ id: PANE, title: '作業ログ' })
    animate($, configView)

    return { text: '作業ログのペインを開きました' }
  }).catch(() => ({ text: '作業ログのペインを開けませんでした' }))

  // 見るだけ。呼び出しはそのまま通し、結果も変えない
  on('tool.call', async ($, e, next) => {
    if (HIDDEN_TOOLS.includes(String(e.tool))) return next(e)
    const args = e as unknown as Record<string, unknown>
    const id = e.tool_use_id
    try {
      const cwd = await read($, cwdAtom)
      await push($, {
        id,
        kind: 'tool',
        text: describeTool(String(e.tool), args, cwd),
        status: 'running',
        agentId: e.agentId,
      })
      animate($, configView)
    } catch {
      // ログが書けなくてもツールは止めない
    }

    const result = await next(e)
    try {
      await setStatus($, id, result.deny !== undefined || result.isError === true ? 'error' : 'ok')
      animate($, configView)
    } catch {
      // 同上
    }

    return result
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    try {
      if (result.deny === undefined && result.agentId !== undefined) {
        const agentId = result.agentId
        const known = await read($, agents)
        const list = await read($, entries)
        // Agent ツールの呼び出しはすでに「…を起動」の行がある。種類とモデルはここで分かるので、その行を書き換える。
        // ワークフローなどツールを介さない起動だけ行を足す
        const hasToolLine = e.workflow === undefined && list.some(one => one.id === e.tool_use_id)
        const startedAt = await $.clock.now()
        let agent: WorkLogAgent = {
          no: Object.keys(known).length + 1,
          name: oneLine(e.description !== '' ? e.description : e.subagentType, 30),
          type: e.subagentType,
          model: result.model,
          parentId: e.parentAgentId,
          spawnEntryId: hasToolLine ? e.tool_use_id : `spawn:${agentId}`,
          status: 'running',
          startedAt,
        }
        // 通し番号は書き込む時点の数で決める。同時に起動すると、先に読んだ数では同じ番号が付くため
        await update($, agents, map => {
          agent = { ...agent, no: Object.keys(map).length + 1 }
          return { ...map, [agentId]: agent }
        })
        if (hasToolLine) {
          const text = describeSpawn(agent)
          await update($, entries, all => all.map(one => (one.id === e.tool_use_id ? { ...one, text } : one)))
        } else {
          await push($, {
            id: `spawn:${agentId}`,
            kind: 'agent',
            text: describeSpawn(agent),
            status: 'ok',
            agentId: e.parentAgentId,
          })
        }
        animate($, configView)
      }
    } catch {
      // ログが書けなくても起動は止めない
    }

    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    try {
      const end = describeTurnEnd(e.reason, e.durationMs)
      await push($, {
        id: `turn:${e.turnId}:${e.agentId ?? 'main'}`,
        kind: 'turn',
        text: e.agentId === undefined ? end : `作業を終えた(${end})`,
        status: e.reason === 'answer' ? 'ok' : 'error',
        agentId: e.agentId,
      })
      if (e.agentId !== undefined) {
        const agentId = e.agentId
        const status: WorkLogStatus = e.reason === 'answer' ? 'ok' : 'error'
        const endedAt = await $.clock.now()
        await update($, agents, map => {
          const agent = map[agentId]
          if (typeof agent !== 'object' || agent === null) return map
          return { ...map, [agentId]: { ...agent, status, durationMs: e.durationMs, endedAt } }
        })
        animate($, configView)
      }
      if (e.agentId === undefined && summaryModel !== undefined) {
        // ターンの終わりを待たせないよう、要約は後ろで行う。いま足したターン終了の行より前が、このターンの作業
        const model = summaryModel
        const turnId = e.turnId
        const list = currentTurnEntries((await read($, entries)).slice(0, -1)).filter(
          one => one.kind === 'tool' || one.kind === 'agent',
        )
        if (list.length > 0) {
          await $.clock.after(0, () => void summarize($, model, turnId, list).catch(() => undefined))
        }
      }
    } catch {
      // ログが書けなくてもターンは終える
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, entries)
    const known = await read($, agents)
    const view = (await read($, viewAtom)) ?? configView
    // メインのモデルは /model で変わるので、描くたびに聞く
    const mainModel = await $.session.model().catch(() => '')
    const width = Math.max(10, e.props.bodyColumns)
    // 見出しの1行を除いた行数。最新の行が見えるよう、入るぶんだけ後ろから出す
    const room = Math.max(1, e.props.scroll.bodyRows - 1)

    const header = (
      <Box flexDirection="row" gap={1}>
        <Button
          key="toggle-view"
          hotkey="v"
          dimColor
          onPress={async () => {
            await update($, viewAtom, () => NEXT_VIEW[view])
            animate($, configView)
          }}
        >
          {VIEW_BUTTON[view]}
        </Button>
        {view === 'list' && mainModel !== '' ? (
          <Text dimColor wrap="truncate">
            メイン: {shortModel(mainModel)}
          </Text>
        ) : null}
      </Box>
    )

    if (list.length === 0) {
      return (
        <Box flexDirection="column" width={width}>
          {header}
          <Text dimColor>まだ作業はありません</Text>
        </Box>
      )
    }

    if (view === 'tree') {
      return (
        <Box flexDirection="column" width={width}>
          {header}
          {layoutTree(list, known, mainModel, room).map(line => (
            <TreeRow key={line.key} Text={Text} line={line} />
          ))}
        </Box>
      )
    }

    if (view === 'map') {
      const now = await $.clock.now()
      // ドット絵の Raster はターミナルにしかないので、ほかの面では文字のマップを出す
      if (e.surface === 'terminal') {
        const { Raster } = $.ui.resolve(e)
        const { raster, lines } = layoutPixelMap(list, known, mainModel, now, room, width)
        return (
          <Box flexDirection="column" width={width}>
            {header}
            <Box flexDirection="row" gap={2}>
              <Raster key="map-pixels" {...raster} />
              <Box flexDirection="column" flexGrow={1}>
                {lines.map(line => (
                  <MapRow key={line.key} Text={Text} line={line} />
                ))}
              </Box>
            </Box>
          </Box>
        )
      }
      return (
        <Box flexDirection="column" width={width}>
          {header}
          {layoutMap(list, known, mainModel, now, room, width).map(line => (
            <MapRow key={line.key} Text={Text} line={line} />
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={width}>
        {header}
        {list.slice(-room).map(one => {
          const time = formatTime(one.at)
          const agent = one.agentId === undefined ? undefined : known[one.agentId]
          // 古い版で覚えた名前(文字列)が残っていても描けるようにする
          const who =
            one.agentId === undefined
              ? ''
              : `↳ ${typeof agent === 'object' ? agentLabel(agent) : 'サブエージェント'} `
          if (one.kind === 'turn') {
            return (
              <Text key={one.id} dimColor wrap="truncate">
                {time} {who}── {one.text}
              </Text>
            )
          }
          if (one.kind === 'summary') {
            return (
              <Text key={one.id} color="suggestion" wrap="wrap">
                {time} 要約: {one.text}
              </Text>
            )
          }
          if (one.kind === 'notice') {
            return (
              <Text key={one.id} color="warning" wrap="wrap">
                {time} {one.text}
              </Text>
            )
          }
          const mark = one.status === 'ok' ? '✓' : one.status === 'error' ? '✗' : '…'
          const color = one.status === 'ok' ? 'success' : one.status === 'error' ? 'error' : undefined
          return (
            <Text key={one.id} wrap="truncate">
              <Text dimColor>{time} </Text>
              <Text color={color}>{mark}</Text> {who === '' ? '' : <Text color="permission">{who}</Text>}
              {one.text}
            </Text>
          )
        })}
      </Box>
    )
  })
}

const MARK = { running: '…', ok: '✓', error: '✗' } as const
const MARK_COLOR = { running: undefined, ok: 'success', error: 'error' } as const

type TextElement = ReturnType<EngineInterface['ui']['resolve']>['Text']

/** ツリーの1行。罫線は薄く、状態の印は色で、サブエージェントの枝は名前の色で出す */
const TreeRow = ({ Text, line }: { Text: TextElement; line: TreeLine }) => {
  const mark = line.status === undefined ? null : <Text color={MARK_COLOR[line.status]}>{MARK[line.status]}</Text>
  const note = line.note === undefined ? null : <Text dimColor> {line.note}</Text>
  switch (line.tone) {
    case 'root':
      return (
        <Text wrap="truncate">
          {/* 根はターンの数だけ並ぶので、終えたターンには時刻を添えて見分ける */}
          {line.at === undefined ? null : <Text dimColor>{formatTime(line.at)} </Text>}
          <Text bold>{line.text}</Text> {mark}
          {note}
        </Text>
      )
    case 'agent':
      return (
        <Text wrap="truncate">
          <Text dimColor>{line.guide}</Text>
          <Text color="permission">{line.text}</Text> {mark}
          {note}
        </Text>
      )
    case 'turn':
      return (
        <Text dimColor wrap="truncate">
          {line.at === undefined ? '' : `${formatTime(line.at)} `}
          {mark}
          {mark === null ? '' : ' '}
          {line.text}
        </Text>
      )
    case 'summary':
      return (
        <Text color="suggestion" wrap="truncate">
          {line.guide}要約: {line.text}
        </Text>
      )
    case 'notice':
      return (
        <Text color="warning" wrap="truncate">
          {line.guide}
          {line.text}
        </Text>
      )
    case 'more':
      return <Text dimColor>{line.text}</Text>
    default:
      return (
        <Text wrap="truncate">
          <Text dimColor>{line.guide}</Text>
          {mark}
          {mark === null ? '' : ' '}
          {line.text}
          {note}
        </Text>
      )
  }
}

type MapStyle = { color?: string; dimColor?: boolean; bold?: boolean; italic?: boolean }

/** マップの色分け。線は薄く、動いているもの(粒・光・スピナー・メインの枠)だけに色を載せる。色はテーマのキーにして、明るいテーマでも読めるようにする */
const MAP_STYLE: Record<MapTone, MapStyle> = {
  edge: { color: 'subtle' },
  live: { color: 'claude' },
  flow: { color: 'claude', bold: true },
  flowTrail: { color: 'claude' },
  back: { color: 'success', bold: true },
  backTrail: { color: 'success' },
  hub: { color: 'claude' },
  hubIdle: { color: 'subtle' },
  hubFlash: { color: 'success', bold: true },
  title: { bold: true },
  spin: { color: 'claude', bold: true },
  ok: { color: 'success' },
  error: { color: 'error' },
  no: { dimColor: true },
  type: { bold: true },
  label: {},
  labelDone: { dimColor: true },
  cursor: { color: 'claude' },
  tool: { dimColor: true, italic: true },
  timeLive: { color: 'claude' },
  note: { dimColor: true },
  more: { dimColor: true },
}

/** エージェントの種類の色。種類ごとに hueOf で決まった番号の色を使う */
const TYPE_COLORS: readonly string[] = ['permission', 'suggestion', 'remember', 'merged', 'autoAccept', 'planMode']

/** マップの1行 */
const MapRow = ({ Text, line }: { Text: TextElement; line: MapLine }) => (
  <Text wrap="truncate">
    {line.segs.map((seg, i) => (
      <Text
        key={String(i)}
        {...MAP_STYLE[seg.tone]}
        {...(seg.hue === undefined ? {} : { color: TYPE_COLORS[seg.hue % TYPE_COLORS.length] })}
      >
        {seg.text}
      </Text>
    ))}
  </Text>
)

const pad = (n: number): string => String(n).padStart(2, '0')

/** ms → "14:05"(実行環境のローカル時刻) */
const formatTime = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
