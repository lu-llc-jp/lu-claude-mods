import type { WorkLogAgent, WorkLogEntry, WorkLogStatus } from '../types'
import { seconds, shortModel } from './describe'
import {
  FLASH_MS,
  FLIGHT_MS,
  TICK_MS,
  TYPE_MS,
  buildScene,
  flashing,
  hueOf,
  inFlight,
  order,
  shortType,
  spinner,
  type Item,
  type MapSeg,
} from './map'
import { blankPixels, toRaster, type RasterCells } from './raster'
import { OK_GREEN, drawSprite, kindOf, type SpriteKind, type SpriteLook } from './sprites'
import { agentOf } from './tree'

/** カード1枚の行数(上下の枠 + 中身3行) */
export const CARD_ROWS = 5
/** 入れ子1段ぶんの、左の線の幅 */
export const INDENT = 3

/** カードの枠の色。live: 実行中、done: 終えた、error: 失敗、flash: 結果が届いた、idle: メインが待っている */
export type CardTone = 'live' | 'done' | 'error' | 'flash' | 'idle'

/** カード1枚。描く側は、左の線(gutter)・枠・キャラ・3行の文字を並べるだけ */
export type Card = {
  key: string
  depth: number
  tone: CardTone
  sprite: { kind: SpriteKind; raster: RasterCells }
  /** 1行目の左: 番号・種類・モデル */
  title: MapSeg[]
  /** 1行目の右: 時間 */
  time?: MapSeg
  /** 2行目: 説明 */
  name: MapSeg[]
  /** 3行目: 今していること、または結果 */
  activity: MapSeg[]
  /** カードの左に引く線。CARD_ROWS 行ぶん。メインのカードには無い */
  gutter: MapSeg[][]
}

export type CardsLayout = { main: Card; cards: Card[]; omitted: number }

const BLINK_EVERY = 2400
const BLINK_FOR = 150
const LAMP_IDLE = 0x777777
const LAMP_ON = 0xffd54a
const LAMP_DIM = 0x7a6420

/** no ごとに少しずらして、みんなが同時にまばたきしないようにする */
const blinking = (now: number, no: number): boolean => (now + no * 700) % BLINK_EVERY < BLINK_FOR

const spriteRaster = (kind: SpriteKind, look: SpriteLook): RasterCells => {
  const pixels = blankPixels(kind === 'main' ? 8 : 6, 6)
  drawSprite(pixels, kind, 0, 0, look)
  return toRaster(pixels)
}

/**
 * マップをカードで組み立てる。メインのカードを上に置き、その下にサブエージェントのカードを起動した順に並べる。
 * 呼び出しの関係は、カードの左にツリーの線で描く(入れ子は INDENT ずつ右へずらす)。
 * rows に入りきらなければ、終えたもの(古い順)、新しいもの、の順に省く
 */
export const layoutCards = (
  list: readonly WorkLogEntry[],
  agents: Record<string, WorkLogAgent>,
  mainModel: string,
  now: number,
  rows: number,
): CardsLayout => {
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
  const height = () => CARD_ROWS * (1 + placed().length) + (omitted > 0 ? 1 : 0)
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

  return { main: mainCard(scene.main, scene.items, mainModel, now), cards: withGutters(items, agents, mainModel, now), omitted }
}

const mainCard = (
  main: { status: WorkLogStatus; endText?: string; tool?: string },
  all: readonly Item[],
  mainModel: string,
  now: number,
): Card => {
  const flash = flashing(all, now)
  const lamp = flash
    ? OK_GREEN
    : main.tool !== undefined
      ? Math.floor(now / 300) % 2 === 0
        ? LAMP_ON
        : LAMP_DIM
      : main.status === 'running'
        ? LAMP_ON
        : LAMP_IDLE
  const live = all.filter(item => item.status === 'running').length
  const ok = all.filter(item => item.status === 'ok').length
  const ng = all.filter(item => item.status === 'error').length
  return {
    key: 'main',
    depth: -1,
    tone: flash ? 'flash' : main.status === 'running' ? 'live' : 'idle',
    sprite: { kind: 'main', raster: spriteRaster('main', { accent: lamp, blink: blinking(now, 0) }) },
    title: [
      { text: 'メイン', tone: 'title' },
      ...(mainModel === '' ? [] : [{ text: ` · ${shortModel(mainModel)}`, tone: 'note' as const }]),
    ],
    name:
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
          : [{ text: '… 考えています', tone: 'note' }],
    activity:
      all.length === 0
        ? [{ text: 'サブエージェントはいません', tone: 'more' }]
        : [
            { text: `${live > 0 ? spinner(now) : '·'} ${live} 動作中`, tone: live > 0 ? 'spin' : 'more' },
            { text: '  ', tone: 'edge' },
            { text: `✓ ${ok} 完了`, tone: ok > 0 ? 'ok' : 'more' },
            ...(ng > 0 ? [{ text: '  ', tone: 'edge' as const }, { text: `✗ ${ng} 失敗`, tone: 'error' as const }] : []),
          ],
    gutter: [],
  }
}

