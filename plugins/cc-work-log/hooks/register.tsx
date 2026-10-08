import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { WorkLogEntry, WorkLogSummaryStop } from '../types'
import {
  SUMMARY_SYSTEM,
  appendEntry,
  currentTurnEntries,
  describeTool,
  describeTurnEnd,
  oneLine,
  resolveSummaryModel,
  summaryPrompt,
} from './describe'

const PANE = 'cc-work-log'
const COMMAND = 'cc-work-log'

// セッションの値は $.state に置く(ホットリロードでモジュール変数は消えるため)
const entries = atom({ plugin: 'cc-work-log', key: 'entries' } as const, [] as WorkLogEntry[])
const agents = atom({ plugin: 'cc-work-log', key: 'agents' } as const, {} as Record<string, string>)
const cwdAtom = atom({ plugin: 'cc-work-log', key: 'cwd' } as const, '')
const summaryStop = atom(
  { plugin: 'cc-work-log', key: 'summaryStop' } as const,
  null as WorkLogSummaryStop | null,
)

const push = async ($: EngineInterface, entry: Omit<WorkLogEntry, 'at'>): Promise<void> => {
  const at = await $.clock.now()
  await update($, entries, list => appendEntry(list, { ...entry, at }))
}

const setStatus = async ($: EngineInterface, id: string, status: WorkLogEntry['status']) => {
  await update($, entries, list => list.map(one => (one.id === id ? { ...one, status } : one)))
}

const errorText = (err: unknown): string => oneLine(err instanceof Error ? err.message : String(err), 120)

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

    return { text: '作業ログのペインを開きました' }
  }).catch(() => ({ text: '作業ログのペインを開けませんでした' }))

  // 見るだけ。呼び出しはそのまま通し、結果も変えない
  on('tool.call', async ($, e, next) => {
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
    } catch {
      // ログが書けなくてもツールは止めない
    }

    const result = await next(e)
    try {
      await setStatus($, id, result.deny !== undefined || result.isError === true ? 'error' : 'ok')
    } catch {
      // 同上
    }

    return result
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    try {
      if (result.deny === undefined && result.agentId !== undefined) {
        const label = oneLine(e.description !== '' ? e.description : e.subagentType, 30)
        const agentId = result.agentId
        await update($, agents, map => ({ ...map, [agentId]: label }))
        const list = await read($, entries)
        // Agent ツールの呼び出しはすでに「…を起動」の行がある。ワークフローなどツールを介さない起動だけ行を足す
        const hasToolLine = e.workflow === undefined && list.some(one => one.id === e.tool_use_id)
        if (!hasToolLine) {
          await push($, {
            id: `spawn:${agentId}`,
            kind: 'agent',
            text: `サブエージェント『${label}』(${e.subagentType})を起動`,
            status: 'ok',
            agentId: e.parentAgentId,
          })
        }
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
        agentId: e.agentId,
      })
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
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, entries)
    const names = await read($, agents)
    const width = Math.max(10, e.props.bodyColumns)
    // 最新の行が見えるよう、入るぶんだけ後ろから出す
    const room = Math.max(1, e.props.scroll.bodyRows)

    if (list.length === 0) {
      return (
        <Box flexDirection="column" width={width}>
          <Text dimColor>まだ作業はありません</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={width}>
        {list.slice(-room).map(one => {
          const time = formatTime(one.at)
          const who =
            one.agentId === undefined ? '' : `↳ ${names[one.agentId] ?? 'サブエージェント'}: `
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

const pad = (n: number): string => String(n).padStart(2, '0')

/** ms → "14:05"(実行環境のローカル時刻) */
const formatTime = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
