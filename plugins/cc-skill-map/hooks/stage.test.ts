import { expect, test } from 'claude-code/testing'

import type { SkillFlow } from '../types'
import { AVATAR_COLUMNS, AVATAR_ROWS, humanAvatar, mainAvatar } from './avatar'
import { cellWidth, type FlowLine, type FlowSeg } from './layout'
import { DISPATCH_MS, WAIT_MS, frameAt, playLength, timeline, type Beat } from './play'
import { STAGE_DELEGATED, layoutStage, stageMoods, workersOf } from './stage'

const FLOW: SkillFlow = {
  by: 'model',
  steps: [
    { id: 's1', title: 'メモを受け取る', actor: 'human' },
    { id: 's2', title: '整える', actor: 'ai', detail: '見出しを付ける', outputs: ['下書き'] },
    { id: 's3', title: '確かめる', actor: 'human', gate: true, next: ['s2', 's4'] },
    { id: 's4', title: '調べる', actor: 'subagent', agent: 'researcher' },
    { id: 's5', title: '保存する', actor: 'script', outputs: ['notes/a.md'] },
  ],
  outputs: [{ name: '整えたメモ', where: 'notes/' }],
}

const textOf = (segs: readonly FlowSeg[]) => segs.map(seg => seg.text).join('')
const show = (lines: readonly FlowLine[]) => lines.map(line => textOf(line.segs))
const beats = timeline(FLOW, STAGE_DELEGATED)
/** 区切りの始まりの時刻 */
const startOf = (match: (beat: Beat) => boolean) => beats.slice(0, beats.findIndex(match)).reduce((sum, beat) => sum + beat.ms, 0)
const textStage = (elapsed: number | undefined, width = 80, height = 30) =>
  layoutStage(FLOW, width, height, elapsed === undefined ? undefined : frameAt(FLOW, beats, elapsed), { avatars: false })

test('担い手は、スクリプトを1つの箱に、サブエージェントを名前ごとの箱にまとめる', () => {
  const flow: SkillFlow = {
    by: 'model',
    steps: [
      { id: 'a', title: 'a', actor: 'script' },
      { id: 'b', title: 'b', actor: 'subagent', agent: 'x' },
      { id: 'c', title: 'c', actor: 'script' },
      { id: 'd', title: 'd', actor: 'ai' },
    ],
    outputs: [],
  }
  expect(workersOf(flow).map(one => [one.label, one.steps])).toEqual([
    ['スクリプト', [0, 2]],
    ['x', [1]],
  ])
})

test('組織図: 上にメインと人のカード、メインの下にスクリプトとサブエージェントの箱、その下に手順と成果物', () => {
  const { before, band, after } = textStage(undefined)
  expect(band).toBeUndefined()
  expect([...show(before), ...show(after)]).toEqual([
    '╭─ ◉ メイン ───────────────────────────╮        ╭─ ◉ 人 ───────────────────────╮',
    '│ 手順 5                               │        │ 人の手順 2                   │',
    '│ 自分で 1 · 依頼 4                    │        │ · 1 メモを受け取る           │',
    '│ 承認 1 か所                          ├────────┤ · 3 確かめる                 │',
    '│                                      │        │                              │',
    '╰───────────────────┬──────────────────╯        ╰──────────────────────────────╯',
    '  ╭─────────────────┴─────────╮',
    '  │                           │',
    '╭─┴─ researcher ─────────╮  ╭─┴─ スクリプト ─────────╮',
    '│ 調べる                 │  │ 保存する               │',
    '│ 手順 1                 │  │ 手順 1                 │',
    '╰────────────────────────╯  ╰────────────────────────╯',
    '',
    '手順',
    '  1 メモを受け取る 人',
    '  2 整える AI',
    '  3 確かめる 人 ⏸ ↩2',
    '  4 調べる サブエージェント researcher',
    '  5 保存する スクリプト',
    '',
    '成果物 3',
    '▸ 下書き',
    '▸ notes/a.md',
    '▸ 整えたメモ — notes/',
  ])
})

test('再生: メインが自分で進める手順では、メインのカードを光らせて、していることを出す', () => {
  const t = startOf(beat => beat.kind === 'work' && beat.step === 1)
  const lines = show(textStage(t + 100).before)
  expect(lines[1]).toMatch(/│ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 手順 2\/5 +│/)
  expect(lines[2]).toMatch(/│ 整える +│/)
  expect(textStage(t + 100).before[0].segs[0].tone).toBe('live')
  expect(stageMoods(FLOW, frameAt(FLOW, beats, t + 100)).main).toBe('busy')
})

