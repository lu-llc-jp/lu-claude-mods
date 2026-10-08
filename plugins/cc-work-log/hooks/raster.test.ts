import { expect, test } from 'claude-code/testing'

import { blankPixels, setPixel, toQuadRaster } from './raster'

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

test('4分割ブロックでは、2×2 ドットを1マスにする', () => {
  const pixels = blankPixels(4, 2)
  setPixel(pixels, 0, 0, 0xd97757)
  setPixel(pixels, 1, 0, 0xd97757)
  setPixel(pixels, 0, 1, 0xd97757)
  setPixel(pixels, 3, 1, 0xd97757)
  const raster = toQuadRaster(pixels)

  expect([raster.columns, raster.rows]).toEqual([2, 1])
  expect(words(raster.cells)).toEqual([0x259b, 0xd97757, DEFAULT, 0x2597, 0xd97757, DEFAULT])
})
