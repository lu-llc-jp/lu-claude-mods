import type { WorkLogAgent, WorkLogEntry, WorkLogStatus } from '../types'
import { seconds, shortModel } from './describe'
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
/** 幹の列。メインのカードの下から下ろす */
const TRUNK = 3
/** 幹からサブエージェントの点までの枝の長さ(マス) */
const BRANCH = 5
/** サブエージェントから、その起動したサブエージェントまでの枝の長さ(マス) */
const NEST_BRANCH = 3
/** マップの幅の上限。広いペインでも線が間延びしないように止める */
const HUB_MAX = 72
/** 名前に残したい幅(マス)。これより狭くなるならモデルを外す */
const MIN_NAME = 14
/** 流れる光の間隔(マス) */
const PULSE_GAP = 5

/**
 * マップの1区切りの色分け。
 * edge: 線、live: 実行中の道筋を流れる光、flow・flowTrail: 依頼の粒とその尾、back・backTrail: 結果の粒とその尾、
 * hub・hubIdle・hubFlash: メインのカードの枠(動いている・静か・結果が届いた)、title: カードの見出し、
 * spin: 実行中の点、ok・error: 終えた点、no: 通し番号、type: エージェントの種類(hue で色を変える)、
 * label・labelDone: 名前、cursor: 打ち出し中のカーソル、tool: 今のツール、timeLive: 経過時間、note: 所要時間など、more: 補足
 */
export type MapTone =
  | 'edge'
  | 'live'
  | 'flow'
  | 'flowTrail'
  | 'back'
  | 'backTrail'
  | 'hub'
  | 'hubIdle'
  | 'hubFlash'
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
/** マップの1行。描く側は segs を色付きの Text にするだけ */
export type MapLine = { key: string; segs: MapSeg[] }

/** 種類の色の数。描く側はこの数だけ色を用意する */
export const TYPE_HUES = 6

/** マップに置くサブエージェント1体 */
type Item = {
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

type Scene = {
  main: { status: WorkLogStatus; endText?: string; tool?: string }
  items: Item[]
}

// ---- 文字幅 ----

/** 端末で2マスを取る文字か(CJK・全角・絵文字) */
const isWide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1faff) ||
  (cp >= 0x20000 && cp <= 0x3fffd)

/** 端末でのマス数 */
export const cellWidth = (text: string): number => {
  let width = 0
  for (const ch of text) width += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
  return width
}