const agentCard = (item: Item, mainModel: string, now: number): Omit<Card, 'gutter'> => {
  const { agent } = item
  const done = item.status !== 'running'
  const model = agent.model !== '' && shortModel(agent.model) !== shortModel(mainModel) ? shortModel(agent.model) : ''
  const time = done
    ? agent.durationMs === undefined
      ? undefined
      : seconds(agent.durationMs)
    : item.startedAt === undefined
      ? undefined
      : seconds(Math.max(0, now - item.startedAt))
  // 起動したては説明を1文字ずつ打ち出す
  const typing = !done && item.startedAt !== undefined && now - item.startedAt < TYPE_MS
  const chars = [...agent.name]
  const shown = typing
    ? chars.slice(0, Math.ceil((chars.length * Math.max(0, now - (item.startedAt ?? now))) / TYPE_MS)).join('')
    : agent.name
  const justDone = item.endedAt !== undefined && now - item.endedAt < FLASH_MS
  const kind = kindOf(agent.type)
  return {
    key: item.id,
    depth: item.depth,
    tone: item.status === 'error' ? 'error' : justDone ? 'flash' : done ? 'done' : 'live',
    sprite: {
      kind,
      raster: spriteRaster(kind, {
        blink: !done && blinking(now, agent.no),
        fade: done ? 0.55 : undefined,
        tint: item.status === 'error' ? 0xd04848 : undefined,
      }),
    },
    title: [
      { text: `#${agent.no} `, tone: 'no' },
      { text: shortType(agent.type), tone: 'type', hue: hueOf(agent.type) },
      ...(model === '' ? [] : [{ text: ` · ${model}`, tone: 'note' as const }]),
    ],
    time: time === undefined ? undefined : { text: time, tone: done ? 'note' : 'timeLive' },
    name: [
      { text: shown, tone: done ? 'labelDone' : 'label' },
      ...(typing ? [{ text: '▍', tone: 'cursor' as const }] : []),
    ],
    activity:
      item.status === 'running'
        ? [
            { text: `${spinner(now)} `, tone: 'spin' },
            { text: item.tool ?? '考えています', tone: 'tool' },
          ]
        : item.status === 'ok'
          ? [{ text: '✓ 回答した', tone: 'ok' }]
          : [{ text: '✗ 中断・エラーで終えた', tone: 'error' }],
  }
}

/**
 * カードの左の線を引く。各段の列は、その段の兄弟がまだ下に続くなら │ を通す。
 * 自分の段は、カードの真ん中の行(枠の中の2行目)で ├─ / ╰─ と曲げて枠につなぐ
 */
const withGutters = (
  items: readonly Item[],
  agents: Record<string, WorkLogAgent>,
  mainModel: string,
  now: number,
): Card[] => {
  const parentOf = (item: Item) => (item.depth === 0 ? 'main' : (agentOf(agents, item.id)?.parentId ?? 'main'))
  /** 同じ親を持つ、後ろの兄弟がいるか */
  const hasLater = (index: number): boolean => {
    const item = items[index]
    if (item === undefined) return false
    for (let j = index + 1; j < items.length; j += 1) {
      const other = items[j]
      if (other === undefined || other.depth < item.depth) return false
      if (other.depth === item.depth && parentOf(other) === parentOf(item)) return true
    }
    return false
  }
  // 段 d の列で、i 番目のカードの行に │ を通すか(その段の祖先に後ろの兄弟がいるか)
  const ancestorAt = (index: number, depth: number): number => {
    for (let j = index; j >= 0; j -= 1) if ((items[j]?.depth ?? -1) === depth) return j
    return -1
  }

  const mid = 2
  return items.map((item, i) => {
    const card = agentCard(item, mainModel, now)
    const gutter: MapSeg[][] = []
    for (let line = 0; line < CARD_ROWS; line += 1) {
      const segs: MapSeg[] = []
      for (let d = 0; d < item.depth; d += 1) {
        const pass = hasLater(ancestorAt(i, d))
        segs.push({ text: pass ? ' │ ' : '   ', tone: 'edge' })
      }
      const later = hasLater(i)
      const own = line < mid ? ' │ ' : line === mid ? (later ? ' ├─' : ' ╰─') : later ? ' │ ' : '   '
      segs.push({ text: own, tone: 'edge' })
      gutter.push(segs)
    }
    paintFlow(gutter, item, now)
    return { ...card, gutter }
  })
}

/** 自分の段の線(上から真ん中まで、そこから右へ)に、光と粒を置く */
const paintFlow = (gutter: MapSeg[][], item: Item, now: number) => {
  // 道筋: 各行の自分の段の │ の位置(1文字目)を上から真ん中まで、最後に ─ の位置
  const steps: Array<[line: number, char: number]> = [
    [0, 1],
    [1, 1],
    [2, 1],
    [2, 2],
  ]
  const paint = ([line, char]: [number, number], glyph: string | undefined, tone: MapSeg['tone']) => {
    const segs = gutter[line]
    const own = segs?.at(-1)
    if (segs === undefined || own === undefined) return
    const chars = [...own.text]
    const before = chars.slice(0, char).join('')
    const at = glyph ?? chars[char] ?? ' '
    const after = chars.slice(char + 1).join('')
    segs.splice(
      segs.length - 1,
      1,
      ...[
        { text: before, tone: own.tone },
        { text: at, tone },
        { text: after, tone: own.tone },
      ].filter(seg => seg.text !== ''),
    )
  }
  if (inFlight(item.endedAt, now) && item.endedAt !== undefined) {
    const k = Math.min(steps.length - 1, Math.floor(((now - item.endedAt) / FLIGHT_MS) * steps.length))
    const step = [...steps].reverse()[k]
    if (step !== undefined) paint(step, '◆', 'back')
  } else if (inFlight(item.startedAt, now) && item.startedAt !== undefined) {
    const k = Math.min(steps.length - 1, Math.floor(((now - item.startedAt) / FLIGHT_MS) * steps.length))
    const step = steps[k]
    if (step !== undefined) paint(step, '●', 'flow')
  } else if (item.status === 'running') {
    const step = steps[Math.floor(now / TICK_MS) % steps.length]
    if (step !== undefined) paint(step, undefined, 'live')
  }
}
