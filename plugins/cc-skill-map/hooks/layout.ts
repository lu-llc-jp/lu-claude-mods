import type { FlowActor, FlowStep, SkillFlow } from '../types'

/**
 * 流れの1区切りの色分け。
 * edge: 箱と線、no: 手順の番号、title: 手順名、detail: 補足、actor: 担い手(actor で色を変える)、
 * gate: 承認を待つ所、output: 成果物、branch: 分岐・戻り、head: 見出し、note: 補足の文
 */
export type FlowTone = 'edge' | 'no' | 'title' | 'detail' | 'actor' | 'gate' | 'output' | 'branch' | 'head' | 'note'
export type FlowSeg = { text: string; tone: FlowTone; actor?: FlowActor }
export type FlowLine = { key: string; segs: FlowSeg[] }

/** 箱の幅の下限と上限(マス) */
export const BOX_MIN = 20
const BOX_MAX = 56

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

/** 手順の行き先を一言にする。並びの次へ進むだけなら undefined */
const branchTexts = (steps: readonly FlowStep[], i: number): string[] | undefined => {
  const next = steps[i].next
  if (next === undefined) return undefined
  const following = steps[i + 1]?.id
  if (next.length === 0) return i === steps.length - 1 ? undefined : ['ここで終わる']
  if (next.length === 1 && next[0] === following) return undefined
  return next
    .filter(id => id !== following)
    .map(id => {
      const at = steps.findIndex(one => one.id === id)
      const label = `${at + 1}「${steps[at].title.trim()}」`
      return at <= i ? `↩ ${label}へ戻る` : `↪ ${label}へ進む`
    })
}

/** 次の手順へ線を下ろすか。終わりを明示した手順と、飛び先だけを持つ手順からは下ろさない */
const flowsDown = (steps: readonly FlowStep[], i: number): boolean => {
  if (i === steps.length - 1) return false
  const next = steps[i].next
  return next === undefined || next.includes(steps[i + 1].id)
}

/**
 * 流れを、上から下へ箱を積んだ行にする。
 * 箱の上の枠に番号と担い手、中に手順名・補足・成果物を置き、承認を待つ所には印を付ける。
 * 分岐・戻りは箱の下に一言で添え、スキル全体の成果物は末尾にまとめる
 */
export const layoutFlow = (flow: SkillFlow, width: number): FlowLine[] => {
  const box = Math.max(BOX_MIN, Math.min(BOX_MAX, width))
  const inner = box - 4
  const lines: FlowLine[] = []
  const center = Math.floor(box / 2)

  flow.steps.forEach((step, i) => {
    const key = `step:${step.id}`
    const no = ` ${i + 1} `
    const label = actorLabel(step)
    const gate = step.gate === true
    const edgeTone: FlowTone = gate ? 'gate' : 'edge'
    // 上の枠: ╭─ 1 ─────── AI ─╮。担い手の名前が長ければ詰める
    // 枠の4マス・番号・前後の空白2マスと、線を最低1マス残す
    const shown = label === '' ? '' : ` ${fit(label, Math.max(1, box - 7 - cellWidth(no)))} `
    const fill = Math.max(1, box - 4 - cellWidth(no) - cellWidth(shown))
    lines.push({
      key: `${key}:top`,
      segs: [
        { text: '╭─', tone: edgeTone },
        { text: no, tone: 'no' },
        { text: '─'.repeat(fill), tone: edgeTone },
        ...(shown === '' ? [] : [{ text: shown, tone: 'actor' as const, actor: step.actor }]),
        { text: '─╮', tone: edgeTone },
      ],
    })
    const row = (suffix: string, segs: FlowSeg[]) => {
      const used = segs.reduce((sum, seg) => sum + cellWidth(seg.text), 0)
      lines.push({
        key: `${key}:${suffix}`,
        segs: [{ text: '│ ', tone: edgeTone }, ...segs, { text: `${' '.repeat(Math.max(0, inner - used))} │`, tone: edgeTone }],
      })
    }
    row('title', [{ text: fit(step.title, inner), tone: 'title' }])
    if (step.detail !== undefined) row('detail', [{ text: fit(step.detail, inner), tone: 'detail' }])
    if (gate) row('gate', [{ text: fit('⏸ ここで人の承認を待つ', inner), tone: 'gate' }])
    for (const [j, output] of (step.outputs ?? []).entries()) {
      row(`out:${j}`, [{ text: fit(`▸ ${output}`, inner), tone: 'output' }])
    }
    // 下の枠。次へ下ろすなら真ん中に ┬
    const down = flowsDown(flow.steps, i)
    lines.push({
      key: `${key}:bottom`,
      segs: [
        {
          text: down
            ? `╰${'─'.repeat(center - 1)}┬${'─'.repeat(box - center - 2)}╯`
            : `╰${'─'.repeat(box - 2)}╯`,
          tone: edgeTone,
        },
      ],
    })
    for (const [j, text] of (branchTexts(flow.steps, i) ?? []).entries()) {
      lines.push({ key: `${key}:branch:${j}`, segs: [{ text: `${' '.repeat(2)}${fit(text, box - 2)}`, tone: 'branch' }] })
    }
    if (down) lines.push({ key: `${key}:link`, segs: [{ text: `${' '.repeat(center)}▼`, tone: 'edge' }] })
  })

  if (flow.outputs.length > 0) {
    lines.push({ key: 'outputs:gap', segs: [] })
    lines.push({ key: 'outputs:head', segs: [{ text: '成果物', tone: 'head' }] })
    for (const [i, output] of flow.outputs.entries()) {
      const text = output.where === undefined ? output.name : `${output.name} — ${output.where}`
      lines.push({ key: `outputs:${i}`, segs: [{ text: fit(`▸ ${text}`, Math.max(1, width)), tone: 'output' }] })
    }
  }
  return lines
}

/** 流れの中に出てくるサブエージェントの名前 */
export const flowAgents = (flow: SkillFlow): string[] => [
  ...new Set(flow.steps.flatMap(step => (step.actor === 'subagent' && step.agent !== undefined ? [step.agent] : []))),
]
