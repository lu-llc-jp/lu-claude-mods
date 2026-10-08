import { expect, test } from 'claude-code/testing'

import { baseName, discoverSkills, parseFrontmatter, projectDirs } from './discover'
import { memoryFs } from './memory-fs.test-helper'

const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`

test('frontmatter の文字列・配列・折り返しを読む', () => {
  const text = [
    '---',
    'name: helper',
    'description: >',
    '  一行目',
    '  二行目',
    'tools: Read, Bash',
    'skills:',
    '  - alpha',
    '  - "beta"',
    'tags: [x, y]',
    '---',
    '本文',
  ].join('\n')
  const { fields, body } = parseFrontmatter(text)
  expect(fields.name).toBe('helper')
  expect(fields.description).toBe('一行目 二行目')
  expect(fields.skills).toEqual(['alpha', 'beta'])
  expect(fields.tags).toEqual(['x', 'y'])
  expect(body).toBe('本文')
  expect(parseFrontmatter('# 見出しだけ').fields).toEqual({})
})

test('プラグインのスキル名から、スキルの部分を取り出す', () => {
  expect(baseName('kit:review')).toBe('review')
  expect(baseName('review')).toBe('review')
})

test('プロジェクトとして探すのは、起動したディレクトリからホームの手前まで', () => {
  expect(projectDirs('/home/u/work/app', '/home/u')).toEqual(['/home/u/work/app', '/home/u/work'])
  expect(projectDirs('/home/u', '/home/u')).toEqual([])
  // ホームの外なら、ルートの1つ下まで
  expect(projectDirs('/srv/app', '/home/u')).toEqual(['/srv/app', '/srv'])
})

const CFG = '/home/u/.config-claude'

const files: Record<string, string> = {
  [`${CFG}/skills/notes/SKILL.md`]: skillMd('notes', 'メモを整える'),
  [`${CFG}/skills/synced/bucket-1/pdf/SKILL.md`]: skillMd('pdf', 'PDF を扱う'),
  [`${CFG}/skills/synced/bucket-1/manifest.json`]: '{}',
  '/home/u/work/app/.claude/skills/release/SKILL.md': skillMd('release', 'リリースする'),
  [`${CFG}/plugins/installed_plugins.json`]: JSON.stringify({
    plugins: { 'kit@market': [{ installPath: `${CFG}/plugins/cache/market/kit/1.0.0` }] },
  }),
  [`${CFG}/plugins/cache/market/kit/1.0.0/skills/review/SKILL.md`]: skillMd('review', 'レビューする'),
  [`${CFG}/plugins/synced/bucket-2/tools~g2/skills/sketch/SKILL.md`]: skillMd('sketch', '下絵を描く'),
  [`${CFG}/agents/writer.md`]: '---\nname: writer\nskills:\n  - notes\n  - kit:review\n---\n',
  [`${CFG}/agents/retired.md`]: '---\nname: retired\nskills: [notes]\n---\n',
  '/home/u/work/app/.claude/agents/shipper.md': '---\nname: shipper\nskills: release\n---\n',
  // ホームの .claude はユーザーの設定で、プロジェクトとしては読まない
  '/home/u/.claude/skills/release/SKILL.md': skillMd('release', 'ホームのもの'),
}

test('出どころから SKILL.md を探し、説明とサブエージェントを添えて、出どころごとに並べる', async () => {
  const skills = await discoverSkills(memoryFs(files), {
    listed: [
      { name: 'notes', source: 'userSettings' },
      { name: 'loop', source: 'built-in' },
      { name: 'kit:review', source: 'plugin', pluginName: 'kit' },
      { name: 'tools:sketch', source: 'plugin', pluginName: 'tools' },
      { name: 'pdf', source: 'syncedSkills' },
      { name: 'release', source: 'projectSettings' },
      { name: 'gone', source: 'userSettings' },
    ],
    agentTypes: ['writer', 'shipper'],
    cfg: CFG,
    home: '/home/u',
    root: '/home/u/work/app',
  })

  expect(skills.map(one => [one.name, one.path ?? null, one.description ?? null, one.agents])).toEqual([
    ['release', '/home/u/work/app/.claude/skills/release/SKILL.md', 'リリースする', ['shipper']],
    // retired はこのセッションのエージェントに無いので添えない
    ['notes', `${CFG}/skills/notes/SKILL.md`, 'メモを整える', ['writer']],
    ['gone', null, null, []],
    ['kit:review', `${CFG}/plugins/cache/market/kit/1.0.0/skills/review/SKILL.md`, 'レビューする', ['writer']],
    ['tools:sketch', `${CFG}/plugins/synced/bucket-2/tools~g2/skills/sketch/SKILL.md`, '下絵を描く', []],
    ['pdf', `${CFG}/skills/synced/bucket-1/pdf/SKILL.md`, 'PDF を扱う', []],
    ['loop', null, null, []],
  ])
})

test('シンボリックリンクの同期フォルダもたどる', async () => {
  const skills = await discoverSkills(memoryFs(files, [`${CFG}/skills/synced/bucket-1`]), {
    listed: [{ name: 'pdf', source: 'syncedSkills' }],
    cfg: CFG,
    home: '/home/u',
    root: '/home/u/work/app',
  })
  expect(skills[0].path).toBe(`${CFG}/skills/synced/bucket-1/pdf/SKILL.md`)
})

test('設定フォルダが空でも、名前だけの一覧を返す', async () => {
  const skills = await discoverSkills(memoryFs({}), {
    listed: [{ name: 'notes', source: 'userSettings' }],
    cfg: CFG,
    home: '/home/u',
    root: '/home/u/work/app',
  })
  expect(skills).toEqual([{ name: 'notes', source: 'userSettings', agents: [] }])
})
