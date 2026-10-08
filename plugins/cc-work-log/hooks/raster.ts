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


/** 4分割ブロック。左上 1・右上 2・左下 4・右下 8 の和で引く */
const QUADRANTS = [0x20, 0x2598, 0x259d, 0x2580, 0x2596, 0x258c, 0x259e, 0x259b, 0x2597, 0x259a, 0x2590, 0x259c, 0x2584, 0x2599, 0x259f, 0x2588]

/**
 * ドットの絵を、2×2 ドットを1マスにして Raster の cells にする。1マスに使える色は1つなので、
 * 1色の絵(ロゴのような形)向け。マスの中に色が混ざるときは、左上から見て最初の色にする
 */
export const toQuadRaster = (pixels: Pixels): RasterCells => {
  const columns = Math.ceil(pixels.width / 2)
  const rows = Math.ceil(pixels.height / 2)
  const bytes = new Uint8Array(columns * rows * 12)
  const view = new DataView(bytes.buffer)
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const corners = [
        getPixel(pixels, col * 2, row * 2),
        getPixel(pixels, col * 2 + 1, row * 2),
        getPixel(pixels, col * 2, row * 2 + 1),
        getPixel(pixels, col * 2 + 1, row * 2 + 1),
      ]
      const bits = corners.reduce((sum, color, i) => (color === CLEAR ? sum : sum | (1 << i)), 0)
      const color = corners.find(one => one !== CLEAR) ?? DEFAULT_COLOR
      const at = (row * columns + col) * 12
      view.setUint32(at, QUADRANTS[bits] ?? 0x20, true)
      view.setUint32(at + 4, bits === 0 ? DEFAULT_COLOR : color, true)
      view.setUint32(at + 8, DEFAULT_COLOR, true)
    }
  }
  return { columns, rows, cells: base64Of(bytes) }
}
