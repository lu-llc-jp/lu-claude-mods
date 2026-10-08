import type { MainMood } from './map'
import { blankPixels, mix, setPixel, toRaster, type RasterCells } from './raster'

/**
 * メインのエージェントのキャラ。ブロック頭の現場監督(このリポジトリのオリジナル)。
 * 絵は 9×8 ドットで、縦2ドットを1マスに詰めるので 9列×4行の Raster になる
 */
export const AVATAR_COLUMNS = 9
export const AVATAR_ROWS = 4

/** まばたきの周期と、目を閉じている時間(ms)。何も動いていないときも、描く側はこの周期で描き直してまばたきさせる */
export const BLINK_EVERY = 2600
export const BLINK_FOR = 160

/** 1文字が1ドットの色。'.' は透明 */
const PALETTE: Record<string, number> = {
  Y: 0xf2c230, // ヘルメット
  S: 0xe8b48a, // 肌
  E: 0x2b2b2b, // 目
  B: 0x4f8a3c, // 服
  G: 0x6b4a2f, // ズボン
  W: 0x9a6a3a, // ツルハシの柄
  M: 0xa3a9b0, // ツルハシの刃
}

/** ふだん: ツルハシを肩にかついでいる */
const IDLE = [
  '.YYYYY...',
  'YYYYYYYMM',
  '.SSSSS.WM',
  '.SESES.W.',
  '.SSSSS.W.',
  '.BBBBBSW.',
  '.BBBBB...',
  '.GG.GG...',
]
/** ツールを使っているあいだ、IDLE と交互に出す: ツルハシを振り下ろす */
const SWING = [
  '.YYYYY...',
  'YYYYYYY..',
  '.SSSSS...',
  '.SESES...',
  '.SSSSS..M',
  '.BBBBBSWM',
  '.BBBBB..M',
  '.GG.GG...',
]
/** 結果が届いたとき: ツルハシを高く掲げる */
const CHEER = [
  '.YYYYY.MM',
  'YYYYYYYWM',
  '.SSSSS.W.',
  '.SESES.W.',
  '.SSSSS.S.',
  '.BBBBBB..',
  '.BBBBB...',
  '.GG.GG...',
]

/** 失敗で終えたときに寄せる色 */
const GLOOM = 0x555b66

const blinking = (now: number): boolean => now % BLINK_EVERY < BLINK_FOR

/** メインの様子と時刻から、キャラの1コマを作る */
export const avatarFrame = (mood: MainMood, now: number): RasterCells => {
  const art = mood === 'flash' ? CHEER : mood === 'busy' && Math.floor(now / 300) % 2 === 1 ? SWING : IDLE
  const closed = mood !== 'flash' && blinking(now)
  const pixels = blankPixels(AVATAR_COLUMNS, AVATAR_ROWS * 2)
  art.forEach((row, y) => {
    ;[...row].forEach((ch, x) => {
      const key = ch === 'E' && closed ? 'S' : ch
      const color = PALETTE[key]
      if (color === undefined) return
      setPixel(pixels, x, y, mood === 'error' ? mix(color, GLOOM, 0.5) : color)
    })
  })
  return toRaster(pixels)
}
