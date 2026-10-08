import type { WorkLogAgent, WorkLogEntry, WorkLogStatus } from '../types'
import { agentLabel, seconds, shortModel } from './describe'
import { agentOf, agentStatus, splitTurns } from './tree'

/** 動いているあいだの描き直しの間隔(ms)。1秒に5回 */
export const TICK_MS = 200
/** 実行中の点が明滅する半周期(ms) */
const BLINK_MS = 400
/** 粒が枝を渡りきるまでの時間(ms) */
export const FLIGHT_MS = 1600
/** メインからサブエージェントへの枝の長さ(マス) */
const BRANCH = 8
/** サブエージェントから、その起動したサブエージェントへの枝の長さ(マス) */
const NEST_BRANCH = 4

/**
 * マップの1マスまたは1区切りの色分け。
 * edge: 枝、flow: 流れる粒、hub: 光っている中心、hubIdle: 静かな中心、node: 実行中の点、ok・error: 終えた点、
 * label: エージェントの名前、tool: 今のツール、note: 所要時間など、more: 省いた目印
 */
export type MapTone = 'edge' | 'flow' | 'hub' | 'hubIdle' | 'node' | 'ok' | 'error' | 'label' | 'tool' | 'note' | 'more'
export type MapSeg = { text: string; tone: MapTone }
/** マップの1行。描く側は segs を色付きの Text にするだけ */
export type MapLine = { key: string; segs: MapSeg[] }

/** マップに置くサブエージェント1体 */
type Item = {
  id: string
  agent: WorkLogAgent | undefined
  status: WorkLogStatus
  /** 0 はメインから起動したもの。入れ子ほど大きく、外側に置く */
  depth: number
  startedAt?: number
  endedAt?: number
  /** 実行中のツールの文 */
  tool?: string
}

/** マップに描くもの。メインの様子と、置くサブエージェント */
type Scene = {
  main: { status: WorkLogStatus; endText?: string; tool?: string }
  items: Item[]
}

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

