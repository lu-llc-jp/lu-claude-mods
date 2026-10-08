import type { FlowActor, FlowStep, SkillFlow } from '../types'
import { AVATAR_COLUMNS, AVATAR_ROWS, type AvatarMood } from './avatar'
import { actorLabel, cellWidth, fit, type FlowLine, type FlowSeg, type FlowTone } from './layout'
import { FLASH_MS, type PlayFrame } from './play'

/**
 * 組織図の見せ方。上段の左にメイン、右に人のカード(ターミナルではキャラを描く)、
 * 下段にスクリプトとサブエージェントの箱を並べ、メインから依頼の粒が渡って結果の粒が戻る。
 * その下に手順を1行ずつ並べ、ペインの高さに収める
 */

/** 組織図にできる幅の下限。これより狭ければ、縦に箱を積む見せ方にする */
export const STAGE_MIN = 66
/** 組織図の幅の上限。広いペインでも線が間延びしないように止める */
const STAGE_MAX = 110
/** メインと人のカードのあいだの線の長さ(マス) */
const LINK = 8
/** 人のカードの幅の下限と上限 */
const HUMAN_MIN = 28
const HUMAN_MAX = 36
/** 担い手の箱の幅の下限と上限、箱どうしの間 */
const BOX_MIN = 14
const BOX_MAX = 26
const BOX_GAP = 2
/** カードの高さ(上下の枠 + 中身。中身はキャラの高さに合わせる) */
const CARD_ROWS = AVATAR_ROWS + 2
/** 担い手の箱の高さ(上下の枠 + 中身2行) */
const BOX_ROWS = 4
/** 結果が届いてから、メインのキャラが喜んでいる時間(ms) */
const CHEER_MS = 700
/** 進めている印のコマ */
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** 組織図では、スクリプト・サブエージェント・人の手順に依頼の粒を流す */
export const STAGE_DELEGATED: readonly FlowActor[] = ['subagent', 'script', 'human']

/** メインの下に並べる担い手。スクリプトは1つの箱に、サブエージェントは名前ごとに箱にする */
export type Worker = { key: string; label: string; actor: 'script' | 'subagent'; steps: number[] }

export const workersOf = (flow: SkillFlow): Worker[] => {
  const list: Worker[] = []
  flow.steps.forEach((step, i) => {
    if (step.actor !== 'script' && step.actor !== 'subagent') return
    const key = step.actor === 'script' ? 'script' : `agent:${step.agent ?? ''}`
    let worker = list.find(one => one.key === key)
    if (worker === undefined) {
      worker = { key, label: step.actor === 'script' ? 'スクリプト' : (step.agent ?? 'サブエージェント'), actor: step.actor, steps: [] }
      list.push(worker)
    }
    worker.steps.push(i)
  })
  return list
}

// ---- 文字のマス目 ----

/** 1マス。null は、前のマスの全角文字の右半分 */
type Cell = { ch: string; tone: FlowTone; actor?: FlowActor } | null
type Grid = Cell[][]

const makeGrid = (rows: number, columns: number): Grid =>
  Array.from({ length: rows }, () => Array.from({ length: columns }, (): Cell => ({ ch: ' ', tone: 'edge' })))

/** r 行の x マス目から文字を書く。全角は2マス使う。はみ出すぶんは書かない */
const put = (grid: Grid, r: number, x: number, text: string, tone: FlowTone, actor?: FlowActor): number => {
  let at = x
  for (const ch of text) {
    const w = cellWidth(ch)
    if (at < 0 || at + w > grid[r].length) break
    grid[r][at] = { ch, tone, ...(actor === undefined ? {} : { actor }) }
    if (w === 2) grid[r][at + 1] = null
    at += w
  }
  return at
}

const retone = (grid: Grid, r: number, x: number, tone: FlowTone): void => {
  const cell = grid[r][x]
  if (cell !== null && cell !== undefined) grid[r][x] = { ...cell, tone }
}

