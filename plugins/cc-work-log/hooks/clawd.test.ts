import { expect, test } from 'claude-code/testing'

import { CLAWD_COLUMNS, CLAWD_ROWS, clawdFrame } from './clawd'

/** base64 の cells を、マスの文字の行に戻す(色は見ない) */
const glyphs = (cells: string, columns: number): string[] => {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  for (let i = 0; i < cells.length; i += 4) {
    const n = [0, 1, 2, 3].map(k => (cells[i + k] === '=' ? 0 : B64.indexOf(cells[i + k] ?? 'A')))
    const v = ((n[0] ?? 0) << 18) | ((n[1] ?? 0) << 12) | ((n[2] ?? 0) << 6) | (n[3] ?? 0)
    bytes.push((v >> 16) & 255)
    if (cells[i + 2] !== '=') bytes.push((v >> 8) & 255)
    if (cells[i + 3] !== '=') bytes.push(v & 255)
  }
  const chars: string[] = []
  for (let i = 0; i < bytes.length; i += 12) {
    chars.push(String.fromCodePoint((bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8)))
  }
  const lines: string[] = []
  for (let i = 0; i < chars.length; i += columns) lines.push(chars.slice(i, i + columns).join(''))
  return lines
}
const draw = (mood: Parameters<typeof clawdFrame>[0], now: number) => {
  const frame = clawdFrame(mood, now)
  expect([frame.columns, frame.rows]).toEqual([CLAWD_COLUMNS, CLAWD_ROWS])
  return glyphs(frame.cells, frame.columns)
}

test('ふだんは、上に余白を1行取って Claude のキャラを描く', () => {
  expect(draw('thinking', 1000)).toEqual([
    '         ',
    ' ▐▛███▜▌ ',
    '▝▜█████▛▘',
    '  ▘▘ ▝▝  ',
  ])
})

test('ときどきまばたきする', () => {
  expect(draw('thinking', 0)[1]).toBe(' ▐█████▌ ')
})

test('ツールを使っているあいだは、足を交互に上げて歩く', () => {
  const legs = [1000, 1300].map(now => draw('busy', now)[3])
  expect(legs).toEqual(['  ▘   ▝  ', '   ▘ ▝   '])
})

test('結果が届くと、両腕を上げて跳ねる', () => {
  // 跳ねたコマ(1ドット上)と、着地したコマ。どちらも腕は上げたまま
  expect(draw('flash', 1200)).toEqual([' ▗▄▄▄▄▄▖ ', '▝▜▙███▟▛▘', ' ▝▛▛▀▜▜▘ ', '         '])
  expect(draw('flash', 1050)).toEqual(['         ', '▗▟▛███▜▙▖', ' ▐█████▌ ', '  ▘▘ ▝▝  '])
})
