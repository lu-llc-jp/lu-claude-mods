import type { WorkLogAgent, WorkLogEntry } from '../types'
import { seconds, shortModel } from './describe'
import {
  FLIGHT_MS,
  TICK_MS,
  TYPE_MS,
  buildScene,
  cellWidth,
  fit,
  flashing,
  hueOf,
  inFlight,
  order,
  shortType,
  spinner,
  type Item,
  type MapLine,
  type MapSeg,
} from './map'
import { agentOf } from './tree'
import { CLEAR, blankPixels, getPixel, mix, setPixel, toRaster, type Pixels, type RasterCells } from './raster'
import { ERROR_RED, OK_GREEN, drawBadge, drawSprite, kindOf, spriteSize } from './sprites'

/** メインの行数(キャラ 8×8 ドット = 4行) */
const MAIN_ROWS = 4
/** サブエージェント1体の行数(キャラ 6×6 ドット = 3行。3行目は名前の列では空き) */
const AGENT_ROWS = 3
/** メインから下ろす幹の x */
const TRUNK_X = 3
/** 枝が出る縦線から、キャラの左端までのドット数 */
const BRANCH = 3
/** キャラの左端から、その子へ下ろす縦線までのドット数 */
const CHILD_LINE = 2
/** ドット絵と名前の列のあいだ */
const GAP = 2

const LINE = 0x5b616b
const PULSE = 0xffb86b
const REQUEST = 0xffe9a8
const LAMP_IDLE = 0x777777
const LAMP_ON = 0xffd54a
const LAMP_DIM = 0x7a6420
/** まばたきの周期と、目を閉じている時間(ms) */
const BLINK_EVERY = 2400
const BLINK_FOR = 150
/** 流れる光の間隔(ドット) */
const PULSE_GAP = 6

export type PixelMap = { raster: RasterCells; lines: MapLine[] }

/** 深さ depth のキャラの左端 */
const spriteX = (depth: number): number => TRUNK_X + BRANCH + depth * (BRANCH + CHILD_LINE)

type Path = Array<[x: number, y: number]>

/**
 * マップをドット絵で組み立てる。左の Raster にキャラと呼び出しの線を、右の文字の列に名前と様子を、同じ行にそろえて置く。
 * メインを上に置き、その下に幹を下ろして、サブエージェントを起動した順に吊るす。入れ子は親の下から線を下ろして右へずらす。
 * rows に入りきらなければ、終えたもの(古い順)、新しいもの、の順に省く
 */
