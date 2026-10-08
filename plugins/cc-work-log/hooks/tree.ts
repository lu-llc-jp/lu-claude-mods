import type { WorkLogAgent, WorkLogEntry, WorkLogStatus } from '../types'
import { agentLabel, seconds, shortModel } from './describe'

/**
 * ツリー表示の1行。描く側はこれを色付きの Text にするだけにして、組み立てはここで行う(テストしやすくするため)。
 * tone: root はターンごとのメイン、agent はサブエージェントの枝、work は作業、turn は畳んだ前のターン、
 * summary・notice は要約とお知らせ、more は省いた行の目印
 */
export type TreeLine = {
  key: string
  /** 罫線(`├─ ` `│  ` など) */
  guide: string
  tone: 'root' | 'agent' | 'work' | 'turn' | 'summary' | 'notice' | 'more'
  text: string
  status?: WorkLogStatus
  /** 文のあとに薄く足す(所要時間など) */
  note?: string
  /** 終えたターンの行(畳んだ行と根)だけ持つ。終えた時刻 */
  at?: number
}

type Node = {
  key: string
  tone: 'agent' | 'work' | 'summary' | 'notice'
  text: string
  status?: WorkLogStatus
  note?: string
  /** サブエージェントの枝なら、その id(畳むときに使う) */
  agentId?: string
  children: Node[]
}

/** メインのターン1回ぶん。end はターン終了の行、extras はその後に来た要約・お知らせ */
type Segment = { work: WorkLogEntry[]; end?: WorkLogEntry; extras: WorkLogEntry[] }

const isMainTurn = (one: WorkLogEntry): boolean => one.kind === 'turn' && one.agentId === undefined
const isExtra = (one: WorkLogEntry): boolean =>
  one.agentId === undefined && (one.kind === 'summary' || one.kind === 'notice')

/** 行をメインのターンごとに分ける。ターン終了の直後の要約・お知らせは、終えたターンに付ける */
export const splitTurns = (list: readonly WorkLogEntry[]): Segment[] => {
  const segments: Segment[] = []
  let open: Segment | undefined
  for (const one of list) {
    if (open === undefined) {
      const last = segments.at(-1)
      if (isExtra(one) && last !== undefined) {
        last.extras.push(one)
        continue
      }
      open = { work: [], extras: [] }
      segments.push(open)
    }
    if (isMainTurn(one)) {
      open.end = one
      open = undefined
    } else {
      open.work.push(one)
    }
  }
  return segments
}

const agentOf = (agents: Record<string, WorkLogAgent>, id: string): WorkLogAgent | undefined => {
  const agent = agents[id]
  // 0.1 では名前(文字列)だけを覚えていた
  return typeof agent === 'object' && agent !== null ? agent : undefined
}

/** 枝の状態。0.2 以前に覚えたエージェントは状態を持たないので、そのターン終了の行があるかで決める */
const agentStatus = (agent: WorkLogAgent | undefined, id: string, work: readonly WorkLogEntry[]): WorkLogStatus => {
  if (agent?.status !== undefined) return agent.status
  return work.some(one => one.kind === 'turn' && one.agentId === id) ? 'ok' : 'running'
}

const buildNodes = (segment: Segment, agents: Record<string, WorkLogAgent>): Node[] => {
  const { work } = segment
  // 起動の行の id → その行から起動したエージェント
  const spawnedAt = new Map<string, string[]>()
  for (const id of Object.keys(agents)) {
    const at = agentOf(agents, id)?.spawnEntryId
    if (at !== undefined) spawnedAt.set(at, [...(spawnedAt.get(at) ?? []), id])
  }
  const placed = new Set<string>()

  const agentNode = (id: string): Node => {
    placed.add(id)
    const agent = agentOf(agents, id)
    const status = agentStatus(agent, id, work)
    const head = agent === undefined ? 'サブエージェント' : `${agentLabel(agent)}『${agent.name}』`
    const note = status !== 'running' && agent?.durationMs !== undefined ? seconds(agent.durationMs) : undefined
    return { key: `agent:${id}`, tone: 'agent', text: head, status, note, agentId: id, children: childrenOf(id) }
  }

  const childrenOf = (owner: string | undefined): Node[] => {
    const nodes: Node[] = []
    for (const one of work) {
      if (one.agentId !== owner) continue
      // サブエージェントのターン終了は、枝の状態として出す
      if (one.kind === 'turn') continue
      const spawned = (spawnedAt.get(one.id) ?? []).filter(id => !placed.has(id))
      if (spawned.length > 0) {
        for (const id of spawned) nodes.push(agentNode(id))
        continue
      }
      const tone = one.kind === 'summary' ? 'summary' : one.kind === 'notice' ? 'notice' : 'work'
      nodes.push({ key: one.id, tone, text: one.text, status: one.status, children: [] })
    }
    // 起動の行がこのターンに無いエージェント(前のターンから動いている・古い行が消えた)も、作業があれば親の下に出す
    for (const one of work) {
      const id = one.agentId
      if (id === undefined || placed.has(id) || agentOf(agents, id)?.parentId !== owner) continue
      nodes.push(agentNode(id))
    }
    return nodes
  }

  const nodes = childrenOf(undefined)
  // 親がこのターンに出てこないエージェントは、根の下に出す
  for (const one of work) {
    if (one.agentId !== undefined && !placed.has(one.agentId)) nodes.push(agentNode(one.agentId))
  }
  return nodes
}

