import type {
  ClaudeStatusComponent,
  ClaudeStatusEvent,
  ClaudeStatusSnapshot,
} from '../types'

export const SUMMARY_URL = 'https://status.claude.com/api/v2/summary.json'
export const PAGE_URL = 'https://status.claude.com'

export const EMPTY: ClaudeStatusSnapshot = {
  indicator: 'unknown',
  description: '',
  components: [],
  incidents: [],
  maintenances: [],
}

const INDICATOR_LABELS: Record<string, string> = {
  none: '正常',
  minor: '一部障害',
  major: '障害',
  critical: '重大な障害',
  maintenance: 'メンテナンス中',
}

const COMPONENT_LABELS: Record<string, string> = {
  operational: '正常',
  degraded_performance: '性能低下',
  partial_outage: '一部停止',
  major_outage: '停止',
  under_maintenance: 'メンテナンス中',
}

const EVENT_LABELS: Record<string, string> = {
  investigating: '調査中',
  identified: '原因特定',
  monitoring: '経過観察',
  resolved: '解決',
  postmortem: '事後分析',
  scheduled: '予定',
  in_progress: '実施中',
  verifying: '確認中',
  completed: '完了',
}

export const indicatorLabel = (indicator: string): string =>
  INDICATOR_LABELS[indicator] ?? '不明'

export const componentLabel = (status: string): string =>
  COMPONENT_LABELS[status] ?? status

export const eventLabel = (status: string): string =>
  EVENT_LABELS[status] ?? status

/** 正常 / 注意 / 異常 の3段階。色分けに使う */
export const componentLevel = (status: string): 'ok' | 'warn' | 'bad' =>
  status === 'operational'
    ? 'ok'
    : status === 'partial_outage' || status === 'major_outage'
      ? 'bad'
      : 'warn'

/** "Claude Console (platform.claude.com)" → "Claude Console" */
export const shortName = (name: string): string =>
  name.replace(/\s*\(.*\)\s*$/, '')

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const toEvent = (value: unknown): ClaudeStatusEvent => {
  const one = record(value)
  return {
    name: text(one.name),
    status: text(one.status),
    impact: text(one.impact),
    updatedAt: text(one.updated_at),
    url: text(one.shortlink) || PAGE_URL,
  }
}

/** summary.json の本文を表示用の値にする。形が崩れていても投げない */
export const parseSummary = (body: string, fetchedAt: number): ClaudeStatusSnapshot => {
  const json = record(JSON.parse(body))
  const status = record(json.status)
  const components: ClaudeStatusComponent[] = list(json.components)
    .map(record)
    .filter(one => one.group !== true)
    .map(one => ({ name: text(one.name), status: text(one.status) }))
    .filter(one => one.name !== '')

  return {
    indicator: text(status.indicator) || 'unknown',
    description: text(status.description),
    components,
    incidents: list(json.incidents).map(toEvent),
    maintenances: list(json.scheduled_maintenances).map(toEvent),
    fetchedAt,
  }
}

/** ステータスラインの1行 */
export const statusLine = (snapshot: ClaudeStatusSnapshot): string => {
  if (snapshot.fetchedAt === undefined) {
    return snapshot.error === undefined ? 'Claude: 確認中…' : 'Claude: 状態を取得できません'
  }

  const troubled = snapshot.components
    .filter(one => one.status !== 'operational')
    .map(one => shortName(one.name))
  const names =
    troubled.length === 0
      ? ''
      : ` — ${troubled.slice(0, 2).join(', ')}${troubled.length > 2 ? ` ほか${troubled.length - 2}件` : ''}`
  const stale = snapshot.error === undefined ? '' : '(更新失敗)'

  return `Claude: ${indicatorLabel(snapshot.indicator)}${names}${stale}`
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** ms → "10/08 14:05"(実行環境のローカル時刻) */
export const formatTime = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const formatIso = (iso: string): string => {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? iso : formatTime(ms)
}
