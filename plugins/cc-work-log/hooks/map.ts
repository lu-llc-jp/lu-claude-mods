import type { WorkLogAgent, WorkLogEntry, WorkLogStatus } from '../types'
import { AVATAR_ROWS } from './avatar'
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
/** マップの幅の上限。広いペインでは箱を横に多く並べ、それより広くても線が間延びしないように止める */
const MAP_MAX = 120
/** 箱の幅の下限と上限(マス)。箱を横に並べて入らなければ、下限まで縮めて折り返す */
const NODE_MIN = 14
const NODE_MAX = 24
/** 箱の高さ(上下の枠 + 中身3行) */
const NODE_ROWS = 5
/** 親の箱の下から子の箱の上までの行数(横に分ける行 + 下ろす行) */
const LINK_ROWS = 2
/** 折り返すときに左端に空ける列(下ろす線 + 箱とのあいだ)。折り返さないときは空けない */
const GUTTER = 2
/** 流れる光の間隔(マス) */
const PULSE_GAP = 4
/** キャラを入れたメインのカードの中の行数。キャラの Raster の高さに合わせる */
const HUB_AVATAR_ROWS = AVATAR_ROWS
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
  // メインの様子は、メインの行だけで決める(バックグラウンドのサブエージェントの行で、メインが続いているように見えないように)
  const last = splitTurns(list.filter(one => one.agentId === undefined)).at(-1)
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
      // ログは直近 50 件しか残らないので、覚えた最後の時刻(lastActiveAt)を主に使う
      const lastSeen = list.reduce(
        (at, one) => (one.agentId === id ? Math.max(at, one.at) : at),
        Math.max(agent.lastActiveAt ?? 0, startedAt ?? 0),
      )
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
  // 999,950 以上は k で書くと 1000.0k になるので M にする
  n < 1000 ? String(n) : n < 999_950 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`

/**
 * メインのカード。上の枠に見出しとモデル、中に今の様子・サブエージェントの数・トークンの合計。
 * avatar > 0 なら、中の左に avatar 列のキャラの隙間を空け(行はキャラの高さ AVATAR_ROWS ぶん)、見出しの ◉ は付けない。
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

type Node = { item: Item; children: Node[] }
/** 置いた箱。x・y は箱の左上。parent: 子を持つ(下の枠に付け根 ┬ を付ける) */
type Box = { item: Item; x: number; y: number; parent: boolean }
/**
 * 塊。箱1つと、その下に並ぶ子孫を、塊の左上を原点にして持つ。
 * id・center は一番上の箱のエージェントと、その真ん中の列(親からの線が下りてくるところ)
 */
type Block = { id: string; width: number; height: number; center: number; boxes: Box[]; paths: Map<string, Path> }
/** 同じ親の子の並び。rows は行ごとの上の端(横に分ける行)と、そこに置く塊とその左の列。mid は1行目の子の真ん中 */
type Group = { width: number; height: number; mid: number; rows: Array<{ y: number; cells: Array<{ block: Block; x: number }> }> }

/** 角を順に縦か横に結び、通るマスを並べる */
const route = (...corners: Array<[number, number]>): Path => {
  const path: Path = []
  for (const [r, c] of corners) {
    const prev = path.at(-1)
    if (prev === undefined) {
      path.push([r, c])
      continue
    }
    let [pr, pc] = prev
    while (pr !== r || pc !== c) {
      pr += Math.sign(r - pr)
      pc += Math.sign(c - pc)
      path.push([pr, pc])
    }
  }
  return path
}

/** 塊を横に並べたときの幅(あいだに1列ずつ空ける) */
const across = (blocks: readonly Block[]): number => blocks.reduce((sum, block) => sum + block.width + 1, 0) - 1

/** node とその子孫を、幅 room に収まる塊にする。収まらなければ undefined */
const blockOf = (node: Node, room: number, w: number): Block | undefined => {
  const box = (x: number): Box => ({ item: node.item, x, y: 0, parent: node.children.length > 0 })
  if (node.children.length === 0) {
    return { id: node.item.id, width: w, height: NODE_ROWS, center: Math.floor(w / 2), boxes: [box(0)], paths: new Map() }
  }
  const group = groupOf(node.children, room, w)
  if (group === undefined) return undefined
  const width = Math.max(w, group.width)
  const gx = Math.floor((width - group.width) / 2)
  // 親の箱は、1行目の子の並びの真ん中に置く
  const x = Math.max(0, Math.min(width - w, gx + group.mid - Math.floor(w / 2)))
  const center = x + Math.floor(w / 2)
  const joined = join(group, center - gx)
  return {
    id: node.item.id,
    width,
    height: NODE_ROWS + group.height,
    center,
    boxes: [box(x), ...joined.boxes.map(one => ({ ...one, x: one.x + gx, y: one.y + NODE_ROWS }))],
    paths: new Map([...joined.paths].map(([id, path]) => [id, path.map(([r, c]): [number, number] => [r + NODE_ROWS, c + gx])])),
  }
}

/**
 * 同じ親の子を、幅 room に並べる。1行に入れば1行に並べる。
 * 入らなければ左端に線のための列(GUTTER)を空けて折り返す。子を持つ箱は1行目に置き、折り返すのは子を持たない箱だけ
 */
const groupOf = (children: readonly Node[], room: number, w: number): Group | undefined => {
  const rowsOf = (lines: ReadonlyArray<readonly Block[]>, left: number): Group => {
    const rows: Group['rows'] = []
    let y = 0
    for (const blocks of lines) {
      let x = left
      rows.push({ y, cells: blocks.map(block => ({ block, x: (x += block.width + 1) - block.width - 1 })) })
      y += LINK_ROWS + Math.max(...blocks.map(block => block.height))
    }
    const first = rows[0]?.cells ?? []
    const head = first[0]
    const tail = first.at(-1)
    return {
      width: left + Math.max(...lines.map(across)),
      height: y,
      mid: head === undefined || tail === undefined ? 0 : Math.floor((head.x + head.block.center + tail.x + tail.block.center) / 2),
      rows,
    }
  }
  const flat = children.map(child => blockOf(child, room, w))
  if (flat.every(block => block !== undefined) && across(flat) <= room) return rowsOf([flat], 0)

  const inner = room - GUTTER
  if (inner < w) return undefined
  const nests = children.filter(child => child.children.length > 0)
  // 子を持つ箱がそろって1行目に入らなければ、幅を等分して、その子の並びも折り返させる
  let big = nests.map(child => blockOf(child, inner, w))
  if (!big.every(block => block !== undefined) || across(big) > inner) {
    big = nests.map(child => blockOf(child, Math.floor((inner + 1) / nests.length) - 1, w))
  }
  if (!big.every(block => block !== undefined) || across(big) > inner) return undefined
  const blocks = new Map(nests.map((child, i) => [child, big[i] as Block]))
  // 1行目には、子を持つ箱と、残りの幅に入るだけの子を持たない箱を、起動した順に置く。残りは1行に入るだけずつ折り返す
  let used = across(big)
  const first: Node[] = []
  const rest: Node[] = []
  for (const child of children) {
    if (blocks.has(child)) first.push(child)
    else if (rest.length === 0 && used + 1 + w <= inner) {
      first.push(child)
      used += w + 1
    } else rest.push(child)
  }
  const leaf = (child: Node): Block => blocks.get(child) ?? (blockOf(child, inner, w) as Block)
  const lines: Block[][] = [first.map(leaf)]
  const perRow = Math.floor((inner + 1) / (w + 1))
  for (let i = 0; i < rest.length; i += perRow) lines.push(rest.slice(i, i + perRow).map(leaf))
  return rowsOf(lines, GUTTER)
}

/**
 * 子の並びに線をつなぐ。from は親から線が下りてくる列。
 * 1行目へは、親の下から横に分けて子の箱の上へ下ろす。2行目より下へは、上の行の箱を突き抜けないよう、
 * 左端の列まで横に出てから下ろし、その行の上で横に分けて下ろす
 */
const join = (group: Group, from: number): Pick<Block, 'boxes' | 'paths'> => {
  const boxes: Box[] = []
  const paths = new Map<string, Path>()
  group.rows.forEach(({ y, cells }, i) => {
    const top = y + LINK_ROWS
    for (const { block, x } of cells) {
      const c = x + block.center
      paths.set(block.id, i === 0 ? route([0, from], [0, c], [top, c]) : route([0, from], [0, 0], [y, 0], [y, c], [top, c]))
      boxes.push(...block.boxes.map(one => ({ ...one, x: one.x + x, y: one.y + top })))
      for (const [id, path] of block.paths) paths.set(id, path.map(([r, cc]): [number, number] => [r + top, cc + x]))
    }
  })
  return { boxes, paths }
}

/** 置くもの(親子をたどる順)を木にする */
const treeOf = (items: readonly Item[]): Node[] => {
  const nodes = new Map(items.map(item => [item.id, { item, children: [] } as Node]))
  const roots: Node[] = []
  for (const item of items) {
    const node = nodes.get(item.id)
    if (node === undefined) continue
    const parentNode = item.parent === undefined ? undefined : nodes.get(item.parent)
    if (parentNode === undefined) roots.push(node)
    else parentNode.children.push(node)
  }
  return roots
}

/** 葉(子の無い箱)の数。1行に並べるなら、横に並ぶ箱の数になる */
const leaves = (items: readonly Item[]): number => {
  const parents = new Set(items.flatMap(item => item.parent ?? []))
  return items.filter(item => !parents.has(item.id)).length
}

/**
 * 箱の幅を決め、メインの下に子を並べる。1行に入るなら、葉を横に並べて入る幅にする。
 * 入らなければ折り返す。幅は、左端の線の列を除いた幅に、いちばん細い箱が入るだけ並べて決める
 */
const planMap = (items: readonly Item[], width: number, rootCenter: number) => {
  const count = leaves(items)
  const clamp = (n: number) => Math.max(NODE_MIN, Math.min(NODE_MAX, n))
  const perRow = Math.max(1, Math.floor((width - GUTTER + 1) / (NODE_MIN + 1)))
  const w =
    count * (NODE_MIN + 1) - 1 <= width
      ? clamp(Math.floor((width + 1) / Math.max(1, count)) - 1)
      : clamp(Math.floor((width - GUTTER + 1) / perRow) - 1)
  const roots = treeOf(items)
  if (roots.length === 0) return { width: w, height: 0, roots: 0, boxes: [], paths: new Map<string, Path>() }
  const group = groupOf(roots, width, w)
  if (group === undefined) return undefined
  // 子の並びは、メインの付け根(カードの真ん中)を中心に置く
  const gx = Math.max(0, Math.min(width - group.width, rootCenter - Math.floor(group.width / 2)))
  const { boxes, paths } = join(group, rootCenter - gx)
  return {
    width: w,
    height: group.height,
    roots: roots.length,
    boxes: boxes.map(one => ({ ...one, x: one.x + gx })),
    paths: new Map([...paths].map(([id, path]) => [id, path.map(([r, c]): [number, number] => [r, c + gx])])),
  }
}

/**
 * マップの行を組み立てる。組織図のように、メインのカードを上に置き、その下に子のエージェントを箱にして横に並べる。
 * サブエージェントが起動したものは、親の箱の下に同じように並べる。箱は起動した順に左から置く。
 * 親から子へは、親の下から線を下ろして横に分け、子の箱の上へ下ろす。
 * 同じ親の子が横に入りきらなければ、次の行に折り返す。折り返した行へは、左端に下ろした線から分けてつなぐ。
 * 実行中の線には光が流れ、起動したては依頼の粒が親から子へ、終えたては結果の粒が子から親へ流れる。
 * 箱には、番号と種類(押すと詳細を開く)・モデル・様子と時間を出し、下の枠に消費トークンを載せる。
 * 置くのは、直近の依頼(since)より後に起動したものと、まだ実行中のもの。
 * 折り返しても入りきらなければ、終えたもの(古い順)、新しいもの、の順に省く。
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
  const width = Math.max(MAP_MIN_WIDTH, Math.min(columns, MAP_MAX))
  // メインの付け根は、カードの真ん中
  const rootCenter = Math.floor(width / 2)
  let kept = scene.items.map(item => item.id)
  let omitted = 0

  // 省いたものを除いて並べ直す(親を省いた子は、メインから起動したものとして上の段に上がる)
  const placed = (): Item[] => arrange(scene.items.filter(item => kept.includes(item.id)), agents)
  const fits = (): boolean => {
    const plan = planMap(placed(), width, rootCenter)
    return plan !== undefined && hubHeight + plan.height + (omitted > 0 ? 1 : 0) <= rows
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
  const plan = planMap(items, width, rootCenter) ?? { width: NODE_MIN, height: 0, roots: 0, boxes: [], paths: new Map<string, Path>() }
  const nodeWidth = plan.width
  // 道筋は、メインのカードの下の行から数える
  const paths = new Map([...plan.paths].map(([id, path]) => [id, path.map(([r, c]): [number, number] => [r + hubHeight, c])]))

  const out: Row[] = hubRows(scene, mainModel, width, now, plan.roots > 0 ? rootCenter : undefined, avatar)
  const rowAt = (r: number): Row => {
    while (out.length <= r) out.push({ key: `row:${out.length}`, cells: [] })
    return out[r] as Row
  }

  // 線を引く。道筋の向きをマスごとに集め、上下左右のつながりから罫線の文字を選ぶ(重なる道筋は分かれ目になる)。
  // 道筋の最後のマスは子の箱の上の枠なので、線にはしない。最初のマスは親の下の枠(またはカード)につながる
  const ways = new Map<string, { r: number; c: number; u: boolean; d: boolean; l: boolean; rt: boolean }>()
  const way = (r: number, c: number) => {
    const key = `${r}:${c}`
    const found = ways.get(key)
    if (found !== undefined) return found
    const made = { r, c, u: false, d: false, l: false, rt: false }
    ways.set(key, made)
    return made
  }
  const toward = (one: { u: boolean; d: boolean; l: boolean; rt: boolean }, dr: number, dc: number) => {
    if (dr < 0) one.u = true
    if (dr > 0) one.d = true
    if (dc < 0) one.l = true
    if (dc > 0) one.rt = true
  }
  for (const path of paths.values()) {
    path.forEach(([r, c], k) => {
      if (k === path.length - 1) return
      const here = way(r, c)
      if (k === 0) here.u = true
      const next = path[k + 1]
      if (next !== undefined) toward(here, next[0] - r, next[1] - c)
      const prev = path[k - 1]
      if (prev !== undefined) toward(here, prev[0] - r, prev[1] - c)
    })
  }
  for (const { r, c, u, d, l, rt } of ways.values()) put(rowAt(r), c, junction(u, d, l, rt), 'edge')

  // 箱を描く
  const drawNode = ({ item, x, y, parent }: Box) => {
    const top = y + hubHeight
    const center = x + Math.floor(nodeWidth / 2)
    const tone = nodeTone(item, now)
    const inner = nodeWidth - 4
    const border = (r: number, left: string, right: string, joinAt: number | undefined, join: string) => {
      const row = rowAt(r)
      putText(row, x, `${left}${'─'.repeat(nodeWidth - 2)}${right}`, tone)
      if (joinAt !== undefined) put(row, joinAt, join, tone)
    }
    border(top, '╭', '╮', center, '┴')
    const lines = [titleSegs(item, inner), modelSegs(item), statusSegs(item, now)]
    lines.forEach((segs, i) => {
      const row = rowAt(top + 1 + i)
      let at = putText(row, x, '│ ', tone)
      let room = inner
      for (const seg of segs) {
        const text = fit(seg.text, room)
        at = putText(row, at, text, seg.tone, seg.hue, seg.press)
        room -= cellWidth(text)
      }
      at = putText(row, at, ' '.repeat(Math.max(0, room)), 'edge')
      putText(row, at, ' │', tone)
    })
    border(top + NODE_ROWS - 1, '╰', '╯', parent ? center : undefined, '┬')
    // 消費トークンは下の枠の右寄りに、前後に空白を置いて載せる(終えてから分かる)
    const spent: MapSeg | undefined =
      item.agent.tokens === undefined ? undefined : { text: `${formatTokens(item.agent.tokens)} tok`, tone: 'note' }
    if (spent !== undefined) {
      const row = rowAt(top + NODE_ROWS - 1)
      const w = cellWidth(spent.text)
      const right = x + nodeWidth - 3 - w
      const left = x + 2
      // 子へ下ろす付け根 ┬ とは重ねない。右に置けなければ左に置く
      // 左下の角 ╰ を消さないよう、前の空白は角より右に置く
      const at =
        right - 1 > x && (!parent || right - 1 > center)
          ? right
          : left + w + 1 < center
            ? left
            : undefined
      if (at !== undefined) putText(row, putText(row, putText(row, at - 1, ' ', tone), spent.text, spent.tone), ' ', tone)
    }
  }
  plan.boxes.forEach(drawNode)

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