/** from から to の手前までのマスを、同じ色の続きでまとめる */
const segsOf = (grid: Grid, r: number, from = 0, to = grid[r].length): FlowSeg[] => {
  const out: FlowSeg[] = []
  for (let x = from; x < to; x += 1) {
    const cell = grid[r][x]
    if (cell === null) continue
    const last = out.at(-1)
    if (last !== undefined && last.tone === cell.tone && last.actor === cell.actor) last.text += cell.ch
    else out.push({ text: cell.ch, tone: cell.tone, ...(cell.actor === undefined ? {} : { actor: cell.actor }) })
  }
  return out
}

/** 行末の空白を落とした行 */
const trimmed = (segs: FlowSeg[]): FlowSeg[] => {
  const out = segs.map(seg => ({ ...seg }))
  while (out.length > 0) {
    const last = out[out.length - 1]
    const text = last.text.replace(/ +$/, '')
    if (text !== '') {
      last.text = text
      break
    }
    out.pop()
  }
  return out
}

/** 枠を描く。上の枠の左に見出しを置く */
const box = (
  grid: Grid,
  top: number,
  left: number,
  width: number,
  height: number,
  tone: FlowTone,
  head: { text: string; tone: FlowTone; actor?: FlowActor },
): void => {
  const bottom = top + height - 1
  put(grid, top, left, `╭${'─'.repeat(width - 2)}╮`, tone)
  put(grid, bottom, left, `╰${'─'.repeat(width - 2)}╯`, tone)
  for (let r = top + 1; r < bottom; r += 1) {
    put(grid, r, left, '│', tone)
    put(grid, r, left + width - 1, '│', tone)
  }
  if (head.text !== '') put(grid, top, left + 2, ` ${fit(head.text, Math.max(1, width - 6))} `, head.tone, head.actor)
}

/** 線の上の粒。cells は道筋のマス、progress は 0〜1、back なら終わりから始めへ戻る */
const flowParticle = (grid: Grid, cells: ReadonlyArray<[number, number]>, progress: number, back: boolean): void => {
  if (cells.length === 0) return
  const moved = Math.min(cells.length - 1, Math.floor(progress * cells.length))
  const at = back ? cells.length - 1 - moved : moved
  cells.forEach(([r, x], k) => {
    const trail = back ? k > at && k <= at + 2 : k < at && k >= at - 2
    if (trail) retone(grid, r, x, back ? 'backTrail' : 'flowTrail')
  })
  const [r, x] = cells[at]
  put(grid, r, x, back ? '◆' : '●', back ? 'back' : 'flow')
}

/** 分かれ目の罫線。上下左右のどちらに線が伸びるかで決める */
const junction = (up: boolean, down: boolean, left: boolean, right: boolean): string => {
  const key = `${up ? 'u' : ''}${down ? 'd' : ''}${left ? 'l' : ''}${right ? 'r' : ''}`
  const table: Record<string, string> = {
    udlr: '┼', udl: '┤', udr: '├', ud: '│', ulr: '┴', dlr: '┬', ul: '╯', ur: '╰', dl: '╮', dr: '╭', lr: '─', u: '│', d: '│',
  }
  return table[key] ?? '─'
}

// ---- 様子 ----

/** 今の手順と、その区切り。粒が渡っているあいだは手順を進めていない */
const nowOf = (frame: PlayFrame | undefined) => {
  if (frame === undefined || frame.isFinished || frame.beat === undefined || frame.current === undefined) return undefined
  return { step: frame.current, beat: frame.beat }
}

