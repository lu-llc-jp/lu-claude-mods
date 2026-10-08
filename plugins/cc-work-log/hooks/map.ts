import type { WorkLogAgent, WorkLogEntry, WorkLogStatus } from '../types'
import { CLAWD_ROWS } from './clawd'
import { seconds, shortModel } from './describe'
import { agentOf, agentStatus, splitTurns } from './tree'

/** 動いているあいだの描き直しの間隔(ms)。スピナーが滑らかに見える速さ */
export const TICK_MS = 150
/** 粒が道筋を渡りきるまでの時間(ms) */
export const FLIGHT_MS = 1200
/** 結果の粒が届いてから、メインのカードが光っている時間(ms) */
export const FLASH_MS = 900
/** 実行中を示すスピナーのコマ */
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
/** マップを描ける幅の下限。これより狭いペインでは、描く側が「幅が足りない」と出す */
export const MAP_MIN_WIDTH = 24
/** マップの幅の上限。広いペインでも線が間延びしないように止める */
const HUB_MAX = 72
/** 箱の幅の下限と上限(マス)。箱を横に並べて入らなければ、下限まで縮めてから省く */
const NODE_MIN = 14
const NODE_MAX = 24
/** 箱の高さ(上下の枠 + 中身3行) */
const NODE_ROWS = 5
/** 親の箱の下から子の箱の上までの行数(横に分ける行 + 下ろす行) */
const LINK_ROWS = 2
/** 流れる光の間隔(マス) */
const PULSE_GAP = 4
/** キャラを入れたメインのカードの中の行数。キャラの Raster の高さに合わせる */
const HUB_AVATAR_ROWS = CLAWD_ROWS
/** 前の依頼で起動して実行中のまま、これだけ動きが無いものは、終わりの知らせが来なかったものとしてマップから外す(ms) */
export const STALE_MS = 10 * 60_000

/**
 * マップの1区切りの色分け。
 * edge: 線、live: 実行中の道筋を流れる光、flow・flowTrail: 依頼の粒とその尾、back・backTrail: 結果の粒とその尾、
 * hub・hubIdle・hubFlash: メインのカードの枠(動いている・静か・結果が届いた)、title: カードの見出し、
 * spin: 実行中の点、ok・error: 終えた点、no: 通し番号、type: エージェントの種類(hue で色を変える)、
 * tool: 今のツール、timeLive: 経過時間、note: 所要時間など、more: 補足
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
  | 'tool'
  | 'timeLive'
  | 'note'
  | 'more'
/** hue は type の色の番号(種類ごとに決まる)。press があれば、描く側はその区切りを押せるボタンにし、押すとそのエージェントの詳細を開く */
export type MapSeg = { text: string; tone: MapTone; hue?: number; press?: string }
/**
 * マップの1行。描く側は segs を色付きの Text にするだけ。
 * メインのカードの中の行は、キャラを置く隙間の左右を left・right にも分けて持つ(キャラを描ける面はそのあいだに Raster を置く)
 */
export type MapLine = { key: string; segs: MapSeg[]; left?: MapSeg[]; right?: MapSeg[] }

/** 種類の色の数。描く側はこの数だけ色を用意する */
export const TYPE_HUES = 6

/** マップに置くサブエージェント1体 */
type Item = {
  id: string
  agent: WorkLogAgent
  status: WorkLogStatus
  /** 0 はメインから起動したもの。入れ子ほど大きく、下の段に置く */
  depth: number
  /** 起動した親のうち、マップに置かれているもの。無ければメインから起動したものとして扱う */
  parent?: string
  startedAt?: number
  endedAt?: number
  /** 実行中のツールの文 */
  tool?: string
}

