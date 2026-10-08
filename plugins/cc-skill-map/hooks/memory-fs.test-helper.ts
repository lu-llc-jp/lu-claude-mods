import type { FsLike } from './discover'

// テストだけが使う、メモリ上のファイル。mod の本体からは読み込まない
/** パス → 中身のメモリ上のファイル。ディレクトリはファイルのパスから作る */
export const memoryFs = (files: Record<string, string>, links: string[] = []): FsLike => {
  const dirs = new Set<string>()
  for (const path of Object.keys(files)) {
    const parts = path.split('/')
    for (let i = 2; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'))
  }
  return {
    read: async path => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`)
      return files[path]
    },
    list: async path => {
      if (!dirs.has(path)) throw new Error(`ENOENT: ${path}`)
      const names = new Map<string, 'file' | 'dir' | 'other'>()
      for (const one of [...Object.keys(files), ...dirs]) {
        if (!one.startsWith(`${path}/`)) continue
        const rest = one.slice(path.length + 1)
        const name = rest.split('/')[0]
        const full = `${path}/${name}`
        names.set(name, links.includes(full) ? 'other' : dirs.has(full) ? 'dir' : 'file')
      }
      return [...names].map(([name, kind]) => ({ name, kind }))
    },
    exists: async path => path in files || dirs.has(path),
  }
}

