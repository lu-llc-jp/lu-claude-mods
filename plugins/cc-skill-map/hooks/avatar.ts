import { blankPixels, setPixel, toRaster, type RasterCells } from './raster'

/**
 * カードに描くキャラ。絵は 9×8 ドットで、縦2ドットを1マスに詰めるので 9列×4行の Raster になる。
 * メインは cc-work-log と同じ現場監督、人は承認印を持つ人(どちらもこのリポジトリのオリジナル)
 */
export const AVATAR_COLUMNS = 9
export const AVATAR_ROWS = 4

/** まばたきの周期と、目を閉じている時間(ms) */
const BLINK_EVERY = 2600
const BLINK_FOR = 160

/** 1文字が1ドットの色。'.' は透明 */
const PALETTE: Record<string, number> = {
  Y: 0xf2c230, // ヘルメット
  S: 0xe8b48a, // 肌
  E: 0x2b2b2b, // 目
  B: 0x4f8a3c, // 作業着
  G: 0x6b4a2f, // ズボン
  W: 0x9a6a3a, // ツルハシの柄
  M: 0xa3a9b0, // ツルハシの刃
  K: 0x3a2e28, // 髪
  C: 0xe6e9ee, // シャツ
  T: 0x2f6fd0, // ネクタイ
  N: 0x3b4252, // スラックス
  R: 0xd23c3c, // 承認印
}

/** メイン: ふだん。ツルハシを肩にかついでいる */
const MAIN_IDLE = ['.YYYYY...', 'YYYYYYYMM', '.SSSSS.WM', '.SESES.W.', '.SSSSS.W.', '.BBBBBSW.', '.BBBBB...', '.GG.GG...']
/** メイン: 手順を進めているあいだ、IDLE と交互に出す。ツルハシを振り下ろす */
const MAIN_SWING = ['.YYYYY...', 'YYYYYYY..', '.SSSSS...', '.SESES...', '.SSSSS..M', '.BBBBBSWM', '.BBBBB..M', '.GG.GG...']
/** メイン: 結果が届いたとき。ツルハシを高く掲げる */
const MAIN_CHEER = ['.YYYYY.MM', 'YYYYYYYWM', '.SSSSS.W.', '.SESES.W.', '.SSSSS.S.', '.BBBBBB..', '.BBBBB...', '.GG.GG...']

/** 人: ふだん */
const HUMAN_IDLE = ['..KKKKK..', '.KKKKKKK.', '.SSSSSSS.', '.SESSSES.', '..SSSSS..', '.CCCTCCC.', 'SCCCTCCCS', '..NN.NN..']
/** 人: 出番のあいだ、IDLE と交互に出す。承認印を掲げる */
const HUMAN_STAMP = ['..KKKKK.R', '.KKKKKKKR', '.SSSSSSSS', '.SESSSESS', '..SSSSSC.', '.CCCTCC..', 'SCCCTCC..', '..NN.NN..']

/** busy: 手を動かしている、cheer: 結果が届いた、idle: ふだん */
export type AvatarMood = 'idle' | 'busy' | 'cheer'

const draw = (art: readonly string[], closed: boolean): RasterCells => {
  const pixels = blankPixels(AVATAR_COLUMNS, AVATAR_ROWS * 2)
  art.forEach((row, y) => {
    ;[...row].forEach((ch, x) => {
      const color = PALETTE[ch === 'E' && closed ? 'S' : ch]
      if (color !== undefined) setPixel(pixels, x, y, color)
    })
  })
  return toRaster(pixels)
}

/** 動きの1コマ。busy のあいだは 300ms ごとに絵を切り替え、ときどきまばたきする */
const pick = (mood: AvatarMood, now: number, idle: readonly string[], busy: readonly string[], cheer: readonly string[]) => {
  const art = mood === 'cheer' ? cheer : mood === 'busy' && Math.floor(now / 300) % 2 === 1 ? busy : idle
  return draw(art, mood !== 'cheer' && now % BLINK_EVERY < BLINK_FOR)
}

export const mainAvatar = (mood: AvatarMood, now: number): RasterCells => pick(mood, now, MAIN_IDLE, MAIN_SWING, MAIN_CHEER)

/** 人は、出番のあいだ承認印を掲げ下ろしする。結果を返した瞬間は掲げたまま */
export const humanAvatar = (mood: AvatarMood, now: number): RasterCells => pick(mood, now, HUMAN_IDLE, HUMAN_STAMP, HUMAN_STAMP)
