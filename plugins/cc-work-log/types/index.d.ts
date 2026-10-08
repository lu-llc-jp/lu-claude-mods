/** ログ1行の種類。tool: ツールの呼び出し、agent: サブエージェントの起動、turn: ターンの終了、summary: 要約、notice: mod からのお知らせ */
export type WorkLogKind = 'tool' | 'agent' | 'turn' | 'summary' | 'notice'

/** running: 実行中、ok: 成功、error: 失敗。tool と agent の行だけが持つ */
export type WorkLogStatus = 'running' | 'ok' | 'error'

export type WorkLogEntry = {
  /** 行の id。ツールの行は tool_use_id */
  id: string
  kind: WorkLogKind
  /** 表示する日本語の文 */
  text: string
  /** 出来事の時刻(ms) */
  at: number
  status?: WorkLogStatus
  /** サブエージェントの作業なら、その id。メインのエージェントなら無い */
  agentId?: string
}

/** 要約を止めたときの記録。同じモデルのあいだは要約しない */
export type WorkLogSummaryStop = { model: string; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'cc-work-log': {
      entries: WorkLogEntry[]
      /** サブエージェントの id → 表示名 */
      agents: Record<string, string>
      /** セッションの作業ディレクトリ。パスを短く出すのに使う */
      cwd: string
      summaryStop: WorkLogSummaryStop | null
    }
  }
}
