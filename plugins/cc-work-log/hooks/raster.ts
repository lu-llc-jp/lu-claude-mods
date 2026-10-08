/** 透明のドット。Raster では端末の既定色になる */
export const CLEAR = -1
/** RasterProps の「端末の既定色」 */
const DEFAULT_COLOR = 0x01000000

/** ドットの絵。data は左上から行ごとに並べた色(0x00RRGGBB、透明は CLEAR) */
export type Pixels = { width: number; height: number; data: number[] }

/** Raster に渡すもの */
export type RasterCells = { columns: number; rows: number; cells: string }

export const blankPixels = (width: number, height: number): Pixels => ({
  width,
  height,
  data: new Array<number>(width * height).fill(CLEAR),
})

const getPixel = (pixels: Pixels, x: number, y: number): number =>
  x < 0 || y < 0 || x >= pixels.width || y >= pixels.height ? CLEAR : (pixels.data[y * pixels.width + x] ?? CLEAR)

export const setPixel = (pixels: Pixels, x: number, y: number, color: number): void => {
  if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) return
  pixels.data[y * pixels.width + x] = color
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** パディング付きの標準 base64。エンジンの中には btoa も toBase64 も無いことがあるので自前で書く */
const base64Of = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    out += B64[a >> 2] ?? ''
    out += B64[((a & 3) << 4) | (b >> 4)] ?? ''
    out += i + 1 < bytes.length ? (B64[((b & 15) << 2) | (c >> 6)] ?? '') : '='
    out += i + 2 < bytes.length ? (B64[c & 63] ?? '') : '='
  }
  return out
}


/** 上半分・下半分のブロック。ブロックの部分が前景色、残りが背景色になる */
const UPPER_HALF = 0x2580
const LOWER_HALF = 0x2584

/** a から b へ t(0〜1)だけ寄せた色 */
export const mix = (a: number, b: number, t: number): number => {
  const k = Math.max(0, Math.min(1, t))
  const ch = (c: number, shift: number) => (c >> shift) & 0xff
  const one = (shift: number) => Math.round(ch(a, shift) + (ch(b, shift) - ch(a, shift)) * k)
  return ((one(16) << 16) | (one(8) << 8) | one(0)) >>> 0
}

/** ドットの絵を Raster の cells にする。縦2ドットを ▀ か ▄ の1マスにし(上下で別の色を使える)、上下とも透明なら空白にする */
export const toRaster = (pixels: Pixels): RasterCells => {
  const columns = pixels.width
  const rows = Math.ceil(pixels.height / 2)
  const bytes = new Uint8Array(columns * rows * 12)
  const view = new DataView(bytes.buffer)
  for (let row = 0; row < rows; row += 1) {
    for (let x = 0; x < columns; x += 1) {
      const top = getPixel(pixels, x, row * 2)
      const bottom = getPixel(pixels, x, row * 2 + 1)
      const at = (row * columns + x) * 12
      // 前景色の既定は端末の文字色なので、透明な側をブロックにしてはいけない。色のある側をブロックにする
      const [glyph, fg, bg] =
        top === CLEAR && bottom === CLEAR
          ? [0x20, DEFAULT_COLOR, DEFAULT_COLOR]
          : top === CLEAR
            ? [LOWER_HALF, bottom, DEFAULT_COLOR]
            : [UPPER_HALF, top, bottom === CLEAR ? DEFAULT_COLOR : bottom]
      view.setUint32(at, glyph, true)
      view.setUint32(at + 4, fg, true)
      view.setUint32(at + 8, bg, true)
    }
  }
  return { columns, rows, cells: base64Of(bytes) }
}