/** キャラの様子。メインは自分で手順を進めているあいだ手を動かし、結果が届いたら喜ぶ。人は出番のあいだ承認印を掲げる */
export const stageMoods = (flow: SkillFlow, frame: PlayFrame | undefined): { main: AvatarMood; human: AvatarMood } => {
  const now = nowOf(frame)
  const step = now === undefined ? undefined : flow.steps[now.step]
  const self = now !== undefined && now.beat.kind === 'work' && step !== undefined && !STAGE_DELEGATED.includes(step.actor)
  const cheer = frame?.returnedAt !== undefined && frame.elapsed - frame.returnedAt < CHEER_MS
  const human = now !== undefined && now.beat.kind !== 'travel' && step?.actor === 'human'
  return { main: self ? 'busy' : cheer ? 'cheer' : 'idle', human: human ? 'busy' : 'idle' }
}

const spinOf = (frame: PlayFrame): string => SPIN[Math.floor(frame.elapsed / 100) % SPIN.length]

const whoOf = (step: FlowStep): string =>
  step.actor === 'human' ? '人' : step.actor === 'script' ? 'スクリプト' : step.actor === 'subagent' ? (step.agent ?? 'サブエージェント') : 'メイン'

type Text = { text: string; tone: FlowTone; actor?: FlowActor }

/** メインのカードの中身(4行)。今していることを、メインを起点に言う */
const mainTexts = (flow: SkillFlow, frame: PlayFrame | undefined): Text[] => {
  const steps = flow.steps
  if (frame === undefined) {
    const gates = steps.filter(one => one.gate === true).length
    return [
      { text: flow.by === 'headings' ? '見出しから作った流れ' : 'スキルの流れ', tone: 'head' },
      { text: `手順 ${steps.length}${gates === 0 ? '' : ` · 承認 ${gates} か所`}`, tone: 'detail' },
      { text: `依頼先 ${workersOf(flow).length + (steps.some(one => one.actor === 'human') ? 1 : 0)}`, tone: 'detail' },
      { text: '', tone: 'note' },
    ]
  }
  if (frame.isFinished) {
    return [
      { text: `✓ ${steps.length} 手順を終えた`, tone: 'ok' },
      { text: '', tone: 'note' },
      { text: `成果物 ${frame.outputs.length}`, tone: 'detail' },
      { text: '', tone: 'note' },
    ]
  }
  const now = nowOf(frame)
  if (now === undefined) return [{ text: '', tone: 'note' }]
  const status: Text = { text: `${spinOf(frame)} 手順 ${now.step + 1}/${steps.length}`, tone: 'spin' }
  const outputs: Text = { text: `成果物 ${frame.outputs.length}`, tone: 'detail' }
  const beat = now.beat
  if (beat.kind === 'travel') {
    const to = steps[beat.to]
    const text =
      beat.via === 'down' ? `→ 次は「${to.title.trim()}」` : beat.to <= beat.from ? `↩ 「${to.title.trim()}」へ戻る` : `↪ 「${to.title.trim()}」へ進む`
    return [status, { text, tone: beat.via === 'down' ? 'title' : 'branchLive' }, { text: whoOf(to), tone: 'actor', actor: to.actor }, outputs]
  }
  const step = steps[beat.step]
  if (!STAGE_DELEGATED.includes(step.actor)) {
    return [status, { text: step.title.trim(), tone: 'title' }, { text: step.detail ?? '', tone: 'detail' }, outputs]
  }
  const who = whoOf(step)
  const doing =
    beat.kind === 'dispatch' ? `${who} に依頼` : beat.kind === 'return' ? `${who} から受け取る` : step.gate === true ? `${who} の承認を待つ` : `${who} の作業を待つ`
  return [status, { text: doing, tone: 'actor', actor: step.actor }, { text: step.title.trim(), tone: 'detail' }, outputs]
}

