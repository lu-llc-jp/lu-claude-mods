import type { WorkLogAgent, WorkLogEntry, WorkLogStatus } from '../types'
import { agentOf, agentStatus, splitTurns } from './tree'

/** 動いているあいだの描き直しの間隔(ms)。スピナーが滑らかに見える速さ */
export const TICK_MS = 150
/** 粒が道筋を渡りきるまでの時間(ms) */
export const FLIGHT_MS = 1200
/** 結果の粒が届いてから、メインのカードが光っている時間(ms) */
export const FLASH_MS = 900
/** 起動したての名前を打ち出していく時間(ms) */
export const TYPE_MS = 600
/** 終えたサブエージェントを置いておく時間(ms)。ターンをまたいでも、この間は残す */
export const RECENT_MS = 10 * 60_000
/** 実行中を示すスピナーのコマ */
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * マップの1区切りの色分け。
 * edge: 線、live: 実行中の線を流れる光、flow: 依頼の粒、back: 結果の粒、title: 見出し、spin: スピナー、ok・error: 終えた印、
 * no: 通し番号、type: エージェントの種類(hue で色を変える)、label・labelDone: 説明、cursor: 打ち出し中のカーソル、
 * tool: 今のツール、timeLive: 経過時間、note: 所要時間など、more: 補足
 */
export type MapTone =
  | 'edge'
  | 'live'
  | 'flow'
  | 'back'
  | 'title'
  | 'spin'
  | 'ok'
  | 'error'
  | 'no'
  | 'type'
  | 'label'
  | 'labelDone'
  | 'cursor'
  | 'tool'
  | 'timeLive'
  | 'note'
  | 'more'
/** hue は type の色の番号(種類ごとに決まる) */
export type MapSeg = { text: string; tone: MapTone; hue?: number }

/** 種類の色の数。描く側はこの数だけ色を用意する */
export const TYPE_HUES = 6

/** マップに置くサブエージェント1体 */
export type Item = {
  id: string
  agent: WorkLogAgent
  status: WorkLogStatus
  /** 0 はメインから起動したもの。入れ子ほど大きく、右へずらす */
  depth: number
  startedAt?: number
  endedAt?: number
  /** 実行中のツールの文 */
  tool?: string
}

export type Scene = {
  main: { status: WorkLogStatus; endText?: string; tool?: string }
  items: Item[]
}

// ---- 場面を組み立てる ----

/** owner(undefined はメイン)の、実行中のツールのうち最後のもの。サブエージェントの起動の行は除く */
const runningTool = (
  list: readonly WorkLogEntry[],
  owner: string | undefined,
  spawnIds: ReadonlySet<string>,
): string | undefined => {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const one = list[i]
    if (one === undefined) continue
    if (one.kind === 'tool' && one.status === 'running' && one.agentId === owner && !spawnIds.has(one.id)) {
      return one.text
    }
  }
  return undefined
}

/** 置くエージェントを、親子をたどる順(親の次にその子)に、起動した順で並べる。親が置かれていなければメインから起動したものとして扱う */
export const order = (ids: readonly string[], agents: Record<string, WorkLogAgent>): Array<{ id: string; depth: number }> => {
  const shown = new Set(ids)
  const byNo = [...ids].sort((a, b) => (agentOf(agents, a)?.no ?? 0) - (agentOf(agents, b)?.no ?? 0))
  const parentOf = (id: string): string | undefined => {
    const parent = agentOf(agents, id)?.parentId
    return parent !== undefined && shown.has(parent) ? parent : undefined
  }
  const out: Array<{ id: string; depth: number }> = []
  const visit = (id: string, depth: number) => {
    out.push({ id, depth })
    for (const child of byNo) if (parentOf(child) === id) visit(child, depth + 1)
  }
  for (const id of byNo) if (parentOf(id) === undefined) visit(id, 0)
  return out
}

export const buildScene = (list: readonly WorkLogEntry[], agents: Record<string, WorkLogAgent>, now: number): Scene => {
  const last = splitTurns(list).at(-1)
  const spawnIds = new Set<string>()
  for (const id of Object.keys(agents)) {
    const at = agentOf(agents, id)?.spawnEntryId
    if (at !== undefined) spawnIds.add(at)
  }

  const items = new Map<string, Item>()
  for (const id of Object.keys(agents)) {
    const agent = agentOf(agents, id)
    if (agent === undefined) continue
    const status = agentStatus(agent, id, list)
    // 0.3 以前に覚えたエージェントは時刻を持たないので、起動の行とターン終了の行の時刻で代える
    const startedAt = agent.startedAt ?? list.find(one => one.id === agent.spawnEntryId)?.at
    const endedAt =
      agent.endedAt ?? (status === 'running' ? undefined : list.find(one => one.kind === 'turn' && one.agentId === id)?.at)
    // 終えたものは、終えてから RECENT_MS のあいだだけ置く。完了の通知でターンが進んでも消えないよう、ターンではなく時刻で決める
    const settledAt = endedAt ?? startedAt
    if (status !== 'running' && !(settledAt !== undefined && now - settledAt < RECENT_MS)) continue
    items.set(id, {
      id,
      agent,
      status,
      depth: 0,
      startedAt,
      endedAt,
      tool: status === 'running' ? runningTool(list, id, spawnIds) : undefined,
    })
  }

  const end = last?.end
  return {
    main: {
      status: end === undefined ? 'running' : (end.status ?? 'ok'),
      endText: end?.text,
      tool: end === undefined ? runningTool(list, undefined, spawnIds) : undefined,
    },
    items: order([...items.keys()], agents).flatMap(({ id, depth }) => {
      const item = items.get(id)
      return item === undefined ? [] : [{ ...item, depth }]
    }),
  }
}

export const inFlight = (at: number | undefined, now: number): boolean =>
  at !== undefined && now >= at && now - at < FLIGHT_MS

/** 結果の粒がメインに届き、カードが光っているか */
export const flashing = (items: readonly Item[], now: number): boolean =>
  items.some(
    item =>
      item.depth === 0 &&
      item.endedAt !== undefined &&
      now - item.endedAt >= FLIGHT_MS &&
      now - item.endedAt < FLIGHT_MS + FLASH_MS,
  )

/**
 * マップが動いているか。メインがツールを使っている・実行中のサブエージェントがいる・粒が流れている・カードが光っている、のどれか。
 * 動いていなければ描き直しを止める
 */
export const isMapAnimating = (
  list: readonly WorkLogEntry[],
  agents: Record<string, WorkLogAgent>,
  now: number,
): boolean => {
  const scene = buildScene(list, agents, now)
  return (
    scene.main.tool !== undefined ||
    flashing(scene.items, now) ||
    scene.items.some(
      item => item.status === 'running' || inFlight(item.startedAt, now) || inFlight(item.endedAt, now),
    )
  )
}

/** 実行中を示すスピナーの今のコマ */
export const spinner = (now: number): string => SPIN[Math.floor(now / TICK_MS) % SPIN.length] ?? '•'

/** 種類を短くする。general-purpose は general に */
export const shortType = (type: string): string => (type === 'general-purpose' ? 'general' : type)

/** 種類ごとに決まる色の番号 */
export const hueOf = (type: string): number => {
  let sum = 0
  for (const ch of type) sum = (sum * 31 + (ch.codePointAt(0) ?? 0)) % 9973
  return sum % TYPE_HUES
}