export const layoutPixelMap = (
  list: readonly WorkLogEntry[],
  agents: Record<string, WorkLogAgent>,
  mainModel: string,
  now: number,
  rows: number,
  columns: number,
): PixelMap => {
  const scene = buildScene(list, agents, now)
  let kept = scene.items.map(item => item.id)
  let omitted = 0
  const placed = (): Item[] => {
    const byId = new Map(scene.items.map(item => [item.id, item]))
    return order(kept, agents).flatMap(({ id, depth }) => {
      const item = byId.get(id)
      return item === undefined ? [] : [{ ...item, depth }]
    })
  }
  const height = () => MAIN_ROWS + placed().length * AGENT_ROWS + (omitted > 0 ? 1 : 0)
  const byNo = (id: string) => agentOf(agents, id)?.no ?? 0
  const statusOf = (id: string) => scene.items.find(item => item.id === id)?.status
  const drop = (pick: (ids: string[]) => string | undefined): boolean => {
    const id = pick(kept)
    if (id === undefined) return false
    kept = kept.filter(one => one !== id)
    omitted += 1
    return true
  }
  while (height() > rows && drop(ids => ids.filter(id => statusOf(id) !== 'running').sort((a, b) => byNo(a) - byNo(b))[0]));
  while (height() > rows && drop(ids => [...ids].sort((a, b) => byNo(b) - byNo(a))[0]));

  const items = placed()
  const totalRows = height()
  const maxDepth = items.reduce((max, item) => Math.max(max, item.depth), 0)
  // 右端の印(4ドット)まで入る幅。メインのキャラより狭くはしない
  const width = Math.max(spriteSize('main').width, spriteX(maxDepth) + 6 + 1 + 4)
  const pixels = blankPixels(width, totalRows * 2)

  // ---- メイン ----
  const { main } = scene
  const lamp = flashing(scene.items, now)
    ? OK_GREEN
    : main.tool !== undefined
      ? Math.floor(now / 300) % 2 === 0
        ? LAMP_ON
        : LAMP_DIM
      : main.status === 'running'
        ? LAMP_ON
        : LAMP_IDLE
  drawSprite(pixels, 'main', 0, 0, { accent: lamp, blink: blinking(now, 0) })

  // ---- サブエージェントのキャラと線 ----
  const topOf = new Map<string, number>()
  items.forEach((item, i) => topOf.set(item.id, MAIN_ROWS + i * AGENT_ROWS))
  const paths = new Map<string, Path>()
  for (const item of items) {
    const row = topOf.get(item.id) ?? 0
    const y = row * 2
    const x = spriteX(item.depth)
    const kind = kindOf(item.agent.type)
    const { height: h } = spriteSize(kind)

    // 線: 親の下(メインなら幹)から縦に下ろし、キャラの真ん中の高さで右へ曲げる
    const parent = item.depth === 0 ? undefined : agentOf(agents, item.id)?.parentId
    const parentTop = parent === undefined ? undefined : topOf.get(parent)
    const lineX = item.depth === 0 || parentTop === undefined ? TRUNK_X : spriteX(item.depth - 1) + CHILD_LINE
    const fromY = item.depth === 0 || parentTop === undefined ? spriteSize('main').height : parentTop * 2 + 6
    const midY = y + Math.floor(h / 2)
    const path: Path = []
    for (let py = fromY; py <= midY; py += 1) path.push([lineX, py])
    for (let px = lineX + 1; px < x; px += 1) path.push([px, midY])
    for (const [px, py] of path) setPixel(pixels, px, py, LINE)
    paths.set(item.id, path)

    const done = item.status !== 'running'
    drawSprite(pixels, kind, x, y, {
      blink: !done && blinking(now, item.agent.no),
      fade: done ? 0.55 : undefined,
      tint: item.status === 'error' ? ERROR_RED : undefined,
    })
    if (done) drawBadge(pixels, item.status === 'ok', x + 7, y + 3)
  }

  // ---- 動き: 実行中の線に流れる光、依頼と結果の粒 ----
  const phase = Math.floor(now / TICK_MS)
  for (const item of items) {
    const path = paths.get(item.id)
    if (path === undefined || path.length === 0) continue
    if (item.status === 'running') {
      path.forEach(([px, py], k) => {
        if ((((k - phase) % PULSE_GAP) + PULSE_GAP) % PULSE_GAP === 0) setPixel(pixels, px, py, PULSE)
      })
    }
    const fly = (at: number, steps: Path, color: number) => {
      const k = Math.min(steps.length - 1, Math.floor(((now - at) / FLIGHT_MS) * steps.length))
      for (const back of [2, 1]) {
        const cell = steps[k - back]
        if (cell !== undefined) setPixel(pixels, cell[0], cell[1], mix(LINE, color, back === 1 ? 0.7 : 0.4))
      }
      const head = steps[k]
      if (head === undefined) return
      // 粒は線より太い 2×2 にして目立たせる
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        // 先頭のドットのほかは、空いているところだけ塗る(キャラを欠けさせない)
        if ((dx === 0 && dy === 0) || getPixel(pixels, head[0] + dx, head[1] + dy) === CLEAR) {
          setPixel(pixels, head[0] + dx, head[1] + dy, color)
        }
      }
    }
    if (inFlight(item.endedAt, now) && item.endedAt !== undefined) {
      fly(item.endedAt, [...path].reverse(), item.status === 'error' ? ERROR_RED : OK_GREEN)
    } else if (inFlight(item.startedAt, now) && item.startedAt !== undefined) {
      fly(item.startedAt, path, REQUEST)
    }
  }

  // ---- 右の文字の列 ----
  const textWidth = Math.max(10, columns - width - GAP)
  const lines: MapLine[] = []
  const live = scene.items.filter(item => item.status === 'running').length
  const ok = scene.items.filter(item => item.status === 'ok').length
  const ng = scene.items.filter(item => item.status === 'error').length
  lines.push({
    key: 'hub:name',
    segs: [
      { text: 'メイン', tone: 'title' },
      ...(mainModel === '' ? [] : [{ text: `  ${shortModel(mainModel)}`, tone: 'note' as const }]),
    ],
  })
  lines.push({
    key: 'hub:now',
    segs:
      main.status !== 'running'
        ? [
            { text: main.status === 'ok' ? '✓ ' : '✗ ', tone: main.status },
            { text: fit(main.endText ?? '', textWidth - 2), tone: 'note' },
          ]
        : main.tool !== undefined
          ? [
              { text: `${spinner(now)} `, tone: 'spin' },
              { text: fit(main.tool, textWidth - 2), tone: 'tool' },
            ]
          : [{ text: '… 考えています', tone: 'note' }],
  })
  lines.push({
    key: 'hub:count',
    segs:
      scene.items.length === 0
        ? [{ text: 'サブエージェントはいません', tone: 'more' }]
        : [
            { text: `${live > 0 ? spinner(now) : '·'} ${live} 動作中`, tone: live > 0 ? 'spin' : 'more' },
            { text: '  ', tone: 'edge' },
            { text: `✓ ${ok} 完了`, tone: ok > 0 ? 'ok' : 'more' },
            ...(ng > 0 ? [{ text: '  ', tone: 'edge' as const }, { text: `✗ ${ng} 失敗`, tone: 'error' as const }] : []),
          ],
  })
  lines.push({ key: 'hub:gap', segs: [] })

  for (const item of items) {
    lines.push({ key: `agent:${item.id}`, segs: nameSegs(item, mainModel, textWidth, now) })
    lines.push({ key: `sub:${item.id}`, segs: subSegs(item, textWidth) })
    lines.push({ key: `gap:${item.id}`, segs: [] })
  }
  if (omitted > 0) lines.push({ key: 'more', segs: [{ text: `ほか ${omitted} 体を省いた`, tone: 'more' }] })

  return { raster: toRaster(pixels), lines }
}