/** 人のカードの中身(4行) */
const humanTexts = (flow: SkillFlow, frame: PlayFrame | undefined): Text[] => {
  const mine = flow.steps.flatMap((step, i) => (step.actor === 'human' ? [i] : []))
  if (mine.length === 0) return [{ text: '出番なし', tone: 'note' }]
  if (frame === undefined) {
    const first = flow.steps[mine[0]]
    return [
      { text: `出番 ${mine.length} 回`, tone: 'detail' },
      { text: first.title.trim(), tone: 'detail' },
      ...(mine.length > 1 ? [{ text: `ほか ${mine.length - 1} 手順`, tone: 'note' as const }] : []),
    ]
  }
  const now = nowOf(frame)
  const done = mine.filter(i => frame.done.includes(i)).length
  if (now !== undefined && now.beat.kind !== 'travel' && mine.includes(now.step)) {
    const step = flow.steps[now.step]
    const waiting = step.gate === true && now.beat.kind === 'wait'
    const blink = waiting && Math.floor(frame.elapsed / 450) % 2 === 1
    return [
      waiting ? { text: '⏸ 承認待ち', tone: blink ? 'note' : 'gate' } : { text: `${spinOf(frame)} 出番`, tone: 'spin' },
      { text: step.title.trim(), tone: 'title' },
      { text: step.detail ?? '', tone: 'detail' },
      { text: `${done}/${mine.length} 手順`, tone: 'note' },
    ]
  }
  return [{ text: done === mine.length ? `✓ ${done}/${mine.length} 手順` : `${done}/${mine.length} 手順`, tone: done === mine.length ? 'ok' : 'note' }]
}

// ---- 配置 ----

/** キャラを描く帯。左から順に、文字の列とキャラ(main・human)を並べる */
export type StageBand = {
  key: string
  cols: Array<{ kind: 'text'; key: string; rows: FlowSeg[][] } | { kind: 'raster'; who: 'main' | 'human' }>
}
/** 帯の上の行、帯、帯の下の行。キャラを描かない面では帯が無く、すべて行になる */
export type Stage = { before: FlowLine[]; band?: StageBand; after: FlowLine[] }

/** 手順の一覧の1行 */
const stepLine = (flow: SkillFlow, i: number, width: number, frame: PlayFrame | undefined): FlowLine => {
  const step = flow.steps[i]
  const now = nowOf(frame)
  const active = now !== undefined && now.step === i && now.beat.kind !== 'travel'
  const mark: FlowSeg =
    frame === undefined
      ? { text: ' ', tone: 'note' }
      : active
        ? { text: spinOf(frame), tone: 'spin' }
        : frame.done.includes(i)
          ? { text: '✓', tone: 'ok' }
          : { text: '·', tone: 'note' }
  const no = String(i + 1).padStart(String(flow.steps.length).length, ' ')
  const label = actorLabel(step)
  const tail: FlowSeg[] = [
    ...(label === '' ? [] : [{ text: ` ${label}`, tone: 'actor' as const, actor: step.actor }]),
    ...(step.gate === true ? [{ text: ' ⏸', tone: 'gate' as const }] : []),
  ]
  // 戻り・飛び先。粒が渡っているものは光らせる
  const jump =
    now?.beat.kind === 'travel' && now.beat.via === 'jump' && now.beat.from === i
      ? { text: ` ${now.beat.to <= i ? '↩' : '↪'} ${now.beat.to + 1} へ`, tone: 'branchLive' as const }
      : step.next !== undefined && step.next.some(id => id !== flow.steps[i + 1]?.id)
        ? {
            text: ` ${step.next
              .filter(id => id !== flow.steps[i + 1]?.id)
              .map(id => {
                const at = flow.steps.findIndex(one => one.id === id)
                return `${at <= i ? '↩' : '↪'}${at + 1}`
              })
              .join(' ')}`,
            tone: 'branch' as const,
          }
        : undefined
  const room = width - 2 - cellWidth(no) - 1 - tail.reduce((sum, seg) => sum + cellWidth(seg.text), 0) - (jump === undefined ? 0 : cellWidth(jump.text))
  return {
    key: `list:${step.id}:${i}`,
    segs: [
      mark,
      { text: ` ${no} `, tone: 'no' },
      { text: fit(step.title.trim(), Math.max(4, room)), tone: active ? 'title' : frame !== undefined && frame.done.includes(i) ? 'detail' : 'title' },
      ...tail,
      ...(jump === undefined ? [] : [jump]),
    ],
  }
}

