import type { WorkLogAgent, WorkLogEntry } from '../types'

/** ペインに残す件数 */
export const MAX_ENTRIES = 50

const MAX_ARG = 60

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** 1行に収まるよう、改行を空白にして長さを切る */
export const oneLine = (value: string, max = MAX_ARG): string => {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** 作業ディレクトリの下なら相対パスにする */
export const shortPath = (path: string, cwd: string): string => {
  if (cwd !== '' && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1)
  return path
}

const code = (value: string): string => `\`${value}\``

/** ひらがな・カタカナ・漢字を含むか */
export const hasJapanese = (value: string): boolean => /[\u3040-\u30ff\u3400-\u9fff]/.test(value)

/** ログに出さないツール。SubagentHandback はサブエージェントが報告を返す仕組みで、作業ではない */
export const HIDDEN_TOOLS: readonly string[] = ['SubagentHandback']

/** モデル ID を短くする(claude-haiku-5-5 → haiku-5-5、日付の付いた ID は日付を落とす) */
export const shortModel = (model: string): string =>
  model.replace(/^claude-/, '').replace(/-\d{8}$/, '')

/** サブエージェントの行頭に付ける名前。例 `#1 Explore·haiku-5-5` */
export const agentLabel = (agent: WorkLogAgent): string =>
  `#${agent.no} ${agent.type}${agent.model === '' ? '' : `·${shortModel(agent.model)}`}`

/** サブエージェントの起動の行 */
export const describeSpawn = (agent: WorkLogAgent): string =>
  `サブエージェント ${agentLabel(agent)}『${agent.name}』を起動`

/**
 * ツールの呼び出しを日本語の1行にする。
 * 決まった言い回しに当てはめるだけなので、同じ入力なら同じ文になる。
 */
export const describeTool = (tool: string, args: Record<string, unknown>, cwd: string): string => {
  const path = (key = 'file_path') => code(oneLine(shortPath(text(args[key]), cwd)))

  switch (tool) {
    case 'Read':
      return `${path()} を読む`
    case 'Write':
      return `${path()} を書き込む`
    case 'Edit':
    case 'MultiEdit':
      return `${path()} を編集`
    case 'NotebookEdit':
      return `ノートブック ${path('notebook_path')} を編集`
    case 'Bash': {
      // description は「何をするコマンドか」の平易な説明。日本語でなければ使わず、コマンドそのものを出す
      const description = oneLine(text(args.description))
      return hasJapanese(description) ? description : `${code(oneLine(text(args.command), 40))} を実行`
    }
    case 'Glob':
      return `ファイルを探す: ${code(oneLine(text(args.pattern)))}`
    case 'Grep':
      return `「${oneLine(text(args.pattern), 40)}」を検索`
    case 'WebFetch':
      return `${oneLine(text(args.url))} を取得`
    case 'WebSearch':
      return `「${oneLine(text(args.query), 40)}」をウェブ検索`
    case 'Agent':
    case 'Task':
      return `サブエージェント『${oneLine(text(args.description), 40)}』を起動`
    case 'Skill':
      return `スキル「${oneLine(text(args.skill), 40)}」を使う`
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'ToDo を更新'
    case 'AskUserQuestion':
      return 'ユーザーに質問'
    case 'ToolSearch':
      return `ツールを探す: ${oneLine(text(args.query), 40)}`
    case 'EnterPlanMode':
      return '計画モードに入る'
    case 'ExitPlanMode':
      return '計画を示す'
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
      if (mcp !== null) return `MCP ${mcp[1]} の ${mcp[2]} を呼ぶ`
      return `${tool} を使う`
    }
  }
}

const seconds = (ms: number): string => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${s % 60}秒`
}

/** ターンの終わり方を日本語にする */
export const describeTurnEnd = (reason: string, durationMs: number): string => {
  const how =
    reason === 'answer'
      ? '回答した'
      : reason === 'aborted'
        ? '中断された'
        : reason === 'refusal'
          ? '回答を断った'
          : 'エラーで終わった'
  return `${how}(${seconds(durationMs)})`
}

/** 新しい行を足して、古いものを捨てる */
export const appendEntry = (list: readonly WorkLogEntry[], entry: WorkLogEntry): WorkLogEntry[] =>
  [...list, entry].slice(-MAX_ENTRIES)

/** 要約のモデル。off なら undefined、custom で空なら '' */
export const resolveSummaryModel = (choice: string, custom: string): string | undefined => {
  if (choice === 'off' || choice === '') return undefined
  if (choice === 'custom') return custom.trim()
  return choice
}

/** 直前のメインのターン終了より後の行(=このターンの作業) */
export const currentTurnEntries = (list: readonly WorkLogEntry[]): WorkLogEntry[] => {
  let start = 0
  list.forEach((one, i) => {
    if (one.kind === 'turn' && one.agentId === undefined) start = i + 1
  })
  return list.slice(start)
}

export const SUMMARY_SYSTEM =
  'あなたは作業ログを要約する係です。渡されたログ(AI エージェントが行った操作の一覧)から、' +
  'このターンで何をしたかを日本語で1〜2文、合わせて80字以内で書いてください。前置きや箇条書きは不要です。'

/** 要約に渡す本文 */
export const summaryPrompt = (list: readonly WorkLogEntry[], agents: Record<string, WorkLogAgent>): string =>
  list
    .map(one => {
      const agent = one.agentId === undefined ? undefined : agents[one.agentId]
      const who = one.agentId === undefined ? '' : `[${agent === undefined ? 'サブエージェント' : agent.name}] `
      const mark = one.status === 'error' ? '(失敗)' : ''
      return `- ${who}${one.text}${mark}`
    })
    .join('\n')
