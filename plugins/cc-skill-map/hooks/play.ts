import type { FlowActor, SkillFlow } from '../types'

/** 再生中の描き直しの間隔(ms)。粒が滑らかに見える速さ */
export const TICK_MS = 150
/** 粒が次の手順へ線を渡る時間(ms) */
export const TRAVEL_MS = 700
/** 手順を進めている時間(ms) */
export const WORK_MS = 900
/** サブエージェントへ依頼の粒が渡る時間・結果の粒が戻る時間(ms) */
export const DISPATCH_MS = 600
/** 承認を待つ手順で止まる時間(ms) */
export const WAIT_MS = 1800
/** 成果物が出てから光っている時間(ms) */
export const FLASH_MS = 900

/**
 * 再生の1区切り。
 * travel: 粒が手順から手順へ渡る(down は並びの次へ線を下りる、jump は分岐・戻りで飛ぶ)、
 * work: 手順を進める、dispatch: サブエージェントへ依頼の粒が渡る、return: 結果の粒が戻る、wait: 人の承認を待つ
 */
export type Beat =
  | { kind: 'travel'; from: number; to: number; via: 'down' | 'jump'; ms: number }
  | { kind: 'work' | 'dispatch' | 'return' | 'wait'; step: number; ms: number }

/**
 * 実行される順に手順をたどる。
 * next が無ければ並びの次へ、空なら終わり。戻り(前の手順へ)はそれぞれ1回だけたどり、2回目からは先へ進む
 */
export const visitOrder = (flow: SkillFlow): number[] => {
  const steps = flow.steps
  const order: number[] = []
  const taken = new Set<string>()
  let i = 0
  // 戻りを1回ずつに限っても、念のため長さで止める
  while (i >= 0 && i < steps.length && order.length < steps.length * 3) {
    order.push(i)
    const next = steps[i].next
    if (next === undefined) {
      i += 1
      continue
    }
    const targets = next.map(id => steps.findIndex(one => one.id === id)).filter(at => at !== -1)
    if (targets.length === 0) break
    const back = targets.find(at => at <= i && !taken.has(`${i}>${at}`))
    if (back !== undefined) {
      taken.add(`${i}>${back}`)
      i = back
      continue
    }
    const forward = targets.filter(at => at > i)
    if (forward.length === 0) break
    // 並びの次があればそちらを、無ければいちばん近い飛び先を選ぶ
    i = forward.includes(i + 1) ? i + 1 : Math.min(...forward)
  }
  return order
}

/**
 * 再生の時間割。delegated に入れた担い手の手順は、メインから依頼の粒が渡り、作業のあと結果の粒が戻る。
 * それ以外の手順はメインがその場で進める
 */
export const timeline = (flow: SkillFlow, delegated: readonly FlowActor[] = ['subagent']): Beat[] => {
  const beats: Beat[] = []
  const order = visitOrder(flow)
  order.forEach((step, k) => {
    if (k > 0) {
      const from = order[k - 1]
      beats.push({ kind: 'travel', from, to: step, via: step === from + 1 ? 'down' : 'jump', ms: TRAVEL_MS })
    }
    const one = flow.steps[step]
    if (delegated.includes(one.actor)) {
      beats.push({ kind: 'dispatch', step, ms: DISPATCH_MS })
      beats.push({ kind: one.gate === true ? 'wait' : 'work', step, ms: one.gate === true ? WAIT_MS : WORK_MS })
      beats.push({ kind: 'return', step, ms: DISPATCH_MS })
    } else if (one.gate === true) {
      beats.push({ kind: 'wait', step, ms: WAIT_MS })
    } else {
      beats.push({ kind: 'work', step, ms: WORK_MS })
    }
  })
  return beats
}

/** 再生の長さ(ms) */
export const playLength = (beats: readonly Beat[]): number => beats.reduce((sum, beat) => sum + beat.ms, 0)

/** 再生の1コマ */
export type PlayFrame = {
  /** 始めてからの時間(ms)。承認の点滅などに使う */
  elapsed: number
  /** 今の区切りと、その中の進み具合(0〜1)。終えていれば無い */
  beat?: Beat
  progress: number
  /** 今進めている手順。粒が渡っているあいだは、行き先の手順 */
  current?: number
  /** 終えた手順 */
  done: number[]
  /** 出てきた成果物(出た順)。at は出た時刻(始めてからの ms) */
  outputs: Array<{ text: string; at: number }>
  /** 最後に結果の粒がメインに届いた時刻(始めてからの ms)。まだ無ければ無い */
  returnedAt?: number
  /** 最後まで再生したら true */
  isFinished: boolean
}

/** 始めてから elapsed ms の1コマ */
export const frameAt = (flow: SkillFlow, beats: readonly Beat[], elapsed: number): PlayFrame => {
  const done = new Set<number>()
  const outputs: Array<{ text: string; at: number }> = []
  const reveal = (step: number, at: number) => {
    done.add(step)
    for (const text of flow.steps[step].outputs ?? []) {
      if (!outputs.some(one => one.text === text)) outputs.push({ text, at })
    }
  }
  let t = 0
  let returnedAt: number | undefined
  const back = () => (returnedAt === undefined ? {} : { returnedAt })
  for (const [i, beat] of beats.entries()) {
    if (elapsed < t + beat.ms) {
      const progress = Math.max(0, Math.min(1, (elapsed - t) / beat.ms))
      const current = beat.kind === 'travel' ? beat.to : beat.step
      // 戻ってきてもう一度進める手順は、終えた印を外す
      done.delete(current)
      return { elapsed, beat, progress, current, done: [...done], outputs, ...back(), isFinished: false }
    }
    t += beat.ms
    if (beat.kind === 'return') returnedAt = t
    // 手順を終えるのは、その手順の最後の区切りが済んだとき
    if (beat.kind === 'work' || beat.kind === 'wait' || beat.kind === 'return') {
      if (i === beats.length - 1 || beats[i + 1].kind === 'travel') reveal(beat.step, t)
    }
  }
  for (const output of flow.outputs) {
    const text = output.where === undefined ? output.name : `${output.name} — ${output.where}`
    if (!outputs.some(one => one.text === text || one.text === output.name)) outputs.push({ text, at: t })
  }
  return { elapsed, progress: 1, done: [...done], outputs, ...back(), isFinished: true }
}
