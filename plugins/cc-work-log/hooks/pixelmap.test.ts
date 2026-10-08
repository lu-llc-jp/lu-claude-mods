import { expect, test } from 'claude-code/testing'

import type { WorkLogAgent, WorkLogEntry } from '../types'
import { FLASH_MS, FLIGHT_MS, TICK_MS } from './map'
import { layoutPixelMap, type PixelMap } from './pixelmap'
import { CLEAR, blankPixels, setPixel, toRaster } from './raster'
import { OK_GREEN } from './sprites'

const T0 = 1_000_000
/** 起動から十分たち、粒も打ち出しも終わっている時刻 */
const LATER = T0 + 60 * TICK_MS
const LINE = 0x5b616b
const REQUEST = 0xffe9a8
const DEFAULT = 0x01000000

const entry = (id: string, text: string, at: number, more: Partial<WorkLogEntry> = {}): WorkLogEntry => ({
  id,
  kind: 'tool',
  text,
  at,
  status: 'ok',
  ...more,
})

const agent = (no: number, more: Partial<WorkLogAgent> = {}): WorkLogAgent => ({
  no,
  name: `調べる${no}`,
  type: 'Explore',
  model: 'claude-haiku-5-5',
  spawnEntryId: `call-${no}`,
  status: 'running',
  startedAt: T0,
  ...more,
})

const twoAgents = (): WorkLogEntry[] => [
  entry('call-1', '起動', T0, { status: 'running' }),
  entry('call-2', '起動', T0, { status: 'running' }),
  entry('a1', '「TODO」を検索', T0 + 100, { agentId: 'agent-1', status: 'running' }),
]
const running = { 'agent-1': agent(1), 'agent-2': agent(2) }

// ---- Raster の cells をドットに戻す ----

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const words = (cells: string): number[] => {
  const bytes: number[] = []
  for (let i = 0; i < cells.length; i += 4) {
    const n = [0, 1, 2, 3].map(k => (cells[i + k] === '=' ? 0 : B64.indexOf(cells[i + k] ?? 'A')))
    const v = ((n[0] ?? 0) << 18) | ((n[1] ?? 0) << 12) | ((n[2] ?? 0) << 6) | (n[3] ?? 0)
    bytes.push((v >> 16) & 255)
    if (cells[i + 2] !== '=') bytes.push((v >> 8) & 255)
    if (cells[i + 3] !== '=') bytes.push(v & 255)
  }
  const out: number[] = []
  for (let i = 0; i < bytes.length; i += 4) {
    out.push(((bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8) | ((bytes[i + 2] ?? 0) << 16) | ((bytes[i + 3] ?? 0) << 24)) >>> 0)
  }
  return out
}

/** マスの [文字, 前景色, 背景色] から、ドット (x, y) の色を求める。透明は CLEAR */
const pixelAt = (map: PixelMap, x: number, y: number): number => {
  const { columns, cells } = map.raster
  const w = words(cells)
  const at = (Math.floor(y / 2) * columns + x) * 3
  const [glyph, fg, bg] = [w[at], w[at + 1], w[at + 2]]
  const color = glyph === 0x2580 ? (y % 2 === 0 ? fg : bg) : glyph === 0x2584 ? (y % 2 === 0 ? bg : fg) : DEFAULT
  return color === DEFAULT || color === undefined ? CLEAR : color
}
const text = (map: PixelMap, row: number): string => map.lines[row]?.segs.map(seg => seg.text).join('') ?? ''
/** 行 row(マスの行)の中で、色の付いたドットがある x */
const inkedXs = (map: PixelMap, row: number): number[] => {
  const xs: number[] = []
  for (let x = 0; x < map.raster.columns; x += 1) {
    if (pixelAt(map, x, row * 2) !== CLEAR || pixelAt(map, x, row * 2 + 1) !== CLEAR) xs.push(x)
  }
  return xs
}

test('縦2ドットを1マスにし、色のある側をブロックにする', () => {
  const pixels = blankPixels(3, 2)
  setPixel(pixels, 0, 0, 0xff0000)
  setPixel(pixels, 1, 1, 0x00ff00)
  setPixel(pixels, 2, 0, 0x0000ff)
  setPixel(pixels, 2, 1, 0xffffff)
  const raster = toRaster(pixels)
  expect([raster.columns, raster.rows]).toEqual([3, 1])
  expect(words(raster.cells)).toEqual([0x2580, 0xff0000, DEFAULT, 0x2584, 0x00ff00, DEFAULT, 0x2580, 0x0000ff, 0xffffff])
})