/** マップに描くもの。描画では1回だけ組み立て、配置とキャラの様子で使い回す */
export type Scene = {
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

/**
 * 置くエージェントを、親子をたどる順(親の次にその子)に、起動した順で並べ、段(depth)と親(parent)を付ける。
 * 親が置かれていなければメインから起動したものとして扱う。親子のたどり方はここだけで決める
 */
const arrange = (items: readonly Item[], agents: Record<string, WorkLogAgent>): Item[] => {
  const byId = new Map(items.map(item => [item.id, item]))
  const byNo = [...items].sort((a, b) => a.agent.no - b.agent.no)
  const parentOf = (id: string): string | undefined => {
    const parent = agentOf(agents, id)?.parentId
    return parent !== undefined && byId.has(parent) ? parent : undefined
  }
  const out: Item[] = []
  const visit = (item: Item, depth: number) => {
    const parent = parentOf(item.id)
    out.push({ ...item, depth, ...(parent === undefined ? {} : { parent }) })
    for (const child of byNo) if (parentOf(child.id) === item.id) visit(child, depth + 1)
  }
  for (const item of byNo) if (parentOf(item.id) === undefined) visit(item, 0)
  return out
}

/**
 * マップに描くものを組み立てる。置くのは、直近の依頼(since)より後に起動したものと、まだ実行中のもの。
 * since が null(まだ依頼を受けていない)なら、覚えているものをすべて置く
 */
export const buildScene = (
  list: readonly WorkLogEntry[],
  agents: Record<string, WorkLogAgent>,
  since: number | null,
  now: number,
): Scene => {
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
    const earlier = since !== null && !(startedAt !== undefined && startedAt >= since)
    // 前の依頼で起動して、その依頼のうちに終えたものは置かない。完了の通知でターンが進んでも、次の依頼までは残る。
    // 前の依頼で起動して、新しい依頼のあとに終えたものは残す(結果の粒が戻るところを見せる)
    if (status !== 'running' && earlier && !(endedAt !== undefined && since !== null && endedAt >= since)) continue
    // 前の依頼で起動して実行中のまま、長く動きの無いものは、終わりの知らせが来なかった(セッションが落ちたなど)として外す
    if (status === 'running' && earlier) {
      const lastSeen = list.reduce((at, one) => (one.agentId === id ? Math.max(at, one.at) : at), startedAt ?? 0)
      if (now - lastSeen >= STALE_MS) continue
    }
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

  // 新しい依頼を受けたあと、まだ作業の行が無ければ、前のターンの終わりではなく「考えている」と出す
  const end = last?.end !== undefined && since !== null && since > last.end.at ? undefined : last?.end
  return {
    main: {
      status: end === undefined ? 'running' : (end.status ?? 'ok'),
      endText: end?.text,
      tool: end === undefined ? runningTool(list, undefined, spawnIds) : undefined,
    },
    items: arrange([...items.values()], agents),
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
export const mainMood = ({ main, items }: Scene, now: number): MainMood => {
  if (flashing(items, now)) return 'flash'
  if (main.status === 'running') return main.tool === undefined ? 'thinking' : 'busy'
  return main.status === 'ok' ? 'done' : 'error'
}

/**
 * マップが動いているか。メインがツールを使っている・実行中のサブエージェントがいる・粒が流れている・カードが光っている、のどれか。
 * 動いていなければ描き直しを止める
 */
export const isSceneAnimating = (scene: Scene, now: number): boolean =>
  scene.main.tool !== undefined ||
  flashing(scene.items, now) ||
  scene.items.some(item => item.status === 'running' || inFlight(item.startedAt, now) || inFlight(item.endedAt, now))


// ---- 描く ----

/** 1マス。2マスの文字の右隣は text '' で埋める */
type Cell = { text: string; tone: MapTone; hue?: number; press?: string }
/** slot: キャラを置く隙間(列 at から width 列)。描く側はそこに Raster を重ねる */
type Row = { key: string; cells: Cell[]; slot?: { at: number; width: number } }

const put = (row: Row, col: number, text: string, tone: MapTone, hue?: number, press?: string) => {
  while (row.cells.length <= col) row.cells.push({ text: ' ', tone: 'edge' })
  row.cells[col] = { text, tone, ...(hue === undefined ? {} : { hue }), ...(press === undefined ? {} : { press }) }
}

/** col から文字列を1マスずつ置き、次の列を返す。2マスの文字は右隣を空にする */
const putText = (row: Row, col: number, text: string, tone: MapTone, hue?: number, press?: string): number => {
  let at = col
  for (const ch of text) {
    put(row, at, ch, tone, hue, press)
    if (cellWidth(ch) === 2) put(row, at + 1, '', tone, hue, press)
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

/** 消費トークンを短く書く。850、12.3k、1.2M */
export const formatTokens = (n: number): string =>
  n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`

/**
 * メインのカード。上の枠に見出しとモデル、中に今の様子・サブエージェントの数・トークンの合計。
 * avatar > 0 なら、中の左に avatar 列のキャラの隙間を空け(行は avatar の高さ CLAWD_ROWS ぶん)、見出しの ◉ は付けない。
 * trunkAt: 下の枠に付け根 ┬ を付ける列(付けないなら undefined)
 */
const hubRows = (
  scene: Scene,
  mainModel: string,
  width: number,
  now: number,
  trunkAt: number | undefined,
  avatar: number,
): Row[] => {
  const { main, items } = scene
  const tone: MapTone = flashing(items, now) ? 'hubFlash' : main.status === 'running' ? 'hub' : 'hubIdle'
  const textAt = avatar > 0 ? 2 + avatar + 1 : 2
  const inner = width - textAt - 2

  const top: Row = { key: 'hub:top', cells: [] }
  let col = putText(top, 0, avatar > 0 ? '╭─ ' : '╭─ ◉ ', tone)
  col = putText(top, col, 'メイン', 'title')
  const model = mainModel === '' ? '' : ` ${shortModel(mainModel)} `
  col = putText(top, col, ` ${'─'.repeat(Math.max(0, width - col - cellWidth(model) - 3))}`, tone)
  col = putText(top, col, model, 'note')
  putText(top, col, '─╮', tone)

  const body = (key: string, segs: MapSeg[]): Row => {
    const row: Row = { key, cells: [], ...(avatar > 0 ? { slot: { at: 2, width: avatar } } : {}) }
    putText(row, 0, '│ ', tone)
    // キャラの隙間と、その右の1列の余白
    let at = putText(row, 2, ' '.repeat(textAt - 2), 'edge')
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

  // 数とトークンは、この依頼のサブエージェントすべてで数える(幅や高さが足りずに省いた箱のぶんも含む)
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
  const spent = items.reduce((sum, item) => sum + (item.agent.tokens ?? 0), 0)
  const total: MapSeg[] = spent === 0 ? [] : [{ text: `サブエージェントのトークン ${formatTokens(spent)}`, tone: 'note' }]

  const bottom: Row = { key: 'hub:bottom', cells: [] }
  putText(bottom, 0, `╰${'─'.repeat(width - 2)}╯`, tone)
  if (trunkAt !== undefined) put(bottom, trunkAt, '┬', tone)

  const inside = [doing, count, total]
  // キャラを置くなら、その高さぶん中の行を取る(キャラは上に1行の余白を持つので、文字はその余白の行から始める)
  while (avatar > 0 && inside.length < HUB_AVATAR_ROWS) inside.push([])
  return [top, ...inside.map((segs, i) => body(`hub:in:${i}`, segs)), bottom]
}

/** 箱の1行目: 番号と種類。番号は押せて、押すとそのエージェントの詳細を開く(種類は色を付けるため、ボタンにしない) */
const titleSegs = (item: Item, room: number): MapSeg[] => {
  const { agent } = item
  const no = `#${agent.no}`
  return [
    { text: no, tone: 'no', press: item.id },
    { text: ' ', tone: 'edge' },
    { text: fit(shortType(agent.type), room - cellWidth(no) - 1), tone: 'type', hue: hueOf(agent.type) },
  ]
}

/** 箱の2行目: 使っているモデル */
const modelSegs = (item: Item): MapSeg[] =>
  item.agent.model === '' ? [{ text: 'モデル不明', tone: 'more' }] : [{ text: shortModel(item.agent.model), tone: 'note' }]

/** 箱の3行目: 様子と時間。実行中はスピナーと経過時間、終えたら ✓ と所要時間 */
const statusSegs = (item: Item, now: number): MapSeg[] => {
  const { agent } = item
  if (item.status === 'running') {
    const elapsed = item.startedAt === undefined ? '' : seconds(Math.max(0, now - item.startedAt))
    return [
      { text: `${spinner(now)} `, tone: 'spin' },
      { text: elapsed === '' ? '作業中' : elapsed, tone: 'timeLive' },
    ]
  }
  const took = agent.durationMs === undefined ? '' : ` ${seconds(agent.durationMs)}`
  return item.status === 'ok'
    ? [{ text: `✓${took}`, tone: 'ok' }]
    : [{ text: `✗${took}`, tone: 'error' }]
}

/** 箱の枠の色。実行中は目立たせ、終えたら沈める。終えた瞬間は緑に光り、失敗は赤 */
const nodeTone = (item: Item, now: number): MapTone =>
  item.status === 'error'
    ? 'error'
    : item.endedAt !== undefined && now >= item.endedAt && now - item.endedAt < FLASH_MS
      ? 'hubFlash'
      : item.status === 'running'
        ? 'hub'
        : 'hubIdle'

/** 道筋。粒と光が通るマスを、出どころから箱の上の枠まで順に並べたもの */
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

/** 上下左右のどちらへ線が伸びるかから、罫線の文字を選ぶ */
const junction = (up: boolean, down: boolean, left: boolean, right: boolean): string => {
  const key = `${up ? 'u' : ''}${down ? 'd' : ''}${left ? 'l' : ''}${right ? 'r' : ''}`
  const table: Record<string, string> = {
    udlr: '┼', udl: '┤', udr: '├', ulr: '┴', dlr: '┬', ud: '│', lr: '─',
    dr: '╭', dl: '╮', ur: '╰', ul: '╯', u: '│', d: '│', l: '─', r: '─',
  }
  return table[key] ?? ' '
}

type Node = { item: Item; children: Node[]; x: number; width: number; center: number }

/**
 * マップの行を組み立てる。組織図のように、メインのカードを上に置き、その下に子のエージェントを箱にして横に並べる。
 * サブエージェントが起動したものは、親の箱の下に同じように並べる。箱は起動した順に左から置く。
 * 親から子へは、親の下から線を下ろして横に分け、子の箱の上へ下ろす。
 * 実行中の線には光が流れ、起動したては依頼の粒が親から子へ、終えたては結果の粒が子から親へ流れる。
 * 箱には、番号と種類(押すと詳細を開く)・モデル・様子と時間を出し、下の枠に消費トークンを載せる。
 * 置くのは、直近の依頼(since)より後に起動したものと、まだ実行中のもの。
 * 横か縦に入りきらなければ、終えたもの(古い順)、新しいもの、の順に省く。
 * 先頭の行(key が hub: で始まる)がメインのカード。avatar > 0 なら、カードの中の左に avatar 列のキャラの隙間を空け、
 * 中の行(key が hub:in: で始まる)の left・right に隙間の左右を分けて持たせる
 */
export const layoutMap = (
  list: readonly WorkLogEntry[],
  agents: Record<string, WorkLogAgent>,
  mainModel: string,
  now: number,
  rows: number,
  columns: number,
  { avatar = 0, since = null, scene: given }: { avatar?: number; since?: number | null; scene?: Scene } = {},
): MapLine[] => {
  const scene = given ?? buildScene(list, agents, since, now)
  const hubHeight = avatar > 0 ? 2 + HUB_AVATAR_ROWS : 5
  const width = Math.max(MAP_MIN_WIDTH, Math.min(columns, HUB_MAX))
  let kept = scene.items.map(item => item.id)
  let omitted = 0

  // 省いたものを除いて並べ直す(親を省いた子は、メインから起動したものとして上の段に上がる)
  const placed = (): Item[] => arrange(scene.items.filter(item => kept.includes(item.id)), agents)
  /** 葉(子の無い箱)の数。横に並ぶ箱の数の最大になる */
  const leaves = (items: readonly Item[]): number => {
    const parents = new Set(items.flatMap(item => item.parent ?? []))
    return items.filter(item => !parents.has(item.id)).length
  }
  const fits = (): boolean => {
    const items = placed()
    const levels = items.reduce((max, item) => Math.max(max, item.depth + 1), 0)
    const height = hubHeight + levels * (LINK_ROWS + NODE_ROWS) + (omitted > 0 ? 1 : 0)
    return height <= rows && leaves(items) * (NODE_MIN + 1) - 1 <= width
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
  while (!fits() && drop(ids => ids.filter(id => statusOf(id) !== 'running').sort((a, b) => byNo(a) - byNo(b))[0]));
  while (!fits() && drop(ids => [...ids].sort((a, b) => byNo(b) - byNo(a))[0]));

  const items = placed()
  // 箱の幅は、葉を横に並べて入る幅にする
  const nodeWidth = Math.max(NODE_MIN, Math.min(NODE_MAX, Math.floor((width + 1) / Math.max(1, leaves(items))) - 1))

  // 木を作り、左から順に場所を決める(親は子の並びの真ん中に置く)
  const nodes = new Map<string, Node>()
  for (const item of items) nodes.set(item.id, { item, children: [], x: 0, width: nodeWidth, center: 0 })
  const roots: Node[] = []
  for (const item of items) {
    const node = nodes.get(item.id)
    if (node === undefined) continue
    const parentNode = item.parent === undefined ? undefined : nodes.get(item.parent)
    if (parentNode === undefined) roots.push(node)
    else parentNode.children.push(node)
  }
  const span = (node: Node): number =>
    node.children.length === 0
      ? nodeWidth
      : Math.max(nodeWidth, node.children.reduce((sum, child) => sum + span(child), 0) + node.children.length - 1)
  const place = (node: Node, left: number) => {
    const total = span(node)
    let x = left + Math.floor((total - (node.children.reduce((sum, child) => sum + span(child), 0) + Math.max(0, node.children.length - 1))) / 2)
    for (const child of node.children) {
      place(child, x)
      x += span(child) + 1
    }
    const first = node.children[0]
    const last = node.children.at(-1)
    node.center =
      first === undefined || last === undefined ? left + Math.floor(total / 2) : Math.floor((first.center + last.center) / 2)
    node.x = Math.max(0, Math.min(width - nodeWidth, node.center - Math.floor(nodeWidth / 2)))
    node.center = node.x + Math.floor(nodeWidth / 2)
  }
  const forest = roots.reduce((sum, root) => sum + span(root), 0) + Math.max(0, roots.length - 1)
  // メインの付け根は、カードの真ん中。子の並びもそこを中心に置く
  const rootCenter = Math.floor(width / 2)
  let x = Math.max(0, Math.min(width - forest, rootCenter - Math.floor(forest / 2)))
  for (const root of roots) {
    place(root, x)
    x += span(root) + 1
  }

  const out: Row[] = hubRows(scene, mainModel, width, now, roots.length > 0 ? rootCenter : undefined, avatar)
  const rowAt = (r: number): Row => {
    while (out.length <= r) out.push({ key: `row:${out.length}`, cells: [] })
    return out[r] as Row
  }

  // 親(メインなら幹)の下から子の箱の上までの線を引き、道筋を覚える
  const paths = new Map<string, Path>()
  const link = (fromCol: number, busRow: number, children: readonly Node[]) => {
    const cols = [fromCol, ...children.map(child => child.center)]
    const min = Math.min(...cols)
    const max = Math.max(...cols)
    const row = rowAt(busRow)
    const downs = new Set(children.map(child => child.center))
    for (let c = min; c <= max; c += 1) {
      put(row, c, junction(c === fromCol, downs.has(c), c > min, c < max), 'edge')
    }
    for (const child of children) {
      put(rowAt(busRow + 1), child.center, '│', 'edge')
      const path: Path = [[busRow, fromCol]]
      const step = child.center >= fromCol ? 1 : -1
      for (let c = fromCol + step; step > 0 ? c <= child.center : c >= child.center; c += step) path.push([busRow, c])
      path.push([busRow + 1, child.center], [busRow + 2, child.center])
      paths.set(child.item.id, path)
    }
  }

  // 箱を描く
  const drawNode = (node: Node, top: number) => {
    const { item } = node
    const tone = nodeTone(item, now)
    const inner = nodeWidth - 4
    const border = (r: number, left: string, right: string, joinAt: number | undefined, join: string) => {
      const row = rowAt(r)
      putText(row, node.x, `${left}${'─'.repeat(nodeWidth - 2)}${right}`, tone)
      if (joinAt !== undefined) put(row, joinAt, join, tone)
    }
    border(top, '╭', '╮', node.center, '┴')
    const lines = [titleSegs(item, inner), modelSegs(item), statusSegs(item, now)]
    lines.forEach((segs, i) => {
      const row = rowAt(top + 1 + i)
      let at = putText(row, node.x, '│ ', tone)
      let room = inner
      for (const seg of segs) {
        const text = fit(seg.text, room)
        at = putText(row, at, text, seg.tone, seg.hue, seg.press)
        room -= cellWidth(text)
      }
      at = putText(row, at, ' '.repeat(Math.max(0, room)), 'edge')
      putText(row, at, ' │', tone)
    })
    border(top + NODE_ROWS - 1, '╰', '╯', node.children.length > 0 ? node.center : undefined, '┬')
    // 消費トークンは下の枠の右寄りに、前後に空白を置いて載せる(終えてから分かる)
    const spent: MapSeg | undefined =
      item.agent.tokens === undefined ? undefined : { text: `${formatTokens(item.agent.tokens)} tok`, tone: 'note' }
    if (spent !== undefined) {
      const row = rowAt(top + NODE_ROWS - 1)
      const w = cellWidth(spent.text)
      const right = node.x + nodeWidth - 3 - w
      const left = node.x + 2
      // 子へ下ろす付け根 ┬ とは重ねない。右に置けなければ左に置く
      const at =
        node.children.length === 0 || right - 1 > node.center
          ? right
          : left + w + 1 < node.center
            ? left
            : undefined
      if (at !== undefined) putText(row, putText(row, putText(row, at - 1, ' ', tone), spent.text, spent.tone), ' ', tone)
    }
  }

  const level = (depth: number) => hubHeight + depth * (LINK_ROWS + NODE_ROWS)
  if (roots.length > 0) link(rootCenter, level(0), roots)
  const walk = (node: Node) => {
    const top = level(node.item.depth) + LINK_ROWS
    drawNode(node, top)
    if (node.children.length > 0) link(node.center, top + NODE_ROWS, node.children)
    node.children.forEach(walk)
  }
  roots.forEach(walk)

  // 実行中の道筋に光を流し、起動したては依頼の粒、終えたては結果の粒を置く
  const phase = Math.floor(now / TICK_MS)
  for (const item of items) {
    const path = paths.get(item.id)
    if (path === undefined || path.length === 0) continue
    // 箱の上の枠(最後のマス)には粒も光も置かない
    const steps = path.slice(0, -1)
    if (item.status === 'running') {
      steps.forEach((at, k) => {
        if ((((k - phase) % PULSE_GAP) + PULSE_GAP) % PULSE_GAP === 0) tint(out, at, 'live')
      })
    }
    const fly = (at: number, route: Path, head: string, tone: MapTone, trail: MapTone) => {
      const k = Math.min(route.length - 1, Math.floor(((now - at) / FLIGHT_MS) * route.length))
      for (const back of [2, 1]) {
        const cell = route[k - back]
        if (cell !== undefined) tint(out, cell, trail)
      }
      const cell = route[k]
      if (cell !== undefined) tint(out, cell, tone, head)
    }
    if (inFlight(item.endedAt, now) && item.endedAt !== undefined) {
      fly(item.endedAt, [...steps].reverse(), '◆', 'back', 'backTrail')
    } else if (inFlight(item.startedAt, now) && item.startedAt !== undefined) {
      fly(item.startedAt, steps, '●', 'flow', 'flowTrail')
    }
  }

  const lines = out.map(toLine)
  if (omitted > 0) lines.push({ key: 'more', segs: [{ text: `ほか ${omitted} 体を省いた`, tone: 'more' }] })
  return lines
}

/** マスと後ろの文を、同じ色の続きでまとめた区切りにする */
const toSegs = (cells: readonly Cell[]): MapSeg[] => {
  const segs: MapSeg[] = []
  for (const one of cells) {
    const prev = segs.at(-1)
    if (prev !== undefined && prev.tone === one.tone && prev.hue === one.hue && prev.press === one.press) prev.text += one.text
    else segs.push({ ...one })
  }
  return segs
}

const toLine = (row: Row): MapLine => {
  const all = row.cells
  const line: MapLine = { key: row.key, segs: toSegs(all) }
  if (row.slot === undefined) return line
  return {
    ...line,
    left: toSegs(all.slice(0, row.slot.at)),
    right: toSegs(all.slice(row.slot.at + row.slot.width)),
  }
}