/** 置くエージェントを、親子をたどる順(親の次にその子)に並べる。親が置かれていなければメインから起動したものとして扱う */
const order = (ids: readonly string[], agents: Record<string, WorkLogAgent>): Array<{ id: string; depth: number }> => {
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

const buildScene = (list: readonly WorkLogEntry[], agents: Record<string, WorkLogAgent>): Scene => {
  const segments = splitTurns(list)
  const last = segments.at(-1)
  // 今のターン(終えたばかりなら、そのターン)より前に終えたものは出さない
  const since = segments.at(-2)?.end?.at ?? Number.NEGATIVE_INFINITY
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
    if (status !== 'running' && !(startedAt !== undefined && startedAt > since)) continue
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

const inFlight = (at: number | undefined, now: number): boolean =>
  at !== undefined && now >= at && now - at < FLIGHT_MS

/**
 * マップが動いているか。メインがツールを使っている・実行中のサブエージェントがいる・粒が流れている、のどれか。
 * 動いていなければ描き直しを止める
 */
export const isMapAnimating = (
  list: readonly WorkLogEntry[],
  agents: Record<string, WorkLogAgent>,
  now: number,
): boolean => {
  const scene = buildScene(list, agents)
  return (
    scene.main.tool !== undefined ||
    scene.items.some(
      item => item.status === 'running' || inFlight(item.startedAt, now) || inFlight(item.endedAt, now),
    )
  )
}

/** 深さ depth の点の列 */
const nodeColumn = (depth: number): number => BRANCH + 1 + depth * (NEST_BRANCH + 1)

type Cell = MapSeg | undefined
type Row = { key: string; cells: Cell[]; tail: MapSeg[] }

const put = (cells: Cell[], col: number, text: string, tone: MapTone) => {
  while (cells.length < col) cells.push(undefined)
  cells[col] = { text, tone }
}

/** 1体ぶんの行(名前の行と、実行中なら今のツールの行) */
const itemRows = (item: Item, half: 'upper' | 'lower', now: number, showTool: boolean): Row[] => {
  const cells: Cell[] = []
  const node = nodeColumn(item.depth)
  // 枝は、メインからなら列 0、入れ子なら親の点の列から出る
  const from = item.depth === 0 ? 0 : nodeColumn(item.depth - 1)
  put(cells, from, half === 'upper' ? '╭' : '╰', 'edge')
  for (let col = from + 1; col < node; col += 1) put(cells, col, '─', 'edge')

  // 起動したては依頼の粒が外へ、終えたては結果の粒が内へ流れる
  const length = node - from - 1
  const step = (at: number) => Math.min(length - 1, Math.floor(((now - at) / FLIGHT_MS) * length))
  if (inFlight(item.endedAt, now) && item.endedAt !== undefined) {
    put(cells, node - 1 - step(item.endedAt), '◂', 'flow')
  } else if (inFlight(item.startedAt, now) && item.startedAt !== undefined) {
    put(cells, from + 1 + step(item.startedAt), '▸', 'flow')
  }

  if (item.status === 'running') {
    put(cells, node, Math.floor(now / BLINK_MS) % 2 === 0 ? '●' : '○', 'node')
  } else {
    put(cells, node, item.status === 'ok' ? '✓' : '✗', item.status)
  }

  const { agent } = item
  const tail: MapSeg[] = [
    { text: ` ${agent === undefined ? 'サブエージェント' : `${agentLabel(agent)}『${agent.name}』`}`, tone: 'label' },
  ]
  if (item.status !== 'running' && agent?.durationMs !== undefined) {
    tail.push({ text: ` ${seconds(agent.durationMs)}`, tone: 'note' })
  }
  const rows: Row[] = [{ key: `agent:${item.id}`, cells, tail }]
  if (showTool && item.tool !== undefined) {
    const pad: Cell[] = []
    put(pad, node + 1, ' ', 'edge')
    rows.push({ key: `tool:${item.id}`, cells: pad, tail: [{ text: ` ${item.tool}`, tone: 'tool' }] })
  }
  return rows
}

/** rows の a 行目と b 行目のあいだ(両端を除く)の列 col に縦の枝を引く。途中の曲がり角は分かれ道にする */
const drawVertical = (rows: Row[], col: number, a: number, b: number) => {
  for (let i = Math.min(a, b) + 1; i < Math.max(a, b); i += 1) {
    const row = rows[i]
    if (row === undefined) continue
    const here = row.cells[col]
    if (here === undefined || here.text === ' ') put(row.cells, col, '│', 'edge')
    else if (here.text === '╭' || here.text === '╰') put(row.cells, col, '├', 'edge')
  }
}

const toLine = (row: Row): MapLine => {
  const segs: MapSeg[] = []
  for (const cell of row.cells) {
    const seg = cell ?? { text: ' ', tone: 'edge' as const }
    const prev = segs.at(-1)
    if (prev !== undefined && prev.tone === seg.tone) prev.text += seg.text
    else segs.push({ ...seg })
  }
  return { key: row.key, segs: [...segs, ...row.tail] }
}

/**
 * マップの行を組み立てる。
 * メインを真ん中の行に置き、メインから起動したサブエージェントを上・下と交互に置く。
 * サブエージェントが起動したものは、その親の外側(上の側ならさらに上、下の側ならさらに下)に、一段右へずらして置く。
 * 置くのは、実行中のものと、今のターン(終えたばかりならそのターン)に起動したもの。
 * rows に入りきらなければ、終えたものを古い順に省き、次に今のツールの行を省き、最後に新しいものから省く
 */
export const layoutMap = (
  list: readonly WorkLogEntry[],
  agents: Record<string, WorkLogAgent>,
  mainModel: string,
  now: number,
  rows: number,
): MapLine[] => {
  const scene = buildScene(list, agents)
  let kept = scene.items.map(item => item.id)
  let showTool = true
  let omitted = 0

  const placed = (): Item[] => {
    const byId = new Map(scene.items.map(item => [item.id, item]))
    return order(kept, agents).flatMap(({ id, depth }) => {
      const item = byId.get(id)
      return item === undefined ? [] : [{ ...item, depth }]
    })
  }
  const height = (): number =>
    1 +
    (kept.length === 0 || omitted > 0 ? 1 : 0) +
    placed().reduce((sum, item) => sum + 1 + (showTool && item.tool !== undefined ? 1 : 0), 0)

  const byNo = (id: string) => agentOf(agents, id)?.no ?? 0
  const drop = (pick: (ids: string[]) => string | undefined): boolean => {
    const id = pick(kept)
    if (id === undefined) return false
    kept = kept.filter(one => one !== id)
    omitted += 1
    return true
  }
  const statusOf = (id: string) => scene.items.find(item => item.id === id)?.status
  while (height() > rows && drop(ids => ids.filter(id => statusOf(id) !== 'running').sort((a, b) => byNo(a) - byNo(b))[0]));
  if (height() > rows) showTool = false
  while (height() > rows && drop(ids => [...ids].sort((a, b) => byNo(b) - byNo(a))[0]));

  // メインから起動したもの1体と、その子孫をひとかたまりにする
  const clusters: Item[][] = []
  for (const item of placed()) {
    if (item.depth === 0) clusters.push([item])
    else clusters.at(-1)?.push(item)
  }
  const upper = clusters.filter((_, i) => i % 2 === 0)
  const lower = clusters.filter((_, i) => i % 2 === 1)

  // 上の側は、メインに近いものほど下に来るよう、かたまりも中の順も逆にする(名前の行と今のツールの行の順は保つ)
  const out: Array<Row & { item?: Item }> = []
  for (const item of [...upper].reverse().flatMap(cluster => [...cluster].reverse())) {
    out.push(...itemRows(item, 'upper', now, showTool).map((row, i) => ({ ...row, item: i === 0 ? item : undefined })))
  }

  const hubAt = out.length
  const { main } = scene
  const busy = main.tool !== undefined
  const hubCells: Cell[] = []
  put(
    hubCells,
    0,
    busy && Math.floor(now / BLINK_MS) % 2 === 1 ? '◎' : '◉',
    main.status === 'running' ? 'hub' : 'hubIdle',
  )
  const hubTail: MapSeg[] = [{ text: ` メイン${mainModel === '' ? '' : `·${shortModel(mainModel)}`}`, tone: 'label' }]
  if (main.status !== 'running') {
    hubTail.push({ text: ` ${main.status === 'ok' ? '✓' : '✗'}`, tone: main.status })
    if (main.endText !== undefined) hubTail.push({ text: ` ${main.endText}`, tone: 'note' })
  }
  if (main.tool !== undefined) hubTail.push({ text: `  ${main.tool}`, tone: 'tool' })
  out.push({ key: 'hub', cells: hubCells, tail: hubTail })

  for (const item of lower.flatMap(cluster => cluster)) {
    out.push(...itemRows(item, 'lower', now, showTool).map((row, i) => ({ ...row, item: i === 0 ? item : undefined })))
  }

  // 縦の枝を引く。メインからのものは中心の行まで、入れ子のものは親の名前の行まで
  const rowOf = new Map<string, number>()
  out.forEach((row, i) => {
    if (row.item !== undefined) rowOf.set(row.item.id, i)
  })
  out.forEach((row, i) => {
    const item = row.item
    if (item === undefined) return
    if (item.depth === 0) {
      drawVertical(out, 0, i, hubAt)
      return
    }
    const parent = agentOf(agents, item.id)?.parentId
    const at = parent === undefined ? undefined : rowOf.get(parent)
    if (at !== undefined) drawVertical(out, nodeColumn(item.depth - 1), i, at)
  })

  const lines = out.map(toLine)
  if (kept.length === 0 && omitted === 0) {
    lines.push({ key: 'more', segs: [{ text: '  サブエージェントは動いていません', tone: 'more' }] })
  } else if (omitted > 0) {
    lines.push({ key: 'more', segs: [{ text: `  ほか ${omitted} 体を省いた`, tone: 'more' }] })
  }
  return lines
}