test('キャラを名前の行と同じ行に置き、メインの下から線でつなぐ', () => {
  const map = layoutPixelMap(twoAgents(), running, 'claude-opus-5-5', LATER, 30, 60)

  expect(map.raster.rows).toBe(map.lines.length)
  expect(words(map.raster.cells).length).toBe(map.raster.columns * map.raster.rows * 3)
  expect(text(map, 0)).toBe('メイン  opus-5-5')
  expect(text(map, 4)).toMatch(/^#1 Explore·haiku-5-5 {2}調べる1 +9秒$/)
  expect(text(map, 5)).toBe('「TODO」を検索')
  expect(text(map, 7)).toMatch(/^#2 Explore/)
  // メインのキャラは 0〜3 行、#1 は 4〜6 行、#2 は 7〜9 行の、左から 6 ドット目から
  expect(inkedXs(map, 0)).toContain(3)
  expect(Math.min(...inkedXs(map, 4).filter(x => x >= 4))).toBe(6)
  expect(Math.min(...inkedXs(map, 7).filter(x => x >= 4))).toBe(6)
  // 幹はメインの下(y=8)から #2 の真ん中の高さまで続く
  for (let y = 8; y <= 17; y += 1) expect(pixelAt(map, 3, y)).not.toBe(CLEAR)
})

test('サブエージェントが起動したものは、親の下から線を下ろして右へずらす', () => {
  const agents = { 'agent-1': agent(1), 'agent-3': agent(3, { parentId: 'agent-1', type: 'Plan' }) }
  const map = layoutPixelMap(twoAgents(), agents, '', LATER, 30, 60)

  expect(text(map, 7)).toMatch(/^#3 Plan/)
  expect(Math.min(...inkedXs(map, 7))).toBe(8)
  // 親(#1, y=8〜13)の下 y=14 から、子の真ん中の高さ y=17 まで x=8 に線が通り、x=9〜10 で子へ曲がる
  for (let y = 14; y <= 17; y += 1) expect(pixelAt(map, 8, y)).not.toBe(CLEAR)
  expect(pixelAt(map, 9, 17)).toBe(LINE)
  expect(pixelAt(map, 12, 15)).not.toBe(CLEAR)
})

test('起動したては依頼の粒が線を下り、終えたら結果の粒が戻る', () => {
  const at = (now: number, agents: Record<string, WorkLogAgent>) => layoutPixelMap(twoAgents(), agents, '', now, 30, 60)
  const requestY = (map: PixelMap) => [...Array(20).keys()].find(y => pixelAt(map, 3, y) === REQUEST)

  const early = requestY(at(T0 + 100, running))
  const later = requestY(at(T0 + FLIGHT_MS / 3, running))
  expect(early).toBeDefined()
  expect(later).toBeDefined()
  expect(later ?? 0).toBeGreaterThan(early ?? 0)

  const end = T0 + 12_000
  const done = { ...running, 'agent-1': agent(1, { status: 'ok', durationMs: 12_000, endedAt: end }) }
  const greenY = (map: PixelMap) => [...Array(20).keys()].filter(y => pixelAt(map, 3, y) === OK_GREEN)
  const back1 = greenY(at(end + FLIGHT_MS / 2, done))
  const back2 = greenY(at(end + FLIGHT_MS - 1, done))
  expect(back1.length).toBeGreaterThan(0)
  expect(Math.min(...back2)).toBeLessThan(Math.min(...back1))
})

test('終えたキャラは色を落とし、印と「回答した」を添え、結果が届くとメインのランプが緑になる', () => {
  const end = T0 + 12_000
  const done = { ...running, 'agent-1': agent(1, { status: 'ok', durationMs: 12_000, endedAt: end }) }
  const list = twoAgents().map(one => (one.id === 'a1' ? { ...one, status: 'ok' as const } : one))
  const lit = layoutPixelMap(list, running, '', LATER, 30, 60)
  const map = layoutPixelMap(list, done, '', end + FLIGHT_MS, 30, 60)

  expect(pixelAt(map, 7, 9)).not.toBe(pixelAt(lit, 7, 9))
  expect(text(map, 4)).toMatch(/12秒$/)
  expect(text(map, 5)).toBe('✓ 回答した')
  // 印は キャラの右(x=13〜16)
  expect([13, 14, 15, 16].some(x => [11, 12, 13].some(y => pixelAt(map, x, y) === OK_GREEN))).toBe(true)
  // メインのランプ(x=3〜4, y=0)
  expect(pixelAt(map, 3, 0)).toBe(OK_GREEN)
  expect(pixelAt(layoutPixelMap(list, done, '', end + FLIGHT_MS + FLASH_MS, 30, 60), 3, 0)).not.toBe(OK_GREEN)
})

test('入りきらなければ、終えたもの(古い順)、新しいもの、の順に省く', () => {
  const agents: Record<string, WorkLogAgent> = {}
  const list: WorkLogEntry[] = []
  for (let no = 1; no <= 5; no += 1) {
    agents[`agent-${no}`] = agent(no, no <= 2 ? { status: 'ok', durationMs: 1000, endedAt: T0 + 100 } : {})
    list.push(entry(`call-${no}`, '起動', T0))
  }
  // メイン4行 + 3体 × 3行 + 省いた目印 = 14 行
  const map = layoutPixelMap(list, agents, '', LATER, 14, 60)
  expect(map.lines.length).toBe(14)
  expect(map.raster.rows).toBe(14)
  expect(map.lines.map(line => /^#(\d)/.exec(line.segs.map(seg => seg.text).join(''))?.[1]).filter(Boolean)).toEqual(['3', '4', '5'])
  expect(text(map, 13)).toBe('ほか 2 体を省いた')

  const narrow = layoutPixelMap(list, agents, '', LATER, 11, 60)
  expect(narrow.lines.map(line => /^#(\d)/.exec(line.segs.map(seg => seg.text).join(''))?.[1]).filter(Boolean)).toEqual(['3', '4'])
})