test('再生: 人への依頼は、メインと人をつなぐ線を粒が渡り、承認の所では人のカードが点滅して待つ', () => {
  const dispatch = startOf(beat => beat.kind === 'dispatch' && beat.step === 2)
  const going = show(textStage(dispatch + DISPATCH_MS / 2).before)
  expect(going[3]).toMatch(/├─*●─*┤/)
  expect(going[2]).toMatch(/│ 人 の承認を待つ|│ 人 に依頼/)
  const wait = startOf(beat => beat.kind === 'wait' && beat.step === 2)
  const waiting = show(textStage(wait + 100).before)
  // 人のカードには、人の手順を並べ、終えたものに ✓、今のものに回る印を付ける
  expect(waiting[1]).toMatch(/│ ⏸ 承認待ち +│$/)
  expect(waiting[2]).toMatch(/│ ✓ 1 メモを受け取る +│$/)
  expect(waiting[3]).toMatch(/┤ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 3 確かめる +│$/)
  expect(stageMoods(FLOW, frameAt(FLOW, beats, wait + 100)).human).toBe('busy')
  // 結果の粒が人からメインへ戻る
  const back = show(textStage(wait + WAIT_MS + DISPATCH_MS / 2).before)
  expect(back[3]).toMatch(/├─*◆─*┤/)
})

test('再生: サブエージェントへの依頼は、メインから組織図の線を粒が下りて箱に届き、結果の粒が上る', () => {
  const dispatch = startOf(beat => beat.kind === 'dispatch' && beat.step === 3)
  const early = show(textStage(dispatch + 10).before)
  // 最初はメインの下の ┬ のマスにいて、横の線を通り、箱の上へ下りる
  expect(early[5]).toMatch(/^╰─+●─+╯/)
  const mid = show(textStage(dispatch + DISPATCH_MS / 2).before)
  expect(mid[6]).toMatch(/^ *╭─*●─*┴/)
  const late = show(textStage(dispatch + DISPATCH_MS - 10).before)
  expect(late[7]).toMatch(/^ *●/)
  const work = startOf(beat => beat.kind === 'work' && beat.step === 3)
  const working = show(textStage(work + 100).before)
  expect(working[9]).toMatch(/│ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 調べる +│/)
  expect(working[2]).toMatch(/│ researcher の作業を待つ +│/)
  const back = show(textStage(work + 900 + DISPATCH_MS - 10).before)
  expect(back[5]).toMatch(/◆/)
  // 結果が届いた直後はメインのキャラが喜ぶ
  expect(stageMoods(FLOW, frameAt(FLOW, beats, work + 900 + DISPATCH_MS + 100)).main).toBe('cheer')
})

test('再生: 手順の一覧に今と終えた手順の印を付け、戻りをたどるときは戻りを光らせる', () => {
  const travelBack = startOf(beat => beat.kind === 'travel' && beat.via === 'jump')
  const { after } = textStage(travelBack + 100)
  const list = show(after)
  expect(list).toContain('✓ 1 メモを受け取る 人')
  const line = after.find(one => textOf(one.segs).includes('確かめる'))
  expect(line === undefined ? '' : textOf(line.segs)).toBe('✓ 3 確かめる 人 ⏸ ↩ 2 へ')
  expect(line?.segs.at(-1)?.tone).toBe('branchLive')
})

test('最後まで再生したら、メインは終えた数を、担い手の箱は ✓ を出す', () => {
  const { before } = textStage(playLength(beats) + 1)
  const lines = show(before)
  expect(lines[1]).toMatch(/│ ✓ 全 5 手順を終えた +│ +│ ✓ 2\/2 手順 +│/)
  expect(lines[10]).toMatch(/│ ✓ 1\/1 手順 +│ +│ ✓ 1\/1 手順 +│/)
})

test('戻り先しか書かれていない手順も、戻ったあと最後まで再生し、終えた数をそのまま出す', () => {
  // モデルは「8 は 7 へ戻ることがある」を next: ['s7'] とだけ書くことがある
  const flow: SkillFlow = {
    by: 'model',
    steps: [
      { id: 's1', title: '作る', actor: 'ai' },
      { id: 's2', title: '確かめる', actor: 'human', gate: true },
      { id: 's3', title: '直す', actor: 'ai', next: ['s2'] },
      { id: 's4', title: '書き出す', actor: 'script' },
    ],
    outputs: [],
  }
  const all = timeline(flow, STAGE_DELEGATED)
  const end = frameAt(flow, all, playLength(all) + 1)
  expect(end.done).toEqual([0, 1, 2, 3])
  expect(show(layoutStage(flow, 80, 30, end, { avatars: false }).before)[1]).toMatch(/│ ✓ 全 4 手順を終えた/)
  // 途中で終わる流れ(終わりを明示した手順がある)なら、終えた数で出す
  const stop: SkillFlow = { ...flow, steps: flow.steps.map((one, i) => (i === 1 ? { ...one, next: [] } : one)) }
  const stopBeats = timeline(stop, STAGE_DELEGATED)
  const stopped = frameAt(stop, stopBeats, playLength(stopBeats) + 1)
  expect(show(layoutStage(stop, 80, 30, stopped, { avatars: false }).before)[1]).toMatch(/│ ✓ 終了\(2\/4 手順\)/)
})

