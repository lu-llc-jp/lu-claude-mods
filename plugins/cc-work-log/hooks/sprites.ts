import { CLEAR, mix, setPixel, type Pixels } from './raster'

/**
 * キャラの点描。'.' 透明、'o' 輪郭、'b' 体、'l' 明るい面、'a' アクセント(ランプ・くちばしなど)、'e' 目。
 * 左半分だけ書いて鏡に映すものは mirror で広げる
 */
const mirror = (left: readonly string[]): string[] => left.map(row => row + [...row].reverse().join(''))

export type SpriteKind = 'main' | 'explore' | 'plan' | 'general' | 'other'

type Palette = { o: number; b: number; l: number; a: number; e: number }
type Sprite = { art: readonly string[]; palette: Palette }

const SPRITES: Record<SpriteKind, Sprite> = {
  // メイン: アンテナにランプを載せた司令塔のロボ(8×8)
  main: {
    art: mirror(['...a', '...o', 'oooo', 'obbb', 'obeb', 'obbl', 'oooo', '.oo.']),
    palette: { o: 0x5a2a1a, b: 0xe07a4f, l: 0xf6c39f, a: 0xffd54a, e: 0x1d1d1d },
  },
  // Explore: 見張りのフクロウ(6×6)
  explore: {
    art: mirror(['o..', 'obb', 'oel', 'bba', 'bll', '.oo']),
    palette: { o: 0x223a6b, b: 0x6b8fd6, l: 0xd8e4ff, a: 0xf2b84b, e: 0x111111 },
  },
  // Plan: 目のある巻物(6×6)
  plan: {
    art: mirror(['oaa', '.ll', '.el', '.ll', '.lb', 'oaa']),
    palette: { o: 0x5c3d1e, b: 0xc9a86a, l: 0xf3e3b5, a: 0xa0703a, e: 0x333333 },
  },
  // general-purpose: アンテナの付いた小さなロボ(6×6)
  general: {
    art: mirror(['..a', 'ooo', 'oeb', 'obl', 'ooo', '.o.']),
    palette: { o: 0x3b4650, b: 0x9aa7b0, l: 0xdfe6ea, a: 0xff6b6b, e: 0x4de1ff },
  },
  // それ以外: スライム(6×6)
  other: {
    art: mirror(['...', '.oo', 'obb', 'oeb', 'obl', 'ooo']),
    palette: { o: 0x2e6b3a, b: 0x7bd389, l: 0xc9f2cf, a: 0xffffff, e: 0x113311 },
  },
}

export const kindOf = (type: string): SpriteKind =>
  type === 'Explore' ? 'explore' : type === 'Plan' ? 'plan' : type === 'general-purpose' ? 'general' : 'other'

export const spriteSize = (kind: SpriteKind): { width: number; height: number } => {
  const art = SPRITES[kind].art
  return { width: art[0]?.length ?? 0, height: art.length }
}

/** キャラの描き方。blink: 目を閉じる、accent: ランプなどの色を差し替える、fade: 色を落とす割合、tint: 色を寄せる先 */
export type SpriteLook = { blink?: boolean; accent?: number; fade?: number; tint?: number }

const GRAY = 0x6a6f78
const RED = 0xd04848

/** (x, y) を左上にキャラを置く */
export const drawSprite = (pixels: Pixels, kind: SpriteKind, x: number, y: number, look: SpriteLook = {}): void => {
  const { art, palette } = SPRITES[kind]
  art.forEach((row, dy) => {
    ;[...row].forEach((ch, dx) => {
      if (ch === '.') return
      let color =
        ch === 'e' && look.blink === true
          ? palette.b
          : ch === 'a' && look.accent !== undefined
            ? look.accent
            : (palette[ch as keyof Palette] ?? CLEAR)
      if (look.fade !== undefined) color = mix(color, GRAY, look.fade)
      if (look.tint !== undefined) color = mix(color, look.tint, 0.55)
      setPixel(pixels, x + dx, y + dy, color)
    })
  })
}

/** 終えた印(4×3)。ok は緑のチェック、error は赤のばつ */
const CHECK = ['...g', 'g.g.', '.g..']
const CROSS = ['g.g.', '.g..', 'g.g.']
export const OK_GREEN = 0x5fd068
export const drawBadge = (pixels: Pixels, ok: boolean, x: number, y: number): void => {
  const color = ok ? OK_GREEN : RED
  ;(ok ? CHECK : CROSS).forEach((row, dy) => {
    ;[...row].forEach((ch, dx) => {
      if (ch === 'g') setPixel(pixels, x + dx, y + dy, color)
    })
  })
}

export const ERROR_RED = RED
