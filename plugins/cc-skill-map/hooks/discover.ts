import type { SkillInfo } from '../types'

/** 探すのに使うファイル操作。register では $.fs を、テストではメモリ上のファイルを渡す */
export type FsLike = {
  read: (path: string) => Promise<string>
  list: (path: string) => Promise<ReadonlyArray<{ name: string; kind: 'file' | 'dir' | 'other' }>>
  exists: (path: string) => Promise<boolean>
}

/** コンテキストの内訳が並べるスキル1つ($.session.usage の breakdown.skills.skillFrontmatter) */
export type ListedSkill = { name: string; source: string; pluginName?: string }

/** frontmatter の値。`key: value` は文字列、`key:` に続く `- a` や `[a, b]` は配列 */
export type Frontmatter = Record<string, string | string[]>

const unquote = (value: string): string => value.trim().replace(/^(['"])(.*)\1$/, '$2')

/**
 * Markdown の先頭の frontmatter を読む。スキルとエージェントの定義で使う範囲(文字列・配列・折り返しの `>` と `|`)だけを扱い、
 * それ以外の YAML は文字列のまま返す
 */
export const parseFrontmatter = (text: string): { fields: Frontmatter; body: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (match === null) return { fields: {}, body: text }
  const fields: Frontmatter = {}
  const lines = match[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i])
    if (head === null) continue
    const [, key, rest] = head
    const inline = /^\[(.*)\]$/.exec(rest.trim())
    if (inline !== null) {
      fields[key] = inline[1].split(',').map(unquote).filter(one => one !== '')
      continue
    }
    if (rest.trim() !== '' && !/^[>|][-+]?$/.test(rest.trim())) {
      fields[key] = unquote(rest)
      continue
    }
    // 続く字下げの行を集める。`- a` なら配列、それ以外(`>` や `|` の続き)は1つの文字列にする
    const block: string[] = []
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
      i += 1
      if (lines[i].trim() !== '') block.push(lines[i].trim())
    }
    fields[key] = block.length > 0 && block.every(one => one.startsWith('- '))
      ? block.map(one => unquote(one.slice(2)))
      : block.join(rest.trim().startsWith('|') ? '\n' : ' ')
  }
  return { fields, body: text.slice(match[0].length) }
}

const asList = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : value.split(',').map(one => one.trim()).filter(one => one !== '')

/** プラグインのスキル名(`<プラグイン>:<スキル>`)の、スキルの部分 */
export const baseName = (name: string): string => name.slice(name.lastIndexOf(':') + 1)

/** root から上のディレクトリ。ホームとそれより上は含めない(ホームの .claude はユーザーの設定で、プロジェクトではないため) */
export const projectDirs = (root: string, home: string): string[] => {
  const dirs: string[] = []
  let dir = root.replace(/\/+$/, '')
  const stop = home.replace(/\/+$/, '')
  // ホームの外で起動したときは、ルートの1つ下まで上る
  while (dir !== '' && dir !== stop) {
    dirs.push(dir)
    const cut = dir.lastIndexOf('/')
    if (cut <= 0) break
    dir = dir.slice(0, cut)
  }
  return dirs
}

const tryList = async (fs: FsLike, path: string) => {
  try {
    return await fs.list(path)
  } catch {
    return []
  }
}

const tryRead = async (fs: FsLike, path: string): Promise<string | undefined> => {
  try {
    return await fs.read(path)
  } catch {
    return undefined
  }
}

/** ディレクトリの中のディレクトリ。シンボリックリンクは other になるので、それも候補に含める */
const subdirs = async (fs: FsLike, path: string): Promise<string[]> =>
  (await tryList(fs, path)).filter(one => one.kind !== 'file' && !one.name.startsWith('.')).map(one => one.name)

/** エージェントの名前 → 持たせているスキル。設定フォルダとプロジェクトの agents/*.md を読む */
export const readAgentSkills = async (fs: FsLike, dirs: readonly string[]): Promise<Map<string, string[]>> => {
  const found = new Map<string, string[]>()
  for (const dir of dirs) {
    for (const entry of await tryList(fs, dir)) {
      if (entry.kind === 'dir' || !entry.name.endsWith('.md')) continue
      const text = await tryRead(fs, `${dir}/${entry.name}`)
      if (text === undefined) continue
      const { fields } = parseFrontmatter(text)
      const name = typeof fields.name === 'string' && fields.name !== '' ? fields.name : entry.name.slice(0, -3)
      // 近いほう(先に読んだプロジェクト側)を優先する
      if (!found.has(name)) found.set(name, asList(fields.skills))
    }
  }
  return found
}