const flatten = (nodes: readonly Node[], prefix: string): TreeLine[] =>
  nodes.flatMap((node, i) => {
    const last = i === nodes.length - 1
    const line: TreeLine = {
      key: node.key,
      guide: `${prefix}${last ? '└─ ' : '├─ '}`,
      tone: node.tone,
      text: node.text,
      status: node.status,
      note: node.note,
    }
    return [line, ...flatten(node.children, `${prefix}${last ? '   ' : '│  '}`)]
  })

/** 終えた枝を、古いものから1本畳む。畳めたら true */
const foldOne = (nodes: Node[]): boolean => {
  for (const node of nodes) {
    if (node.tone === 'agent' && node.status !== 'running' && node.children.length > 0) {
      const count = node.children.length
      node.children = []
      node.note = [node.note, `作業 ${count} 件を畳んだ`].filter(Boolean).join(' · ')
      return true
    }
    if (foldOne(node.children)) return true
  }
  return false
}

type Turn = { segment: Segment; nodes: Node[]; collapsed: boolean }

const extraLine = (extra: WorkLogEntry, guide: string): TreeLine => ({
  key: extra.id,
  guide,
  tone: extra.kind === 'summary' ? 'summary' : 'notice',
  text: extra.text,
})

/** ターン1回ぶんの行。畳んだターンは「回答した(12秒)」の1行と、その要約・お知らせだけにする */
const turnLines = (turn: Turn, index: number, mainModel: string): TreeLine[] => {
  const { segment } = turn
  const end = segment.end
  if (turn.collapsed && end !== undefined) {
    return [
      { key: end.id, guide: '', tone: 'turn', text: end.text, status: end.status ?? 'ok', at: end.at },
      ...segment.extras.map(extra => extraLine(extra, '   ')),
    ]
  }
  const root: TreeLine = {
    key: `root:${index}`,
    guide: '',
    tone: 'root',
    text: `メイン${mainModel === '' ? '' : `·${shortModel(mainModel)}`}`,
    status: end === undefined ? 'running' : (end.status ?? 'ok'),
    note: end?.text,
    at: end?.at,
  }
  return [root, ...flatten(turn.nodes, ''), ...segment.extras.map(extra => extraLine(extra, ''))]
}

/**
 * ツリー表示の行を組み立てる。
 * ターンごとにメインを根にしたツリーを上から積む。回答を終えたターンも、入りきるかぎり開いたまま出す。
 * rows に入りきらなければ、次の順に詰める。実行中の枝の作業は畳まない。
 * 1. 前のターンの終えた枝の作業を、古いターンから畳む
 * 2. 前のターンを、古いものから「回答した(12秒)」の1行に畳む
 * 3. 最後のターンの終えた枝の作業を、古い順に畳む
 * 4. 畳んだ前のターンを上から省き、それでも入らなければ最後のツリーの上のほうを省く
 */
export const layoutTree = (
  list: readonly WorkLogEntry[],
  agents: Record<string, WorkLogAgent>,
  mainModel: string,
  rows: number,
): TreeLine[] => {
  const turns: Turn[] = splitTurns(list).map(segment => ({
    segment,
    nodes: buildNodes(segment, agents),
    collapsed: false,
  }))
  const target = turns.at(-1)
  if (target === undefined) return []
  const older = turns.slice(0, -1)

  const historyLines = (): TreeLine[] => older.flatMap((turn, i) => turnLines(turn, i, mainModel))
  const targetLines = (): TreeLine[] => turnLines(target, older.length, mainModel)
  const fits = (): boolean => historyLines().length + targetLines().length <= rows

  for (const turn of older) while (!fits() && foldOne(turn.nodes));
  for (const turn of older) if (!fits()) turn.collapsed = true
  while (!fits() && foldOne(target.nodes));

  const history = historyLines()
  const [root, ...rest] = targetLines()
  const tail = target.segment.extras.map(extra => extraLine(extra, ''))
  const body = rest.slice(0, rest.length - tail.length)
  const fixed = 1 + tail.length
  if (history.length + fixed + body.length <= rows) return [...history, root, ...body, ...tail]

  // 前のターンを先に省き、それでも入らなければツリーの上のほうを省く(下ほど新しい)
  const keepHistory = Math.max(0, rows - fixed - body.length)
  const shownHistory = keepHistory === 0 ? [] : history.slice(-keepHistory)
  if (shownHistory.length + fixed + body.length <= rows) return [...shownHistory, root, ...body, ...tail]

  const room = Math.max(1, rows - fixed - 1)
  const hidden = body.length - room
  const more: TreeLine = { key: 'more', guide: '', tone: 'more', text: `⋮ 上の ${hidden} 行を省いた` }
  return [root, more, ...body.slice(-room), ...tail].slice(-Math.max(1, rows))
}