test('成果物は1件1行で並べ、入りきらなければ新しいものを残して「ほか n 件」にまとめる', () => {
  const flow: SkillFlow = {
    by: 'model',
    steps: Array.from({ length: 6 }, (_, i) => ({ id: `s${i + 1}`, title: `手順${i + 1}`, actor: 'ai' as const, outputs: [`out${i + 1}`] })),
    outputs: [],
  }
  const all = timeline(flow, STAGE_DELEGATED)
  const end = frameAt(flow, all, playLength(all) + 1)
  // 高さ 20: カード 6 行 + 一覧 8 行 = 14 行、残り 6 行に成果物(空行・見出し・4 件)
  const lines = show(layoutStage(flow, 80, 20, end, { avatars: false }).after)
  expect(lines.slice(-6)).toEqual(['', '成果物 6', 'ほか 3 件', '▸ out4', '▸ out5', '▸ out6'])
  // 行が足りなければ、件数と最新の1件だけを1行で出す
  const tight = show(layoutStage(flow, 80, 8, end, { avatars: false }).after)
  expect(tight.at(-1)).toBe('成果物 6 ▸ out6')
})

test('手順の一覧では、今の手順だけを太くし、終えた手順は薄く、まだの手順は普通に出す', () => {
  const t = startOf(beat => beat.kind === 'work' && beat.step === 1)
  const { after } = textStage(t + 100)
  const toneOf = (title: string) => after.find(one => textOf(one.segs).includes(title))?.segs.find(seg => seg.text.includes(title))?.tone
  expect(toneOf('メモを受け取る')).toBe('detail')
  expect(toneOf('整える')).toBe('title')
  expect(toneOf('保存する')).toBe('plain')
})

test('手順が多くて入りきらなければ、今の手順のまわりだけを出し、高さに収める', () => {
  const many: SkillFlow = {
    by: 'model',
    steps: Array.from({ length: 30 }, (_, i) => ({ id: `s${i + 1}`, title: `手順${i + 1}`, actor: 'ai' as const })),
    outputs: [],
  }
  const all = timeline(many, STAGE_DELEGATED)
  const at15 = all.slice(0, all.findIndex(beat => beat.kind === 'work' && beat.step === 14)).reduce((sum, beat) => sum + beat.ms, 0)
  const stage = layoutStage(many, 80, 20, frameAt(many, all, at15 + 100), { avatars: false })
  const lines = show([...stage.before, ...stage.after])
  expect(lines.length).toBeLessThanOrEqual(20)
  expect(lines.some(line => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 15 手順15/.test(line))).toBe(true)
  expect(lines.some(line => /^ {2}… 前に \d+ 手順$/.test(line))).toBe(true)
  expect(lines.some(line => /^ {2}… 後に \d+ 手順$/.test(line))).toBe(true)
})

test('キャラを描く面では、カードの中身の行を帯にして、メインと人のキャラの場所を空ける', () => {
  const { before, band, after } = layoutStage(FLOW, 80, 30, frameAt(FLOW, beats, 300), { avatars: true })
  expect(before).toHaveLength(1)
  expect(band?.cols.map(col => (col.kind === 'raster' ? col.who : 'text'))).toEqual(['text', 'main', 'text', 'human', 'text'])
  // 帯の各行は、キャラの幅を足すと上の枠と同じ幅になる
  const top = cellWidth(textOf(before[0].segs))
  for (let r = 0; r < AVATAR_ROWS; r += 1) {
    const texts = (band?.cols ?? []).map(col => (col.kind === 'raster' ? AVATAR_COLUMNS : cellWidth(textOf(col.rows[r]))))
    expect(texts.reduce((sum, w) => sum + w, 0)).toBe(top)
  }
  expect(show(after)[0]).toMatch(/^╰─+┬─+╯ +╰─+╯$/)
})

test('どの幅・どの時刻でも、行は幅に収まる', () => {
  for (const width of [66, 80, 120, 200]) {
    for (const elapsed of [undefined, 0, 2500, 6000, 99_999]) {
      const stage = textStage(elapsed, width)
      for (const line of [...stage.before, ...stage.after]) expect(cellWidth(textOf(line.segs))).toBeLessThanOrEqual(width)
    }
  }
})

test('キャラの絵は 9 列 4 行で、様子によって変わる', () => {
  const idle = mainAvatar('idle', 1000)
  expect([idle.columns, idle.rows]).toEqual([AVATAR_COLUMNS, AVATAR_ROWS])
  expect(mainAvatar('cheer', 1000).cells).not.toBe(idle.cells)
  // 人は出番のあいだ承認印を掲げ下ろしする
  expect(humanAvatar('busy', 300).cells).not.toBe(humanAvatar('busy', 0).cells)
})