/** インストールしたプラグインの置き場。installed_plugins.json の `<プラグイン>@<マーケットプレイス>` ごとの installPath */
const installedPluginDirs = async (fs: FsLike, cfg: string, pluginName: string): Promise<string[]> => {
  const raw = await tryRead(fs, `${cfg}/plugins/installed_plugins.json`)
  if (raw === undefined) return []
  try {
    const plugins = (JSON.parse(raw) as { plugins?: Record<string, Array<{ installPath?: unknown }>> }).plugins ?? {}
    return Object.entries(plugins)
      .filter(([key]) => key.split('@')[0] === pluginName)
      .flatMap(([, list]) => (Array.isArray(list) ? list : []))
      .flatMap(one => (typeof one.installPath === 'string' ? [one.installPath] : []))
  } catch {
    return []
  }
}

/** 同期されたプラグインの置き場。plugins/synced/<束>/<プラグイン>~<版>/ */
const syncedPluginDirs = async (fs: FsLike, cfg: string, pluginName: string): Promise<string[]> => {
  const root = `${cfg}/plugins/synced`
  const dirs: string[] = []
  for (const bucket of await subdirs(fs, root)) {
    for (const name of await subdirs(fs, `${root}/${bucket}`)) {
      if (name === pluginName || name.startsWith(`${pluginName}~`)) dirs.push(`${root}/${bucket}/${name}`)
    }
  }
  return dirs
}

/** 出どころから、SKILL.md がありそうな場所を並べる。近いものから */
export const skillCandidates = async (
  fs: FsLike,
  skill: ListedSkill,
  where: { cfg: string; projects: readonly string[] },
): Promise<string[]> => {
  const base = baseName(skill.name)
  const user = [`${where.cfg}/skills/${base}/SKILL.md`]
  const project = where.projects.map(dir => `${dir}/.claude/skills/${base}/SKILL.md`)
  switch (skill.source) {
    case 'userSettings':
      return user
    case 'projectSettings':
      return project
    case 'plugin': {
      const plugin = skill.pluginName ?? skill.name.split(':')[0]
      const dirs = [
        ...(await installedPluginDirs(fs, where.cfg, plugin)),
        ...(await syncedPluginDirs(fs, where.cfg, plugin)),
      ]
      return dirs.map(dir => `${dir}/skills/${base}/SKILL.md`)
    }
    case 'syncedSkills': {
      const root = `${where.cfg}/skills/synced`
      return (await subdirs(fs, root)).map(bucket => `${root}/${bucket}/${base}/SKILL.md`)
    }
    case 'built-in':
    case 'mcp':
      // 組み込みはファイルを持たない。MCP のスキルは置き場が分からない
      return []
    default:
      return [...project, ...user]
  }
}

/** 一覧に出す並び。出どころごとにまとめる */
export const SOURCE_ORDER: ReadonlyArray<{ source: string; label: string }> = [
  { source: 'projectSettings', label: 'プロジェクト' },
  { source: 'userSettings', label: 'ユーザー' },
  { source: 'plugin', label: 'プラグイン' },
  { source: 'syncedSkills', label: '同期' },
  { source: 'built-in', label: '組み込み' },
]

export const sourceLabel = (source: string): string =>
  SOURCE_ORDER.find(one => one.source === source)?.label ?? source

/**
 * セッションのスキルに、SKILL.md の場所・説明・持たせているサブエージェントを添える。
 * agentTypes を渡したら、そのセッションで使えるエージェントだけを添える
 */
export const discoverSkills = async (
  fs: FsLike,
  input: {
    listed: readonly ListedSkill[]
    agentTypes?: readonly string[]
    cfg: string
    home: string
    root: string
  },
): Promise<SkillInfo[]> => {
  const projects = projectDirs(input.root, input.home)
  const agentSkills = await readAgentSkills(fs, [
    ...projects.map(dir => `${dir}/.claude/agents`),
    `${input.cfg}/agents`,
  ])
  const usable = input.agentTypes === undefined ? undefined : new Set(input.agentTypes)
  const skills: SkillInfo[] = []
  for (const skill of input.listed) {
    let path: string | undefined
    for (const candidate of await skillCandidates(fs, skill, { cfg: input.cfg, projects })) {
      if (await fs.exists(candidate).catch(() => false)) {
        path = candidate
        break
      }
    }
    const description = path === undefined ? undefined : parseFrontmatter((await tryRead(fs, path)) ?? '').fields.description
    const agents = [...agentSkills]
      .filter(([agent, list]) => (usable === undefined || usable.has(agent)) && (list.includes(skill.name) || list.includes(baseName(skill.name))))
      .map(([agent]) => agent)
    skills.push({
      name: skill.name,
      source: skill.source,
      ...(skill.pluginName === undefined ? {} : { pluginName: skill.pluginName }),
      ...(path === undefined ? {} : { path }),
      ...(typeof description === 'string' && description !== '' ? { description } : {}),
      agents,
    })
  }
  const rank = (source: string) => {
    const i = SOURCE_ORDER.findIndex(one => one.source === source)
    return i === -1 ? SOURCE_ORDER.length : i
  }
  // 出どころの順にまとめ、その中はエンジンの並びのまま
  return skills.map((skill, i) => ({ skill, i })).sort((a, b) => rank(a.skill.source) - rank(b.skill.source) || a.i - b.i).map(one => one.skill)
}
