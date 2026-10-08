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
  isNewRequest,
  oneLine,
  resolveSummaryModel,
  seconds,
  shortModel,
  summaryPrompt,
} from './describe'
import { BLINK_EVERY, BLINK_FOR, CLAWD_COLUMNS, clawdFrame } from './clawd'
import {
  MAP_MIN_WIDTH,
  TICK_MS,
  buildScene,
  fit,
  formatTokens,
  hueOf,
  isSceneAnimating,
  layoutMap,
  mainMood,
  type MapLine,
  type MapSeg,
  type MapTone,
} from './map'
import { agentStatus, layoutTree, type TreeLine } from './tree'

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
const requestAtom = atom({ plugin: 'cc-work-log', key: 'requestAt' } as const, null as number | null)
const selectedAtom = atom({ plugin: 'cc-work-log', key: 'selected' } as const, null as string | null)

const push = async ($: EngineInterface, entry: Omit<WorkLogEntry, 'at'>): Promise<void> => {
  const at = await $.clock.now()
  await update($, entries, list => appendEntry(list, { ...entry, at }))
  // サブエージェントが最後に動いた時刻を覚える(ログは直近 50 件しか残らないので、ログからは求めない)
  const agentId = entry.agentId
  if (agentId !== undefined) {
    await update($, agents, map => {
      const agent = map[agentId]
      return typeof agent === 'object' && agent !== null ? { ...map, [agentId]: { ...agent, lastActiveAt: at } } : map
    })
  }
}

const setStatus = async ($: EngineInterface, id: string, status: WorkLogEntry['status']) => {
  await update($, entries, list => list.map(one => (one.id === id ? { ...one, status } : one)))
}

/** 見せ方のタブ。並び順、名前、押すキー */
const VIEW_TABS: ReadonlyArray<{ view: WorkLogView; label: string; hotkey: string }> = [
  { view: 'list', label: '一覧', hotkey: '1' },
  { view: 'tree', label: 'ツリー', hotkey: '2' },
  { view: 'map', label: 'マップ', hotkey: '3' },
]

const isView = (value: unknown): value is WorkLogView => value === 'list' || value === 'tree' || value === 'map'

const errorText = (err: unknown): string => oneLine(err instanceof Error ? err.message : String(err), 120)

// マップの描き直しのタイマー。動いているものがあるあいだだけ回す。ホットリロードではエンジンが止める
let ticker: Timer | undefined

const stopTicker = (): void => {
  ticker?.cancel()
  ticker = undefined
}

// 止まっているあいだも、キャラのまばたきの瞬間だけ描き直すタイマー
let blinker: Timer | undefined

/**
 * 描き直しのタイマーの1回ぶん。マップが見えていれば描き直しを頼むだけにする。
 * 続けるか止めるかは、描く側(場面を組み立てたところ)で決める
 */
