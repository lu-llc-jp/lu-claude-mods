/** ログ1行の種類。tool: ツールの呼び出し、agent: サブエージェントの起動、turn: ターンの終了、summary: 要約、notice: mod からのお知らせ */
export type WorkLogKind = 'tool' | 'agent' | 'turn' | 'summary' | 'notice'

/** running: 実行中、ok: 成功、error: 失敗。tool と agent の行と、0.3 からはターン終了の行(回答した・それ以外)が持つ */
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

/** 起動したサブエージェント */
export type WorkLogAgent = {
  /** セッションの中での通し番号(1から) */
  no: number
  /** Agent ツールの description(短い説明) */
  name: string
  /** エージェントの種類(general-purpose、Explore など) */
  type: string
  /** 動いているモデル。分からなければ '' */
  model: string
  /** 起動したエージェントの id。メインから起動したなら無い */
  parentId?: string
  /** 起動を記録した行の id。ツリーでは、この行の位置に枝を出す */
  spawnEntryId?: string
  /** running: 実行中、ok: 回答して終えた、error: 中断・エラーで終えた。0.2 以前に覚えたものには無い */
  status?: WorkLogStatus
  /** 終えたときの所要時間(ms) */
  durationMs?: number
  /** 起動した時刻(ms)。マップで依頼の粒を流すのに使う。0.3 以前に覚えたものには無い */
  startedAt?: number
  /** 終えた時刻(ms)。マップで結果の粒を流すのに使う。0.3 以前に覚えたものには無い */
  endedAt?: number
  /** 消費トークン(入力・出力・キャッシュの読み書きの合計)。同じ id で起動し直したものは、各回の合計。0.10 以前に覚えたものには無い */
  tokens?: number
  /** 終えたときの回答の先頭。マップの詳細に出す。0.10 以前に覚えたものには無い */
  answer?: string
  /** 最後にツールを使った時刻(ms)。長く動きの無い実行中のものを見分けるのに使う。0.13 以前に覚えたものには無い */
  lastActiveAt?: number
}

/** ペインの見せ方。list: 時刻順の一覧、tree: エージェントごとのツリー、map: メインのカードの下にサブエージェントの箱を並べた組織図のアニメーション */
export type WorkLogView = 'list' | 'tree' | 'map'

/** 要約を止めたときの記録。同じモデルのあいだは要約しない */
export type WorkLogSummaryStop = { model: string; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'cc-work-log': {
      entries: WorkLogEntry[]
      /** サブエージェントの id → その情報 */
      agents: Record<string, WorkLogAgent>
      /** セッションの作業ディレクトリ。パスを短く出すのに使う */
      cwd: string
      summaryStop: WorkLogSummaryStop | null
      /** ペインのボタンで選んだ見せ方。null なら /config の view に従う */
      view: WorkLogView | null
      /** 直近のメインへの依頼(ユーザーの入力など)を受けた時刻(ms)。マップはこれより後に起動したものを出す。まだ無ければ null */
      requestAt: number | null
      /** マップで詳細を開いているサブエージェントの id。開いていなければ null */
      selected: string | null
    }
  }
}