/** no ごとに少しずらして、みんなが同時にまばたきしないようにする */
const blinking = (now: number, no: number): boolean => (now + no * 700) % BLINK_EVERY < BLINK_FOR

/** 名前の行: 番号・種類(色)・モデル・説明と、右端の時間 */
const nameSegs = (item: Item, mainModel: string, width: number, now: number): MapSeg[] => {
  const { agent } = item
  const done = item.status !== 'running'
  const model = agent.model !== '' && shortModel(agent.model) !== shortModel(mainModel) ? shortModel(agent.model) : ''
  const time = done
    ? agent.durationMs === undefined
      ? ''
      : seconds(agent.durationMs)
    : item.startedAt === undefined
      ? ''
      : seconds(Math.max(0, now - item.startedAt))
  const head: MapSeg[] = [
    { text: `#${agent.no} `, tone: 'no' },
    { text: shortType(agent.type), tone: 'type', hue: hueOf(agent.type) },
    ...(model === '' ? [] : [{ text: `·${model}`, tone: 'note' as const }]),
    { text: '  ', tone: 'edge' },
  ]
  const used = head.reduce((sum, seg) => sum + cellWidth(seg.text), 0)
  const typing = !done && item.startedAt !== undefined && now - item.startedAt < TYPE_MS
  const chars = [...agent.name]
  const shown = typing
    ? chars.slice(0, Math.ceil((chars.length * Math.max(0, now - (item.startedAt ?? now))) / TYPE_MS)).join('')
    : agent.name
  const cursor = typing ? 1 : 0
  const name = fit(shown, Math.max(4, width - used - cursor - (time === '' ? 0 : cellWidth(time) + 1)))
  const segs: MapSeg[] = [...head, { text: name, tone: done ? 'labelDone' : 'label' }]
  if (typing) segs.push({ text: '▍', tone: 'cursor' })
  if (time !== '') {
    segs.push({ text: ' '.repeat(Math.max(1, width - used - cellWidth(name) - cursor - cellWidth(time))), tone: 'edge' })
    segs.push({ text: time, tone: done ? 'note' : 'timeLive' })
  }
  return segs
}

/** 名前の下の行: 実行中なら今のツール、終えたら結果 */
const subSegs = (item: Item, width: number): MapSeg[] => {
  if (item.status === 'running') {
    return item.tool === undefined ? [] : [{ text: fit(item.tool, width), tone: 'tool' }]
  }
  return item.status === 'ok' ? [{ text: '✓ 回答した', tone: 'ok' }] : [{ text: '✗ 中断・エラーで終えた', tone: 'error' }]
}