/**
 * 組織図の行を作る。height はペインの本体に使える行数で、手順の一覧はこれに収まるぶんだけ出す
 * (入りきらなければ、今の手順のまわりを出し、前後は「… n 手順」にまとめる)
 */
export const layoutStage = (
  flow: SkillFlow,
  width: number,
  height: number,
  frame: PlayFrame | undefined,
  opts: { avatars: boolean },
): Stage => {
  const W = Math.min(width, STAGE_MAX)
  const avatar = opts.avatars ? AVATAR_COLUMNS + 1 : 0
  const humanW = Math.max(HUMAN_MIN, Math.min(HUMAN_MAX, Math.floor(W * 0.4)))
  const mainW = W - LINK - humanW
  const hx = mainW + LINK
  const hubX = Math.floor(mainW / 2)
  const steps = flow.steps
  const now = nowOf(frame)
  const current = now === undefined ? undefined : steps[now.step]
  const delegatedNow = current !== undefined && STAGE_DELEGATED.includes(current.actor) && now?.beat.kind !== 'travel'

  // 担い手の箱。横に入るだけ並べ、入らなければ後ろを省く
  const workers = workersOf(flow)
  const bw = workers.length === 0 ? 0 : Math.max(BOX_MIN, Math.min(BOX_MAX, Math.floor((W - (workers.length - 1) * BOX_GAP) / workers.length)))
  const fits = workers.length === 0 ? 0 : Math.max(1, Math.floor((W + BOX_GAP) / (bw + BOX_GAP)))
  const shown = workers.slice(0, fits)
  const span = shown.length * bw + Math.max(0, shown.length - 1) * BOX_GAP
  const x0 = Math.max(0, Math.min(W - span, hubX - Math.floor(span / 2)))
  // 線は箱の左寄り(角の1つ右)に下ろし、見出しはその右に置く。真ん中に下ろすと長い見出しと重なるため
  const centers = shown.map((_, k) => x0 + k * (bw + BOX_GAP) + 2)

  const gridRows = CARD_ROWS + (shown.length === 0 ? 0 : 2 + BOX_ROWS)
  const grid = makeGrid(gridRows, W)

  // メインのカード
  const mainBusy = current !== undefined && !STAGE_DELEGATED.includes(current.actor) && now?.beat.kind === 'work'
  const mainTone: FlowTone = mainBusy || (frame !== undefined && frame.returnedAt !== undefined && frame.elapsed - frame.returnedAt < FLASH_MS / 2) ? 'live' : frame?.isFinished === true ? 'doneEdge' : 'edge'
  box(grid, 0, 0, mainW, CARD_ROWS, mainTone, { text: opts.avatars ? 'メイン' : '◉ メイン', tone: 'head' })
  const mainText = mainTexts(flow, frame)
  const tw = mainW - 4 - avatar
  mainText.slice(0, AVATAR_ROWS).forEach((one, k) => put(grid, 1 + k, 2 + avatar, fit(one.text, tw), one.tone, one.actor))

  // 人のカード
  const humanActive = current?.actor === 'human' && delegatedNow
  const hasHuman = steps.some(one => one.actor === 'human')
  const humanTone: FlowTone = humanActive ? (current?.gate === true ? 'gate' : 'live') : hasHuman ? 'edge' : 'doneEdge'
  box(grid, 0, hx, humanW, CARD_ROWS, humanTone, { text: opts.avatars ? '人' : '◉ 人', tone: 'actor', actor: 'human' })
  const hw = humanW - 4 - avatar
  humanTexts(flow, frame).slice(0, AVATAR_ROWS).forEach((one, k) => put(grid, 1 + k, hx + 2 + avatar, fit(one.text, hw), one.tone, one.actor))

  // メインと人をつなぐ線
  const linkRow = 1 + Math.floor(AVATAR_ROWS / 2)
  const humanPath: Array<[number, number]> = []
  if (hasHuman) {
    put(grid, linkRow, mainW - 1, '├', mainTone)
    put(grid, linkRow, hx, '┤', humanTone)
    for (let x = mainW; x < hx; x += 1) {
      put(grid, linkRow, x, '─', humanActive ? 'live' : 'edge')
      humanPath.push([linkRow, x])
    }
  }

  // メインから担い手の箱へ、組織図の線を下ろす
  const paths: Array<Array<[number, number]>> = []
  if (shown.length > 0) {
    const split = CARD_ROWS
    const drop = CARD_ROWS + 1
    const top = CARD_ROWS + 2
    const activeWorker = delegatedNow ? shown.findIndex(one => one.steps.includes(now?.step ?? -1)) : -1
    put(grid, CARD_ROWS - 1, hubX, '┬', mainTone)
    const lo = Math.min(hubX, ...centers)
    const hi = Math.max(hubX, ...centers)
    for (let x = lo; x <= hi; x += 1) {
      put(grid, split, x, junction(x === hubX, centers.includes(x), x > lo, x < hi), 'edge')
    }
    shown.forEach((worker, k) => {
      const cx = centers[k]
      put(grid, drop, cx, '│', 'edge')
      const path: Array<[number, number]> = [[CARD_ROWS - 1, hubX]]
      const dir = cx >= hubX ? 1 : -1
      for (let x = hubX; x !== cx + dir; x += dir) path.push([split, x])
      path.push([drop, cx])
      paths.push(path)

      const isActive = k === activeWorker
      const total = worker.steps.length
      const done = frame === undefined ? 0 : worker.steps.filter(i => frame.done.includes(i)).length
      const allDone = frame !== undefined && done === total
      const tone: FlowTone = isActive ? 'live' : allDone ? 'doneEdge' : 'edge'
      const left = x0 + k * (bw + BOX_GAP)
      box(grid, top, left, bw, BOX_ROWS, tone, { text: '', tone: 'edge' })
      put(grid, top, cx, '┴', isActive ? 'live' : 'edge')
      put(grid, top, cx + 2, ` ${fit(worker.label, bw - 7)} `, 'actor', worker.actor)
      const inner = bw - 4
      if (isActive && frame !== undefined && current !== undefined) {
        put(grid, top + 1, left + 2, fit(`${spinOf(frame)} ${current.title.trim()}`, inner), 'title')
      } else {
        const last = worker.steps.filter(i => frame?.done.includes(i)).at(-1)
        const shownStep = steps[last ?? worker.steps[0]]
        put(grid, top + 1, left + 2, fit(shownStep.title.trim(), inner), 'detail')
      }
      put(
        grid,
        top + 2,
        left + 2,
        fit(frame === undefined ? `手順 ${total}` : `${allDone ? '✓ ' : ''}${done}/${total} 手順`, inner),
        allDone ? 'ok' : 'note',
      )
      if (isActive) path.forEach(([r, x]) => retone(grid, r, x, 'live'))
    })
    if (activeWorker !== -1 && frame !== undefined && (now?.beat.kind === 'dispatch' || now?.beat.kind === 'return')) {
      flowParticle(grid, paths[activeWorker], frame.progress, now.beat.kind === 'return')
    }
  }
  if (humanActive && frame !== undefined && (now?.beat.kind === 'dispatch' || now?.beat.kind === 'return')) {
    flowParticle(grid, humanPath, frame.progress, now.beat.kind === 'return')
  }

  // マス目を行にする。キャラを描くなら、カードの中身の行を帯にして、キャラの場所を空ける
  const rowLine = (r: number): FlowLine => ({ key: `grid:${r}`, segs: trimmed(segsOf(grid, r)) })
  let before: FlowLine[]
  let band: StageBand | undefined
  const after: FlowLine[] = []
  if (opts.avatars) {
    before = [rowLine(0)]
    const rows = Array.from({ length: AVATAR_ROWS }, (_, k) => 1 + k)
    band = {
      key: 'band',
      cols: [
        { kind: 'text', key: 'band:a', rows: rows.map(r => segsOf(grid, r, 0, 2)) },
        { kind: 'raster', who: 'main' },
        { kind: 'text', key: 'band:b', rows: rows.map(r => segsOf(grid, r, 2 + AVATAR_COLUMNS, hx + 2)) },
        { kind: 'raster', who: 'human' },
        { kind: 'text', key: 'band:c', rows: rows.map(r => trimmed(segsOf(grid, r, hx + 2 + AVATAR_COLUMNS))) },
      ],
    }
    for (let r = 1 + AVATAR_ROWS; r < gridRows; r += 1) after.push(rowLine(r))
  } else {
    before = Array.from({ length: gridRows }, (_, r) => rowLine(r))
  }
  if (workers.length > shown.length) after.push({ key: 'workers:more', segs: [{ text: `ほか ${workers.length - shown.length} 体を省いた`, tone: 'note' }] })

  // 成果物(見出しと1行)。入りきらなければ新しいものを残し、古いものは「ほか n」にまとめる
  const outputItems =
    frame === undefined
      ? [
          ...new Set([
            ...steps.flatMap(one => one.outputs ?? []),
            ...flow.outputs.map(one => (one.where === undefined ? one.name : `${one.name} — ${one.where}`)),
          ]),
        ].map(text => ({ text, isNew: false }))
      : frame.outputs.map(one => ({ text: one.text, isNew: frame.elapsed - one.at < FLASH_MS }))
  const outputLines: FlowLine[] = []
  if (outputItems.length > 0 || frame !== undefined) {
    const segs: FlowSeg[] = [{ text: '成果物 ', tone: 'head' }]
    if (outputItems.length === 0) segs.push({ text: 'まだありません', tone: 'note' })
    let used = cellWidth('成果物 ')
    const kept: typeof outputItems = []
    for (const item of [...outputItems].reverse()) {
      const w = cellWidth(`▸ ${item.text}  `)
      if (used + w > width - 8 && kept.length > 0) break
      kept.unshift(item)
      used += w
    }
    if (kept.length < outputItems.length) segs.push({ text: `ほか ${outputItems.length - kept.length}  `, tone: 'note' })
    for (const item of kept) segs.push({ text: fit(`▸ ${item.text}`, Math.max(4, width - 10)), tone: item.isNew ? 'outputNew' : 'output' }, { text: '  ', tone: 'note' })
    outputLines.push({ key: 'outputs', segs: trimmed(segs) })
  }

  // 手順の一覧。残りの行に収める
  const used = before.length + (band === undefined ? 0 : AVATAR_ROWS) + after.length + outputLines.length + 2
  const room = Math.max(3, height - used)
  const listWidth = Math.min(width, STAGE_MAX)
  let from = 0
  let to = steps.length
  if (steps.length > room) {
    const visible = room - 2
    const focus = now?.step ?? (frame?.isFinished === true ? steps.length - 1 : 0)
    from = Math.max(0, Math.min(steps.length - visible, focus - Math.floor(visible / 2)))
    to = from + visible
  }
  after.push({ key: 'list:gap', segs: [] })
  after.push({ key: 'list:head', segs: [{ text: '手順', tone: 'head' }] })
  if (from > 0) after.push({ key: 'list:before', segs: [{ text: `  … 前に ${from} 手順`, tone: 'note' }] })
  for (let i = from; i < to; i += 1) after.push(stepLine(flow, i, listWidth, frame))
  if (to < steps.length) after.push({ key: 'list:after', segs: [{ text: `  … 後に ${steps.length - to} 手順`, tone: 'note' }] })
  after.push(...outputLines)
  return { before, ...(band === undefined ? {} : { band }), after }
}
