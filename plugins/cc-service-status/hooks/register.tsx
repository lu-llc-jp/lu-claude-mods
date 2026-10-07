import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  EMPTY,
  PAGE_URL,
  SUMMARY_URL,
  componentLabel,
  componentLevel,
  eventLabel,
  formatIso,
  formatTime,
  indicatorLabel,
  parseSummary,
  statusLine,
} from './summary'

const PANE = 'cc-service-status'
const COMMAND = 'cc-service-status'
const INTERVAL_MS = 5 * 60 * 1000

// セッションの値は $.state に置く(ホットリロードでモジュール変数は消えるため)
const snapshot = atom({ plugin: 'cc-service-status', key: 'snapshot' } as const, EMPTY)

/** status.claude.com を取得して状態とステータスラインを更新する */
const refresh = async ($: EngineInterface): Promise<void> => {
  const now = await $.clock.now()
  let next: (prev: typeof EMPTY) => typeof EMPTY
  try {
    const res = await $.http.fetch(SUMMARY_URL, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const fresh = parseSummary(res.text, now)
    next = () => fresh
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // 失敗しても前回の値は残す
    next = prev => ({ ...prev, error: reason })
  }
  const written = await update($, snapshot, next)
  $.ui.status(statusLine(written))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Claude のサービス稼働状況をペインで開き、最新に更新する',
    })
    $.ui.status(statusLine(EMPTY))
    // セッション開始を待たせないよう、取得は後ろで行う
    $.clock.after(0, () => void refresh($))
    $.clock.every(INTERVAL_MS, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await $.ui.open({ id: PANE, title: 'Claude status' })
    await refresh($)

    return { text: statusLine(await read($, snapshot)) }
  }).catch(() => ({ text: 'Claude: 状態を確認できませんでした' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link } = $.ui.resolve(e)
    const s = await read($, snapshot)
    const width = Math.max(10, e.props.bodyColumns)
    const color = (status: string) => {
      const level = componentLevel(status)
      return level === 'ok' ? 'success' : level === 'bad' ? 'error' : 'warning'
    }

    if (s.fetchedAt === undefined) {
      return (
        <Box flexDirection="column" width={width}>
          <Text dimColor>{s.error === undefined ? '取得中…' : `取得できません: ${s.error}`}</Text>
          <Link href={PAGE_URL} label={PAGE_URL} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={width}>
        <Text bold color={s.indicator === 'none' ? 'success' : 'warning'} wrap="truncate">
          {indicatorLabel(s.indicator)}
          {s.description === '' ? '' : ` (${s.description})`}
        </Text>
        <Text dimColor wrap="truncate">
          {formatTime(s.fetchedAt)} 時点{s.error === undefined ? '' : ` / 更新失敗: ${s.error}`}
        </Text>

        <Box flexDirection="column" marginTop={1}>
          {s.components.map(c => (
            <Text key={`c:${c.name}`} wrap="truncate">
              <Text color={color(c.status)}>●</Text> {c.name}{' '}
              <Text dimColor={c.status === 'operational'}>{componentLabel(c.status)}</Text>
            </Text>
          ))}
        </Box>

        {s.incidents.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>進行中の障害</Text>
            {s.incidents.map(i => (
              <Box key={`i:${i.url}:${i.name}`} flexDirection="column">
                <Text color="error" wrap="wrap">{i.name}</Text>
                <Text dimColor wrap="truncate">
                  {eventLabel(i.status)} / {formatIso(i.updatedAt)} 更新
                </Text>
                <Link href={i.url} label={i.url} />
              </Box>
            ))}
          </Box>
        )}

        {s.maintenances.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>メンテナンス</Text>
            {s.maintenances.map(m => (
              <Box key={`m:${m.url}:${m.name}`} flexDirection="column">
                <Text wrap="wrap">{m.name}</Text>
                <Text dimColor wrap="truncate">
                  {eventLabel(m.status)} / {formatIso(m.updatedAt)}
                </Text>
                <Link href={m.url} label={m.url} />
              </Box>
            ))}
          </Box>
        )}

        <Box marginTop={1}>
          <Link href={PAGE_URL} label={PAGE_URL} />
        </Box>
      </Box>
    )
  })
}
