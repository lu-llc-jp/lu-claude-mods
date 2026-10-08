import type { FlowActor, FlowStep, SkillFlow } from '../types'
import { FLASH_MS, type PlayFrame } from './play'

/**
 * 流れの1区切りの色分け。
 * edge: 箱と線、live: 進めている手順の枠と線、doneEdge: 終えた手順の枠、no: 手順の番号、title: 手順名、detail: 補足、
 * actor: 担い手(actor で色を変える)、gate: 承認を待つ所、ok: 終えた印、output・outputNew: 成果物(出たばかりは光らせる)、
 * branch・branchLive: 分岐・戻り(粒が渡っているもの)、flow・flowTrail: 依頼の粒とその尾、back・backTrail: 結果の粒とその尾、
 * spin: 進めている印、head: 見出し、note: 補足の文
 */
export type FlowTone =
  | 'edge'
  | 'live'
  | 'doneEdge'
  | 'no'
  | 'title'
  | 'detail'
  | 'actor'
  | 'gate'
  | 'ok'
  | 'output'
  | 'outputNew'
  | 'branch'
  | 'branchLive'
  | 'flow'
  | 'flowTrail'
  | 'back'
  | 'backTrail'
  | 'spin'
  | 'head'
  | 'note'
export type FlowSeg = { text: string; tone: FlowTone; actor?: FlowActor }
export type FlowLine = { key: string; segs: FlowSeg[] }

/** 箱の幅の下限と上限(マス) */
export const BOX_MIN = 20
const BOX_MAX = 56
/** サブエージェントの箱の幅の下限と上限(マス) */
const SIDE_MIN = 16
const SIDE_MAX = 36
/** メインの列からサブエージェントの箱までの、横の線の長さ(マス) */
const GAP = 6
/** 横に並べたときの全体の幅の上限。広いペインでも線が間延びしないように止める */
const MAP_MAX = 96
/** 進めている印のコマ */
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const isWide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1faff) ||
  (cp >= 0x20000 && cp <= 0x3fffd)

/** 端末でのマス数 */
export const cellWidth = (text: string): number => {
  let width = 0
  for (const ch of text) width += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
  return width
}

