import { expect, test } from 'claude-code/testing'

import { AVATAR_COLUMNS, AVATAR_ROWS, BLINK_EVERY, avatarFrame } from './avatar'

const DEFAULT = 0x01000000

/** base64 の cells を、マスごとの [文字, 前景色, 背景色] に戻す */
const cellsOf = (cells: string): number[][] => {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  for (let i = 0; i < cells.length; i += 4) {
    const n = [0, 1, 2, 3].map(k => (cells[i + k] === '=' ? 0 : B64.indexOf(cells[i + k] ?? 'A')))
    const v = ((n[0] ?? 0) << 18) | ((n[1] ?? 0) << 12) | ((n[2] ?? 0) << 6) | (n[3] ?? 0)
    bytes.push((v >> 16) & 255)
    if (cells[i + 2] !== '=') bytes.push((v >> 8) & 255)
    if (cells[i + 3] !== '=') bytes.push(v & 255)
  }
  const word = (i: number) =>
    ((bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8) | ((bytes[i + 2] ?? 0) << 16) | ((bytes[i + 3] ?? 0) << 24)) >>> 0
  const out: number[][] = []
  for (let i = 0; i < bytes.length; i += 12) out.push([word(i), word(i + 4), word(i + 8)])
  return out
}

/** ドット (x, y) の色。透明は undefined */
const pixel = (mood: Parameters<typeof avatarFrame>[0], now: number, x: number, y: number): number | undefined => {
  const frame = avatarFrame(mood, now)
  const [glyph, fg, bg] = cellsOf(frame.cells)[Math.floor(y / 2) * frame.columns + x] ?? []
  const color = glyph === 0x2580 ? (y % 2 === 0 ? fg : bg) : glyph === 0x2584 ? (y % 2 === 0 ? bg : fg) : DEFAULT
  return color === DEFAULT ? undefined : color
}

const HELMET = 0xf2c230
const EYE = 0x2b2b2b
const SKIN = 0xe8b48a
const BLADE = 0xa3a9b0

test('9列×4行の Raster に、ヘルメットをかぶったブロック頭の現場監督を描く', () => {
  const frame = avatarFrame('thinking', 1000)
  expect([frame.columns, frame.rows]).toEqual([AVATAR_COLUMNS, AVATAR_ROWS])
  expect(pixel('thinking', 1000, 0, 1)).toBe(HELMET)
  expect([pixel('thinking', 1000, 2, 3), pixel('thinking', 1000, 4, 3)]).toEqual([EYE, EYE])
  // 透明なところは端末の既定色のまま
  expect(pixel('thinking', 1000, 0, 0)).toBeUndefined()
})

test('ときどきまばたきする', () => {
  expect(pixel('thinking', 0, 2, 3)).toBe(SKIN)
  expect(pixel('thinking', BLINK_EVERY / 2, 2, 3)).toBe(EYE)
})

test('ツールを使っているあいだは、ツルハシを振る', () => {
  // ツルハシの刃は、かついでいるときは上(y=1)、振り下ろすと下(y=6)
  // 0.3 秒ごとに、かつぐ(1200)と振り下ろす(1500)を繰り返す
  expect([pixel('busy', 1200, 8, 1), pixel('busy', 1200, 8, 6)]).toEqual([BLADE, undefined])
  expect([pixel('busy', 1500, 8, 1), pixel('busy', 1500, 8, 6)]).toEqual([undefined, BLADE])
})

test('結果が届くと、ツルハシを高く掲げる', () => {
  expect(pixel('flash', 1000, 8, 0)).toBe(BLADE)
  // 掲げているあいだは目を閉じない
  expect(pixel('flash', 0, 2, 3)).toBe(EYE)
})

test('失敗で終えたときは、色を沈める', () => {
  expect(pixel('error', 1000, 0, 1)).not.toBe(HELMET)
})