/** width マスに収める。はみ出すなら末尾を … にする */
export const fit = (text: string, width: number): string => {
  if (width <= 0) return ''
  if (cellWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = cellWidth(ch)
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return `${out}…`
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

const buildScene = (list: readonly WorkLogEntry[], agents: Record<string, WorkLogAgent>, now: number): Scene => {
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

const inFlight = (at: number | undefined, now: number): boolean =>
  at !== undefined && now >= at && now - at < FLIGHT_MS

/** 結果の粒がメインに届き、カードが光っているか */
const flashing = (items: readonly Item[], now: number): boolean =>
  items.some(
    item =>
      item.depth === 0 &&
      item.endedAt !== undefined &&
      now - item.endedAt >= FLIGHT_MS &&
      now - item.endedAt < FLIGHT_MS + FLASH_MS,
  )

/**
 * メインのキャラの様子。flash: 結果が届いた、busy: ツールを使っている、thinking: 考えている、done・error: ターンを終えた
 */
export type MainMood = 'flash' | 'busy' | 'thinking' | 'done' | 'error'
export const mainMood = (list: readonly WorkLogEntry[], agents: Record<string, WorkLogAgent>, now: number): MainMood => {
  const { main, items } = buildScene(list, agents, now)
  if (flashing(items, now)) return 'flash'
  if (main.status === 'running') return main.tool === undefined ? 'thinking' : 'busy'
  return main.status === 'ok' ? 'done' : 'error'
}

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

// ---- 描く ----

/** 1マス。2マスの文字の右隣は text '' で埋める */
type Cell = { text: string; tone: MapTone; hue?: number }
type Row = { key: string; cells: Cell[]; tail: MapSeg[] }

const put = (row: Row, col: number, text: string, tone: MapTone, hue?: number) => {
  while (row.cells.length <= col) row.cells.push({ text: ' ', tone: 'edge' })
  row.cells[col] = hue === undefined ? { text, tone } : { text, tone, hue }
}

/** col から文字列を1マスずつ置き、次の列を返す。2マスの文字は右隣を空にする */
const putText = (row: Row, col: number, text: string, tone: MapTone, hue?: number): number => {
  let at = col
  for (const ch of text) {
    put(row, at, ch, tone, hue)
    if (cellWidth(ch) === 2) put(row, at + 1, '', tone, hue)
    at += cellWidth(ch)
  }
  return at
}

const spinner = (now: number): string => SPIN[Math.floor(now / TICK_MS) % SPIN.length] ?? '•'

/** 種類を短くする。general-purpose は general に */
const shortType = (type: string): string => (type === 'general-purpose' ? 'general' : type)

/** 種類ごとに決まる色の番号 */
export const hueOf = (type: string): number => {
  let sum = 0
  for (const ch of type) sum = (sum * 31 + (ch.codePointAt(0) ?? 0)) % 9973
  return sum % TYPE_HUES
}

/** メインのカード(4行)。上の枠に見出しとモデル、中に今の様子とサブエージェントの数 */
/** withTrunk: 下に幹の付け根 ┬ を付ける。withMark: 見出しに ◉ を付ける(キャラを横に描くときは付けない) */
const hubRows = (
  scene: Scene,
  mainModel: string,
  width: number,
  now: number,
  withTrunk: boolean,
  withMark: boolean,
): Row[] => {
  const { main, items } = scene
  const tone: MapTone = flashing(items, now) ? 'hubFlash' : main.status === 'running' ? 'hub' : 'hubIdle'
  const inner = width - 4

  const top: Row = { key: 'hub:top', cells: [], tail: [] }
  let col = putText(top, 0, withMark ? '╭─ ◉ ' : '╭─ ', tone)
  col = putText(top, col, 'メイン', 'title')
  const model = mainModel === '' ? '' : ` ${shortModel(mainModel)} `
  col = putText(top, col, ` ${'─'.repeat(Math.max(0, width - col - cellWidth(model) - 3))}`, tone)
  col = putText(top, col, model, 'note')
  putText(top, col, '─╮', tone)

  const body = (key: string, segs: MapSeg[]): Row => {
    const row: Row = { key, cells: [], tail: [] }
    let at = putText(row, 0, '│ ', tone)
    let room = inner
    for (const seg of segs) {
      const text = fit(seg.text, room)
      at = putText(row, at, text, seg.tone, seg.hue)
      room -= cellWidth(text)
    }
    at = putText(row, at, ' '.repeat(Math.max(0, room)), 'edge')
    putText(row, at, ' │', tone)
    return row
  }

  const doing: MapSeg[] =
    main.status !== 'running'
      ? [
          { text: main.status === 'ok' ? '✓ ' : '✗ ', tone: main.status },
          { text: main.endText ?? '', tone: 'note' },
        ]
      : main.tool !== undefined
        ? [
            { text: `${spinner(now)} `, tone: 'spin' },
            { text: main.tool, tone: 'tool' },
          ]
        : [{ text: '… 考えています', tone: 'note' }]

  const live = items.filter(item => item.status === 'running').length
  const ok = items.filter(item => item.status === 'ok').length
  const ng = items.filter(item => item.status === 'error').length
  const count: MapSeg[] =
    items.length === 0
      ? [{ text: 'サブエージェントはいません', tone: 'more' }]
      : [
          { text: `${live > 0 ? spinner(now) : '·'} ${live} 動作中`, tone: live > 0 ? 'spin' : 'more' },
          { text: '  ', tone: 'edge' },
          { text: `✓ ${ok} 完了`, tone: ok > 0 ? 'ok' : 'more' },
          ...(ng > 0 ? [{ text: '  ', tone: 'edge' as const }, { text: `✗ ${ng} 失敗`, tone: 'error' as const }] : []),
        ]

  const bottom: Row = { key: 'hub:bottom', cells: [], tail: [] }
  putText(bottom, 0, `╰${'─'.repeat(width - 2)}╯`, tone)
  if (withTrunk) put(bottom, TRUNK, '┬', tone)

  return [top, body('hub:now', doing), body('hub:count', count), bottom]
}

/** 点の列 */
const nodeColumn = (depth: number): number => TRUNK + BRANCH + 1 + depth * (NEST_BRANCH + 1)
/** 枝が出る列。メインからなら幹、入れ子なら親の点の列 */
const forkColumn = (depth: number): number => (depth === 0 ? TRUNK : nodeColumn(depth - 1))

/** 1体の名前の行。点と、その右の番号・種類・名前・右寄せの時間 */
const agentRow = (item: Item, mainModel: string, width: number, now: number): Row => {
  const row: Row = { key: `agent:${item.id}`, cells: [], tail: [] }
  const node = nodeColumn(item.depth)
  const done = item.status !== 'running'
  if (done) put(row, node, item.status === 'ok' ? '✓' : '✗', item.status)
  else put(row, node, spinner(now), 'spin')

  const { agent } = item
  // メインと同じモデルなら書かない。違うときだけ目印になる
  const model = agent.model !== '' && shortModel(agent.model) !== shortModel(mainModel) ? shortModel(agent.model) : ''
  const time = done
    ? agent.durationMs === undefined
      ? ''
      : seconds(agent.durationMs)
    : item.startedAt === undefined
      ? ''
      : seconds(Math.max(0, now - item.startedAt))

  const headOf = (withModel: boolean): MapSeg[] => [
    { text: ` #${agent.no} `, tone: 'no' },
    { text: shortType(agent.type), tone: 'type', hue: hueOf(agent.type) },
    ...(withModel && model !== '' ? [{ text: `·${model}`, tone: 'note' as const }] : []),
    { text: '  ', tone: 'edge' },
  ]
  const usedBy = (segs: readonly MapSeg[]) => node + 1 + segs.reduce((sum, seg) => sum + cellWidth(seg.text), 0)
  // 名前がいちばん大事なので、名前の入る幅が足りなければモデルを外す
  const full = headOf(true)
  const head = width - usedBy(full) - (cellWidth(time) + 1) >= MIN_NAME ? full : headOf(false)
  const used = usedBy(head)

  // 起動したては名前を1文字ずつ打ち出す
  const typing = !done && item.startedAt !== undefined && now - item.startedAt < TYPE_MS
  const chars = [...agent.name]
  const shownName = typing
    ? chars.slice(0, Math.ceil((chars.length * Math.max(0, now - (item.startedAt ?? now))) / TYPE_MS)).join('')
    : agent.name
  const cursor = typing ? 1 : 0
  const timeRoom = time === '' ? 0 : cellWidth(time) + 1
  const name = fit(shownName, Math.max(4, width - used - timeRoom - cursor))

  const tail: MapSeg[] = [...head, { text: name, tone: done ? 'labelDone' : 'label' }]
  if (typing) tail.push({ text: '▍', tone: 'cursor' })
  if (time !== '') {
    const pad = width - used - cellWidth(name) - cursor - cellWidth(time)
    tail.push({ text: ' '.repeat(Math.max(1, pad)), tone: 'edge' })
    tail.push({ text: time, tone: done ? 'note' : 'timeLive' })
  }
  row.tail = tail
  return row
}

/** 実行中のツールの行。点の下から右にずらして添える */
const toolRow = (item: Item, width: number): Row => {
  const col = nodeColumn(item.depth) + 2
  const row: Row = { key: `tool:${item.id}`, cells: [], tail: [] }
  put(row, col - 1, ' ', 'edge')
  row.tail = [{ text: fit(item.tool ?? '', width - col), tone: 'tool' }]
  return row
}

/** 道筋。粒と光が通るマスを、出どころから点の手前まで順に並べたもの */
type Path = Array<[row: number, col: number]>

/** 線のマスを塗り替える。強いもの(粒 > 尾 > 光 > 線)を弱いもので上書きしない */
const RANK: Partial<Record<MapTone, number>> = { live: 1, flowTrail: 2, backTrail: 2, flow: 3, back: 3 }
const tint = (rows: readonly Row[], [r, c]: [number, number], tone: MapTone, text?: string) => {
  const row = rows[r]
  const cell = row?.cells[c]
  if (row === undefined || cell === undefined) return
  if ((RANK[tone] ?? 0) < (RANK[cell.tone] ?? 0)) return
  row.cells[c] = { text: text ?? cell.text, tone }
}

/**
 * マップの行を組み立てる。
 * メインを枠で囲んだカードにして上に置き、その下に幹を下ろして、サブエージェントを起動した順に枝で吊るす。
 * サブエージェントが起動したものは、親の点から下ろした枝に、一段右へずらして吊るす。
 * 実行中の道筋には光が外へ流れ、起動したては依頼の粒が外へ、終えたては結果の粒が出どころへ戻る。
 * 置くのは、実行中のものと、終えてから RECENT_MS 以内のもの。
 * rows に入りきらなければ、あいだの空き行、終えたもの(古い順)、今のツールの行、新しいもの、の順に省く。
 * 先頭の4行(key が hub: で始まる)がメインのカード
 */
export const layoutMap = (
  list: readonly WorkLogEntry[],
  agents: Record<string, WorkLogAgent>,
  mainModel: string,
  now: number,
  rows: number,
  columns: number,
  avatar = 0,
): MapLine[] => {
  const scene = buildScene(list, agents, now)
  const width = Math.max(24, Math.min(columns, HUB_MAX))
  let kept = scene.items.map(item => item.id)
  let showTool = true
  let spaced = true
  let omitted = 0

  const placed = (): Item[] => {
    const byId = new Map(scene.items.map(item => [item.id, item]))
    return order(kept, agents).flatMap(({ id, depth }) => {
      const item = byId.get(id)
      return item === undefined ? [] : [{ ...item, depth }]
    })
  }
  const height = (): number => {
    const items = placed()
    const groups = items.filter(item => item.depth === 0).length
    return (
      4 +
      (items.length > 0 ? 1 : 0) +
      (omitted > 0 ? 1 : 0) +
      (spaced ? Math.max(0, groups - 1) : 0) +
      items.reduce((sum, item) => sum + 1 + (showTool && item.tool !== undefined ? 1 : 0), 0)
    )
  }

  const byNo = (id: string) => agentOf(agents, id)?.no ?? 0
  const statusOf = (id: string) => scene.items.find(item => item.id === id)?.status
  const drop = (pick: (ids: string[]) => string | undefined): boolean => {
    const id = pick(kept)
    if (id === undefined) return false
    kept = kept.filter(one => one !== id)
    omitted += 1
    return true
  }
  if (height() > rows) spaced = false
  while (height() > rows && drop(ids => ids.filter(id => statusOf(id) !== 'running').sort((a, b) => byNo(a) - byNo(b))[0]));
  if (height() > rows) showTool = false
  while (height() > rows && drop(ids => [...ids].sort((a, b) => byNo(b) - byNo(a))[0]));

  const items = placed()
  // avatar > 0 なら、描く側がカードの左に avatar 列のキャラを置く。幹はキャラから下ろすので、カードには付け根を付けない
  const out: Row[] = hubRows(scene, mainModel, width - avatar, now, items.length > 0 && avatar === 0, avatar === 0)
  const hubBottom = out.length - 1
  if (items.length > 0) out.push({ key: 'gap:hub', cells: [], tail: [] })

  // 行を並べ、名前の行の位置を覚えておく。枝と幹はあとで引く
  const rowOf = new Map<string, number>()
  items.forEach((item, i) => {
    if (spaced && item.depth === 0 && i > 0) out.push({ key: `gap:${item.id}`, cells: [], tail: [] })
    rowOf.set(item.id, out.length)
    out.push(agentRow(item, mainModel, width, now))
    if (showTool && item.tool !== undefined) out.push(toolRow(item, width))
  })

  const parentRow = (item: Item): number => {
    if (item.depth === 0) return hubBottom
    const parent = agentOf(agents, item.id)?.parentId
    return (parent === undefined ? undefined : rowOf.get(parent)) ?? hubBottom
  }
  // 同じ出どころから出る枝のうち、最後のものは ╰、それ以外は ├
  const lastChild = new Map<string, string>()
  for (const item of items) lastChild.set(`${item.depth}:${parentRow(item)}`, item.id)

  // 枝と幹を引き、粒と光が通る道筋を覚える
  const paths = new Map<string, Path>()
  for (const item of items) {
    const r = rowOf.get(item.id)
    const row = r === undefined ? undefined : out[r]
    if (r === undefined || row === undefined) continue
    const fork = forkColumn(item.depth)
    const node = nodeColumn(item.depth)
    const from = parentRow(item)
    const path: Path = []
    for (let i = from + 1; i < r; i += 1) {
      const between = out[i]
      if (between === undefined) continue
      const here = between.cells[fork]
      if (here === undefined || here.text === ' ') put(between, fork, '│', 'edge')
      path.push([i, fork])
    }
    put(row, fork, lastChild.get(`${item.depth}:${from}`) === item.id ? '╰' : '├', 'edge')
    path.push([r, fork])
    for (let c = fork + 1; c < node; c += 1) {
      put(row, c, '─', 'edge')
      path.push([r, c])
    }
    paths.set(item.id, path)
  }

  // 実行中の道筋に、外へ流れる光を置く
  const phase = Math.floor(now / TICK_MS)
  for (const item of items) {
    const path = paths.get(item.id)
    if (path === undefined || item.status !== 'running') continue
    path.forEach((at, k) => {
      if ((((k - phase) % PULSE_GAP) + PULSE_GAP) % PULSE_GAP === 0) tint(out, at, 'live')
    })
  }

  // 依頼の粒は出どころから点へ、結果の粒は点から出どころへ。粒の後ろに2マスの尾を引く
  for (const item of items) {
    const path = paths.get(item.id)
    if (path === undefined || path.length === 0) continue
    const fly = (at: number, steps: Path, head: string, tone: MapTone, trail: MapTone) => {
      const k = Math.min(steps.length - 1, Math.floor(((now - at) / FLIGHT_MS) * steps.length))
      for (const back of [2, 1]) {
        const cell = steps[k - back]
        if (cell !== undefined) tint(out, cell, trail)
      }
      const cell = steps[k]
      if (cell !== undefined) tint(out, cell, tone, head)
    }
    if (inFlight(item.endedAt, now) && item.endedAt !== undefined) {
      fly(item.endedAt, [...path].reverse(), '◆', 'back', 'backTrail')
    } else if (inFlight(item.startedAt, now) && item.startedAt !== undefined) {
      fly(item.startedAt, path, '●', 'flow', 'flowTrail')
    }
  }

  const lines = out.map(toLine)
  if (omitted > 0) lines.push({ key: 'more', segs: [{ text: `   ほか ${omitted} 体を省いた`, tone: 'more' }] })
  return lines
}

/** マスと後ろの文を、同じ色の続きでまとめた区切りにする */
const toLine = (row: Row): MapLine => {
  const segs: MapSeg[] = []
  for (const one of [...row.cells, ...row.tail]) {
    const prev = segs.at(-1)
    if (prev !== undefined && prev.tone === one.tone && prev.hue === one.hue) prev.text += one.text
    else segs.push({ ...one })
  }
  return { key: row.key, segs }
}
