import type { MainMood } from './map'
import { blankPixels, setPixel, toQuadRaster, type RasterCells } from './raster'

/**
 * メインのエージェントのキャラ。Claude Code の起動画面に出るキャラを、2×2 ドットのブロック文字で描く。
 * 絵は 18×5 ドット(9列×3行)。上に1行ぶんの余白を取り、跳ねられるようにする(Raster は 9列×4行)
 */
export const CLAWD_COLUMNS = 9
export const CLAWD_ROWS = 4

/** 体の色(Claude のオレンジ)と、ターンを失敗で終えたときの色 */
const BODY = 0xd97757
const SAD = 0x9a5a48

/** 体。'#' が塗るドット。目は2行目の抜き(x=5, x=12) */
const BODY_ART = [
  '...############...',
  '...##.######.##...',
  '.################.',
  '...############...',
]
/** 足(4本)。歩くときは2本ずつ上げ下げする */
const LEGS = [4, 6, 11, 13]

/** まばたきの周期と、目を閉じている時間(ms)。何も動いていないときも、描く側はこの周期で描き直してまばたきさせる */
export const BLINK_EVERY = 2600
export const BLINK_FOR = 160

const blinking = (now: number): boolean => now % BLINK_EVERY < BLINK_FOR

/** メインの様子と時刻から、キャラの1コマを作る */
export const clawdFrame = (mood: MainMood, now: number): RasterCells => {
  const pixels = blankPixels(CLAWD_COLUMNS * 2, CLAWD_ROWS * 2)
  const color = mood === 'error' ? SAD : BODY
  // 結果が届いたら跳ねて両腕を上げる。ふだんは2ドット下げて置く
  const jump = mood === 'flash' && Math.floor(now / 150) % 2 === 0
  const top = jump ? 1 : 2
  const armsUp = mood === 'flash'

  BODY_ART.forEach((row, dy) => {
    ;[...row].forEach((ch, x) => {
      if (ch !== '#') return
      // 腕(3行目の両端)は、上げているときは1行上に移す
      const arm = dy === 2 && (x <= 2 || x >= 15)
      setPixel(pixels, x, top + dy - (arm && armsUp ? 1 : 0), color)
    })
  })
  // まばたき: 目の抜きを埋める
  if (blinking(now) && mood !== 'flash') {
    setPixel(pixels, 5, top + 1, color)
    setPixel(pixels, 12, top + 1, color)
  }
  // 足: ツールを使っているあいだは、外側の2本と内側の2本を交互に上げて歩く
  const step = Math.floor(now / 300) % 2
  LEGS.forEach((x, i) => {
    const lifted = mood === 'busy' && (i === 0 || i === 3 ? step === 0 : step === 1)
    if (!lifted) setPixel(pixels, x, top + 4, color)
  })
  return toQuadRaster(pixels)
}