/** width マスに収める。はみ出すなら末尾を … にする */
export const fit = (text: string, width: number): string => {
  if (width <= 0) return ''
  if (cellWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = cellWidth(ch)
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

const segsWidth = (segs: readonly FlowSeg[]): number => segs.reduce((sum, seg) => sum + cellWidth(seg.text), 0)

/** width マスになるよう、右を空白で埋める */
const padSegs = (segs: FlowSeg[], width: number): FlowSeg[] => {
  const rest = width - segsWidth(segs)
  return rest > 0 ? [...segs, { text: ' '.repeat(rest), tone: 'edge' }] : segs
}

/** 担い手の呼び名。箱の右上に出す */
export const actorLabel = (step: Pick<FlowStep, 'actor' | 'agent'>): string => {
  switch (step.actor) {
    case 'ai':
      return 'AI'
    case 'human':
      return '人'
    case 'script':
      return 'スクリプト'
    case 'subagent':
      return step.agent === undefined ? 'サブエージェント' : `サブエージェント ${step.agent}`
    default:
      return ''
  }
}

/** 手順の行き先(並びの次へ進むだけなら空)。to は飛び先の手順の位置、終わりなら無い */
const branchesOf = (steps: readonly FlowStep[], i: number): Array<{ to?: number; text: string }> => {
  const next = steps[i].next
  if (next === undefined) return []
  const following = steps[i + 1]?.id
  if (next.length === 0) return i === steps.length - 1 ? [] : [{ text: 'ここで終わる' }]
  return next
    .filter(id => id !== following)
    .map(id => {
      const at = steps.findIndex(one => one.id === id)
      const label = `${at + 1}「${steps[at].title.trim()}」`
      return { to: at, text: at <= i ? `↩ ${label}へ戻る` : `↪ ${label}へ進む` }
    })
}

/** 次の手順へ線を下ろすか。終わりを明示した手順と、飛び先だけを持つ手順からは下ろさない */
const flowsDown = (steps: readonly FlowStep[], i: number): boolean => {
  if (i === steps.length - 1) return false
  const next = steps[i].next
  return next === undefined || next.includes(steps[i + 1].id)
}

/** 手順の様子。再生していなければ idle */
type Look = 'idle' | 'pending' | 'active' | 'done'

const lookOf = (frame: PlayFrame | undefined, i: number): Look => {
  if (frame === undefined) return 'idle'
  if (frame.current === i && frame.beat?.kind !== 'travel') return 'active'
  if (frame.done.includes(i)) return 'done'
  return 'pending'
}

/** 手順の箱の行。down なら下の枠の真ん中に ┬ を付ける */
const boxRows = (
  step: FlowStep,
  i: number,
  width: number,
  opts: { label: string; down: boolean; look: Look; frame?: PlayFrame },
): FlowSeg[][] => {
  const inner = width - 4
  const gate = step.gate === true
  const { look, frame } = opts
  const edge: FlowTone = look === 'active' ? (gate ? 'gate' : 'live') : look === 'done' ? 'doneEdge' : gate ? 'gate' : 'edge'
  const no = ` ${i + 1} `
  // 枠の4マス・番号・前後の空白2マスと、線を最低1マス残す
  const shown = opts.label === '' ? '' : ` ${fit(opts.label, Math.max(1, width - 7 - cellWidth(no)))} `
  const fill = Math.max(1, width - 4 - cellWidth(no) - cellWidth(shown))
  const rows: FlowSeg[][] = [
    [
      { text: '╭─', tone: edge },
      { text: no, tone: 'no' },
      { text: '─'.repeat(fill), tone: edge },
      ...(shown === '' ? [] : [{ text: shown, tone: 'actor' as const, actor: step.actor }]),
      { text: '─╮', tone: edge },
    ],
  ]
  const row = (segs: FlowSeg[]) => {
    rows.push([{ text: '│ ', tone: edge }, ...padSegs(segs, inner), { text: ' │', tone: edge }])
  }
  // 進めている手順には回る印を、終えた手順には ✓ を名前の後ろに付ける
  const mark =
    look === 'active' && frame !== undefined
      ? { text: ` ${SPIN[Math.floor(frame.elapsed / 100) % SPIN.length]}`, tone: 'spin' as const }
      : look === 'done'
        ? { text: ' ✓', tone: 'ok' as const }
        : undefined
  const title = fit(step.title, inner - (mark === undefined ? 0 : 2))
  row([{ text: title, tone: 'title' }, ...(mark === undefined ? [] : [mark])])
  if (step.detail !== undefined) row([{ text: fit(step.detail, inner), tone: 'detail' }])
  if (gate) {
    // 承認を待っているあいだは、文を変えて点滅させる
    const waiting = look === 'active' && frame !== undefined
    const blink = waiting && Math.floor(frame.elapsed / 450) % 2 === 1
    row([{ text: fit(waiting ? '⏸ 人の承認を待っています…' : '⏸ ここで人の承認を待つ', inner), tone: blink ? 'note' : 'gate' }])
  }
  for (const output of step.outputs ?? []) row([{ text: fit(`▸ ${output}`, inner), tone: 'output' }])
  const center = Math.floor(width / 2)
  rows.push([
    {
      text: opts.down ? `╰${'─'.repeat(center - 1)}┬${'─'.repeat(width - center - 2)}╯` : `╰${'─'.repeat(width - 2)}╯`,
      tone: edge,
    },
  ])
  return rows
}

/** 線の上を粒が渡る。cells は線のマス数、progress は 0〜1、back なら右から左へ戻る。trail は粒のすぐ後ろ(尾)のマス */
const particle = (cells: number, progress: number, back: boolean): { at: number; trail: (k: number) => boolean } => {
  const moved = Math.min(cells - 1, Math.floor(progress * cells))
  const at = back ? cells - 1 - moved : moved
  return { at, trail: k => (back ? k > at && k <= at + 2 : k < at && k >= at - 2) }
}

/** 文字を1マスずつ色分けしたものを、同じ色の続きでまとめる */
const joinCells = (cells: FlowSeg[]): FlowSeg[] => {
  const out: FlowSeg[] = []
  for (const cell of cells) {
    const last = out.at(-1)
    if (last !== undefined && last.tone === cell.tone) last.text += cell.text
    else out.push({ ...cell })
  }
  return out
}

/** サブエージェントの手順を横の箱にするか。サブエージェントの手順があり、横に並べる幅があるとき */
export const hasSideAgents = (flow: SkillFlow, width: number): boolean =>
  width >= BOX_MIN + GAP + SIDE_MIN && flow.steps.some(step => step.actor === 'subagent')

/**
 * 流れを、上から下へ箱を積んだ行にする。
 * 箱の上の枠に番号と担い手、中に手順名・補足・成果物を置き、承認を待つ所には印を付ける。
 * サブエージェントの手順は、幅があればメインの列から横に線を出した箱にする。
 * 分岐・戻りは箱の下に一言で添え、成果物は末尾にまとめる。
 * frame を渡すと再生の1コマとして描く(進めている手順を光らせ、線の上に粒を流し、出てきた成果物だけを積む)
 */
export const layoutFlow = (flow: SkillFlow, width: number, frame?: PlayFrame): FlowLine[] => {
  const steps = flow.steps
  const side = hasSideAgents(flow, width)
  const total = Math.min(width, MAP_MAX)
  const mainW = side
    ? Math.max(BOX_MIN, Math.min(48, Math.floor((total - GAP) * 0.55)))
    : Math.max(BOX_MIN, Math.min(BOX_MAX, width))
  const sideW = side ? Math.max(SIDE_MIN, Math.min(SIDE_MAX, total - GAP - mainW)) : 0
  const center = Math.floor(mainW / 2)
  const isSide = (step: FlowStep | undefined) => side && step?.actor === 'subagent'
  const beat = frame?.beat
  const lines: FlowLine[] = []

  steps.forEach((step, i) => {
    const key = `step:${step.id}`
    const look = lookOf(frame, i)
    const down = flowsDown(steps, i)
    if (!isSide(step)) {
      boxRows(step, i, mainW, { label: actorLabel(step), down, look, frame }).forEach((segs, r) => {
        lines.push({ key: `${key}:${r}`, segs })
      })
    } else {
      // メインの列には幹の線を通し、手順名の行から横に線を出して、右にサブエージェントの箱を置く
      const rows = boxRows(step, i, sideW, { label: step.agent ?? 'サブエージェント', down: false, look, frame })
      const lit: FlowTone = look === 'active' ? 'live' : 'edge'
      const wire = mainW - center - 1 + GAP - 1
      const back = beat?.kind === 'return'
      const moving = frame !== undefined && beat !== undefined && beat.kind !== 'travel' && beat.step === i && (beat.kind === 'dispatch' || back)
      const dot = moving ? particle(wire, frame.progress, back) : undefined
      rows.forEach((segs, r) => {
        let left: FlowSeg[]
        if (r === 1) {
          const cells: FlowSeg[] = []
          for (let k = 0; k < wire; k += 1) {
            if (dot !== undefined && k === dot.at) cells.push({ text: back ? '◆' : '●', tone: back ? 'back' : 'flow' })
            else if (dot !== undefined && dot.trail(k)) cells.push({ text: '─', tone: back ? 'backTrail' : 'flowTrail' })
            else cells.push({ text: '─', tone: lit })
          }
          left = [{ text: ' '.repeat(center), tone: 'edge' }, { text: '├', tone: lit }, ...joinCells(cells), { text: '▶', tone: lit }]
        } else {
          left = padSegs([{ text: ' '.repeat(center), tone: 'edge' }, { text: '│', tone: lit }], mainW + GAP)
        }
        lines.push({ key: `${key}:${r}`, segs: [...left, ...segs] })
      })
    }

    // 分岐・戻り。粒が渡っているものは光らせる
    for (const [j, branch] of branchesOf(steps, i).entries()) {
      const live = beat?.kind === 'travel' && beat.via === 'jump' && beat.from === i && beat.to === branch.to
      lines.push({
        key: `${key}:branch:${j}`,
        segs: [{ text: `${live ? '● ' : '  '}${fit(branch.text, mainW - 2)}`, tone: live ? 'branchLive' : 'branch' }],
      })
    }

    // 次の手順への線。粒が渡っていれば、そのマスに置く
    if (down) {
      const traveling = frame !== undefined && beat?.kind === 'travel' && beat.via === 'down' && beat.from === i
      const dot = traveling ? particle(2, frame.progress, false).at : -1
      const glyphs = ['│', isSide(steps[i + 1]) ? '│' : '▼']
      glyphs.forEach((glyph, r) => {
        const tone: FlowTone = r === dot ? 'flow' : traveling && r < dot ? 'flowTrail' : 'edge'
        lines.push({
          key: `${key}:link:${r}`,
          segs: [{ text: ' '.repeat(center), tone: 'edge' }, { text: r === dot ? '●' : glyph, tone }],
        })
      })
    }
  })

  // 成果物。再生中は出てきたものだけを、出た順に積む
  const outputs =
    frame === undefined
      ? flow.outputs.map(one => ({ text: one.where === undefined ? one.name : `${one.name} — ${one.where}`, isNew: false }))
      : frame.outputs.map(one => ({ text: one.text, isNew: frame.elapsed - one.at < FLASH_MS }))
  const expects = flow.outputs.length > 0 || steps.some(one => (one.outputs ?? []).length > 0)
  if (outputs.length > 0 || (frame !== undefined && expects)) {
    lines.push({ key: 'outputs:gap', segs: [] })
    lines.push({ key: 'outputs:head', segs: [{ text: '成果物', tone: 'head' }] })
    if (outputs.length === 0) lines.push({ key: 'outputs:none', segs: [{ text: 'まだありません', tone: 'note' }] })
    for (const [i, output] of outputs.entries()) {
      lines.push({
        key: `outputs:${i}`,
        segs: [{ text: fit(`▸ ${output.text}`, Math.max(1, width)), tone: output.isNew ? 'outputNew' : 'output' }],
      })
    }
  }
  return lines
}

/** 流れの中に出てくるサブエージェントの名前 */
export const flowAgents = (flow: SkillFlow): string[] => [
  ...new Set(flow.steps.flatMap(step => (step.actor === 'subagent' && step.agent !== undefined ? [step.agent] : []))),
]
