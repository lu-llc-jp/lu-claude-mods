import { expect, test } from 'claude-code/testing'

import { blankPixels, mix, setPixel, toRaster } from './raster'

const DEFAULT = 0x01000000

/** base64 の cells を u32 の並びに戻す */
const words = (cells: string): number[] => {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
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

test('縦2ドットを1マスにし、色のある側をブロックにする(透明な側は端末の既定色)', () => {
  const pixels = blankPixels(4, 2)
  setPixel(pixels, 0, 0, 0xff0000)
  setPixel(pixels, 1, 1, 0x00ff00)
  setPixel(pixels, 2, 0, 0x0000ff)
  setPixel(pixels, 2, 1, 0xffffff)
  const raster = toRaster(pixels)

  expect([raster.columns, raster.rows]).toEqual([4, 1])
  expect(words(raster.cells)).toEqual([
    0x2580, 0xff0000, DEFAULT,
    0x2584, 0x00ff00, DEFAULT,
    0x2580, 0x0000ff, 0xffffff,
    0x20, DEFAULT, DEFAULT,
  ])
})

test('色を寄せる', () => {
  expect(mix(0x000000, 0xffffff, 0.5)).toBe(0x808080)
  expect(mix(0x102030, 0x102030, 0.7)).toBe(0x102030)
})
