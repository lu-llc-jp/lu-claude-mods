export type ClaudeStatusComponent = { name: string; status: string }

export type ClaudeStatusEvent = {
  name: string
  status: string
  impact: string
  updatedAt: string
  url: string
}

export type ClaudeStatusSnapshot = {
  /** status.indicator: none / minor / major / critical / maintenance */
  indicator: string
  description: string
  components: ClaudeStatusComponent[]
  incidents: ClaudeStatusEvent[]
  maintenances: ClaudeStatusEvent[]
  /** 最後に取得に成功した時刻(ms)。一度も成功していなければ無い */
  fetchedAt?: number
  /** 直近の取得が失敗したときの理由。成功すると消える */
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'cc-service-status': { snapshot: ClaudeStatusSnapshot }
  }
}