const tick = async ($: EngineInterface, configView: WorkLogView): Promise<void> => {
  const view = (await read($, viewAtom)) ?? configView
  const shown = view === 'map' && (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
  if (!shown) {
    stopTicker()
    return
  }
  $.ui.invalidate('ui.render')
}

/** 動きが無いときに、次のまばたきの始まりと終わりに1回ずつ描き直す。描き直した先でまた次を頼むので、見えているあいだ続く */
const scheduleBlink = ($: EngineInterface, now: number): void => {
  if (blinker !== undefined) return
  blinker = $.clock.after(BLINK_EVERY - (now % BLINK_EVERY), () => {
    blinker = undefined
    $.ui.invalidate('ui.render')
    void $.clock.after(BLINK_FOR, () => $.ui.invalidate('ui.render'))
  })
}

/** 新しい依頼の区切りを付ける。マップをその依頼のぶんに切り替え、開いていた詳細を閉じる */
const startRequest = async ($: EngineInterface): Promise<void> => {
  const at = await $.clock.now()
  await update($, requestAtom, () => at)
  await update($, selectedAtom, () => null)
}

// メインのモデルは /model で変わるので描くたびに聞くが、1秒に何度も描き直すあいだは少しだけ覚えておく
let modelCache: { value: string; at: number } | undefined
const MODEL_CACHE_MS = 2000

/** 何かが動き出したときに呼ぶ。マップを見ているときだけタイマーを立てる(ペインが隠れていれば、次の1回で止まる) */
const animate = ($: EngineInterface, configView: WorkLogView): void => {
  if (ticker !== undefined) return
  void (async () => {
    const view = (await read($, viewAtom)) ?? configView
    if (view !== 'map' || ticker !== undefined) return
    ticker = $.clock.every(TICK_MS, () => void tick($, configView).catch(stopTicker))
  })().catch(() => undefined)
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

  // 新しい依頼を受けたら、マップをその依頼のぶんに切り替え、開いていた詳細を閉じる。
  // ほかのフックが入力を取り下げたら区切らないよう、入力が受け付けられてから区切る
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    try {
      // 出どころの無い入力(古いエンジンや、テストの $.prompt.submit)は、新しい依頼として扱う
      if (result.drop === undefined && isNewRequest((e.origin as { kind?: string } | undefined)?.kind ?? 'composer')) {
        await startRequest($)
      }
    } catch {
      // 区切りが付けられなくても入力は止めない
    }
    return result
  }).catch(($, e, next) => next(e))

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
          // 続きとして同じ id で起動し直したものは、もとの番号を使い続ける(振り直すと次のものと番号が重なる)
          // 前の回のトークンも引き継ぎ、終えたときに足す
          const prior = map[agentId]
          agent = {
            ...agent,
            no: prior?.no ?? Object.keys(map).length + 1,
            ...(prior?.tokens === undefined ? {} : { tokens: prior.tokens }),
          }
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
          // トークンは、入力・出力・キャッシュの読み書きを合わせた数
          const usage = e.usage
          const tokens =
            usage === undefined
              ? undefined
              : usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
          return {
            ...map,
            [agentId]: {
              ...agent,
              status,
              durationMs: e.durationMs,
              endedAt,
              ...(tokens === undefined ? {} : { tokens: (agent.tokens ?? 0) + tokens }),
              ...(e.answer === '' ? {} : { answer: oneLine(e.answer, 400) }),
            },
          }
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
    const drawnAt = await $.clock.now()
    if (modelCache === undefined || drawnAt - modelCache.at >= MODEL_CACHE_MS) {
      modelCache = { value: await $.session.model().catch(() => ''), at: drawnAt }
    }
    const mainModel = modelCache.value
    const width = Math.max(10, e.props.bodyColumns)
    // 見出しの1行を除いた行数。最新の行が見えるよう、入るぶんだけ後ろから出す
    const room = Math.max(1, e.props.scroll.bodyRows - 1)

    // 見せ方は3つのタブで切り替える。今見ているタブは強調し、ほかは薄く出す
    const header = (
      <Box flexDirection="row" gap={1}>
        {VIEW_TABS.map(tab =>
          tab.view === view ? (
            <Button key={`view:${tab.view}`} hotkey={tab.hotkey} variant="primary" onPress={() => undefined}>
              {tab.label}
            </Button>
          ) : (
            <Button
              key={`view:${tab.view}`}
              hotkey={tab.hotkey}
              dimColor
              onPress={async () => {
                await update($, viewAtom, () => tab.view)
                // 開いていた詳細は閉じる。マップに戻ったときは、詳細ではなくマップを出す
                await update($, selectedAtom, () => null)
                animate($, configView)
              }}
            >
              {tab.label}
            </Button>
          ),
        )}
        <Text dimColor wrap="truncate">
          1・2・3 で切り替え{view === 'list' && mainModel !== '' ? `  メイン: ${shortModel(mainModel)}` : ''}
        </Text>
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
      const since = await read($, requestAtom)
      const selected = await read($, selectedAtom)
      const chosen = selected === null ? undefined : known[selected]
      // 場面は描くたびに1回だけ組み立て、配置とキャラの様子で使い回す
      const scene = buildScene(list, known, since, now)
      // 動きがあればタイマーを立てる(ペインを隠して出し直したときも、ここで立て直る)。止まったら止め、キャラのまばたきだけ続ける
      if (isSceneAnimating(scene, now)) {
        animate($, configView)
      } else {
        stopTicker()
        if (e.surface === 'terminal') scheduleBlink($, now)
      }
      if (width < MAP_MIN_WIDTH) {
        return (
          <Box flexDirection="column" width={width}>
            {header}
            <Text dimColor wrap="wrap">
              マップは幅 {MAP_MIN_WIDTH} マス以上で出します
            </Text>
          </Box>
        )
      }
      const open = (id: string) => async () => {
        await update($, selectedAtom, () => id)
      }

      // 箱を押したら、そのサブエージェントが何をしたかを出す
      if (selected !== null && typeof chosen === 'object' && chosen !== null) {
        // 結果は3行ぶんまでにし、残りの高さをしたことの一覧に回す(長い結果で一覧が押し出されないように)
        // 「結果: 」の6マスと、行末で2マスの文字が折り返すぶん(1行に1マス)を見込んで切る
        const answer = chosen.answer === undefined ? undefined : fit(chosen.answer, Math.max(10, width * 3 - 6 - 3))
        const listRows = Math.max(1, room - 5 - (answer === undefined ? 0 : 3))
        // 状態を持たない古い記録も、マップと同じ判定(ターン終了の行があれば終えた)にそろえる
        const status = agentStatus(chosen, selected, list)
        const done = status !== 'running'
        // そのエージェントのツールの呼び出しと、終えた行(起動したサブエージェントの行も含む)
        const work = list.filter(one => one.agentId === selected && one.kind !== 'summary' && one.kind !== 'notice')
        const facts = [
          chosen.model === '' ? 'モデル不明' : shortModel(chosen.model),
          done
            ? `${status === 'ok' ? '✓' : '✗'}${chosen.durationMs === undefined ? '' : ` ${seconds(chosen.durationMs)}`}`
            : '実行中',
          ...(chosen.tokens === undefined ? [] : [`${formatTokens(chosen.tokens)} トークン`]),
        ]
        return (
          <Box flexDirection="column" width={width}>
            {header}
            <Box flexDirection="row" gap={1}>
              <Button key="close-detail" hotkey="b" onPress={() => void update($, selectedAtom, () => null)}>
                マップに戻る
              </Button>
            </Box>
            <Text wrap="truncate">
              <Text dimColor>#{chosen.no} </Text>
              <Text bold color={TYPE_COLORS[hueOf(chosen.type) % TYPE_COLORS.length]}>
                {chosen.type}
              </Text>
              <Text dimColor> · {facts.join(' · ')}</Text>
            </Text>
            <Text wrap="truncate">
              <Text dimColor>頼まれたこと: </Text>
              {chosen.name}
            </Text>
            <Text dimColor>したこと({work.length} 件)</Text>
            {work.slice(-listRows).map(one => (
              <Text key={one.id} wrap="truncate">
                <Text dimColor>{formatTime(one.at)} </Text>
                <Text color={MARK_COLOR[one.status ?? 'running']}>{MARK[one.status ?? 'running']}</Text> {one.text}
              </Text>
            ))}
            {answer === undefined ? null : (
              <Text wrap="wrap">
                <Text dimColor>結果: </Text>
                {answer}
              </Text>
            )}
          </Box>
        )
      }

      // ターミナルでは、メインのカードの中の左に Claude のキャラ(Raster)を置く。Raster の無い面では文字だけのマップにする
      if (e.surface === 'terminal') {
        const { Raster } = $.ui.resolve(e)
        const lines = layoutMap(list, known, mainModel, now, room, width, { avatar: CLAWD_COLUMNS, scene })
        const inside = lines.filter(line => line.key.startsWith('hub:in:'))
        const firstInside = lines.findIndex(line => line.key.startsWith('hub:in:'))
        const before = lines.slice(0, firstInside)
        const after = lines.slice(firstInside + inside.length)
        return (
          <Box flexDirection="column" width={width}>
            {header}
            {before.map(line => (
              <MapRow key={line.key} Box={Box} Text={Text} Button={Button} open={open} line={line} />
            ))}
            <Box flexDirection="row">
              <Box flexDirection="column">
                {inside.map(line => (
                  <MapRow key={line.key} Box={Box} Text={Text} Button={Button} open={open} line={{ key: line.key, segs: line.left ?? [] }} />
                ))}
              </Box>
              <Raster key="clawd" {...clawdFrame(mainMood(scene, now), now)} />
              <Box flexDirection="column">
                {inside.map(line => (
                  <MapRow key={line.key} Box={Box} Text={Text} Button={Button} open={open} line={{ key: line.key, segs: line.right ?? [] }} />
                ))}
              </Box>
            </Box>
            {after.map(line => (
              <MapRow key={line.key} Box={Box} Text={Text} Button={Button} open={open} line={line} />
            ))}
          </Box>
        )
      }
      // ほかの面(デスクトップなど)ではボタンがネイティブの形になり、箱の罫線の並びが崩れる。
      // 箱の中の番号は文字のままにし、詳細を開くボタンはマップの下に並べる
      const lines = layoutMap(list, known, mainModel, now, Math.max(1, room - 1), width, { scene })
      const drawn = [...new Set(lines.flatMap(line => line.segs.flatMap(seg => (seg.press === undefined ? [] : [seg.press]))))]
      return (
        <Box flexDirection="column" width={width}>
          {header}
          {lines.map(line => (
            <MapRow key={line.key} Box={Box} Text={Text} Button={Button} open={open} line={line} pressable={false} />
          ))}
          {drawn.length === 0 ? null : (
            <Box flexDirection="row" gap={1}>
              <Text dimColor>詳細:</Text>
              {drawn.map(id => (
                <Button key={`open:${id}`} dimColor onPress={open(id)}>
                  {`#${known[id]?.no ?? '?'}`}
                </Button>
              ))}
            </Box>
          )}
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
  tool: { dimColor: true, italic: true },
  timeLive: { color: 'claude' },
  note: { dimColor: true },
  more: { dimColor: true },
}

/** エージェントの種類の色。種類ごとに hueOf で決まった番号の色を使う */
const TYPE_COLORS: readonly string[] = ['permission', 'suggestion', 'remember', 'merged', 'autoAccept', 'planMode']

type ButtonElement = ReturnType<EngineInterface['ui']['resolve']>['Button']
type BoxElement = ReturnType<EngineInterface['ui']['resolve']>['Box']

/** マップの1行。press の付いた区切りは、押すとそのエージェントの詳細を開くボタンにする */
const MapRow = ({
  Box,
  Text,
  Button,
  open,
  line,
  pressable = true,
}: {
  Box: BoxElement
  Text: TextElement
  Button: ButtonElement
  open: (id: string) => () => Promise<void>
  line: MapLine
  /** false なら押せる区切りもただの文字にする(ネイティブのボタンで罫線の並びが崩れる面のため) */
  pressable?: boolean
}) => {
  const styled = (seg: MapSeg, i: number) => (
    <Text
      key={String(i)}
      {...MAP_STYLE[seg.tone]}
      {...(seg.hue === undefined ? {} : { color: TYPE_COLORS[seg.hue % TYPE_COLORS.length] })}
    >
      {seg.text}
    </Text>
  )
  if (!pressable || !line.segs.some(seg => seg.press !== undefined)) {
    return (
      <Text wrap="truncate">
        {/* 空の行も1行の高さを取るよう、空白を置く */}
        {line.segs.length === 0 ? ' ' : null}
        {line.segs.map(styled)}
      </Text>
    )
  }
  // 押せる区切りの続きを1つのボタンにまとめ、ほかは Text のまま横に並べる
  const runs: Array<{ press?: string; segs: MapSeg[] }> = []
  for (const seg of line.segs) {
    const last = runs.at(-1)
    if (last !== undefined && last.press === seg.press) last.segs.push(seg)
    else runs.push({ press: seg.press, segs: [seg] })
  }
  return (
    <Box flexDirection="row">
      {runs.map((run, i) =>
        run.press === undefined ? (
          <Text key={`t${i}`} wrap="truncate">
            {run.segs.map(styled)}
          </Text>
        ) : (
          <Button key={`open:${run.press}`} plain onPress={open(run.press)}>
            {run.segs.map(seg => seg.text).join('')}
          </Button>
        ),
      )}
    </Box>
  )
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** ms → "14:05"(実行環境のローカル時刻) */
const formatTime = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
