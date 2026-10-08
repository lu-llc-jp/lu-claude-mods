/** セッションで使えるスキル1つ */
export type SkillInfo = {
  /** `/skills` が並べる名前。プラグインのスキルは `<プラグイン>:<スキル>` */
  name: string
  /** 出どころ(エンジンの言葉。userSettings / projectSettings / plugin / syncedSkills / built-in など) */
  source: string
  /** プラグインのスキルなら、そのプラグインの名前 */
  pluginName?: string
  /** 見つけた SKILL.md の絶対パス。組み込みのスキルなど、ファイルが無ければ無い */
  path?: string
  /** SKILL.md の frontmatter の description */
  description?: string
  /** このスキルを持たせているサブエージェントの名前(エージェント定義の frontmatter の skills) */
  agents: string[]
}

/** 手順の担い手。ai: メインのエージェント、human: 人、script: 決まった手順のスクリプト、subagent: サブエージェント、unknown: 分からない(見出しから作った流れ) */
export type FlowActor = 'ai' | 'human' | 'script' | 'subagent' | 'unknown'

/** 流れの1手順 */
export type FlowStep = {
  /** 手順の id(s1, s2 …)。next で指すのに使う */
  id: string
  /** 短い名前 */
  title: string
  actor: FlowActor
  /** actor が subagent のとき、そのエージェントの名前 */
  agent?: string
  /** 一言の補足 */
  detail?: string
  /** ここで人の承認を待つなら true */
  gate?: boolean
  /** この手順が残すもの */
  outputs?: string[]
  /** 次に進む手順の id。無ければ並びの次へ進む。空なら終わり。分岐・戻りがあるときだけ書く */
  next?: string[]
}

/** スキル全体の成果物 */
export type FlowOutput = { name: string; where?: string }

/** スキルの手順の流れ */
export type SkillFlow = {
  /** スキルが何をするかの一文 */
  summary?: string
  steps: FlowStep[]
  outputs: FlowOutput[]
  /** model: モデルで抽出した、headings: SKILL.md の見出しから作った */
  by: 'model' | 'headings'
}

/** 選んだスキルの流れの読み取りの様子 */
export type FlowState =
  | { status: 'loading'; model: string }
  | {
      status: 'ready'
      flow: SkillFlow
      /** 読み取ったときの本文のハッシュ。本文が変わったら読み直す */
      hash: string
      /** 読み取りに使ったモデル。見出しから作ったなら無い。設定が変わったら読み直す */
      model?: string
      /** 見出しで代えた理由など、流れに添える一言 */
      note?: string
    }
  | { status: 'none'; reason: string }

/** 流れの再生。どのスキルを、いつ始めたか(ms) */
export type FlowPlay = { skill: string; startedAt: number }

/** $.store に残す、モデルで抽出した流れ。本文のハッシュとモデルが同じあいだは使い回す */
export type FlowCache = { hash: string; model: string; flow: SkillFlow }

declare module 'claude-code' {
  interface PluginState {
    'cc-skill-map': {
      /** 一覧。まだ読んでいなければ null */
      skills: SkillInfo[] | null
      /** 一覧を読めなかった理由。読めたら null */
      scanError: string | null
      /** 流れを開いているスキルの名前。一覧を見ているなら null */
      selected: string | null
      /** スキルの名前 → 流れの読み取りの様子 */
      flows: Record<string, FlowState>
      /** 再生しているスキルと始めた時刻。再生していなければ null。最後まで再生しても、もう一度押すか一覧に戻るまで残す */
      play: FlowPlay | null
      /** SKILL.md の無いスキル(組み込みなど)の、呼ばれたときに展開された本文。スキルの名前 → 本文 */
      prompts: Record<string, string>
    }
  }
}
