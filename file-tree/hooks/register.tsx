import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Edit } from '../types'

const TREE = 'file-tree'
const EDITOR = 'file-editor'
const MAX_FILES = 2000

const files = atom({ plugin: 'file-tree', key: 'files' } as const, [], {
  shape: 'files-1',
})
const expanded = atom({ plugin: 'file-tree', key: 'expanded' } as const, [], {
  shape: 'expanded-1',
})
// How many files git listed, so the pane can say what the cap left out.
const total = atom({ plugin: 'file-tree', key: 'total' } as const, 0, {
  shape: 'total-1',
})
const none: Edit = { path: '', saved: '', draft: '' }
const edit = atom({ plugin: 'file-tree', key: 'edit' } as const, none, {
  shape: 'edit-1',
})

type Node = { dirs: Map<string, Node>; files: string[] }
type TreeRow = { isDir: boolean; path: string; name: string; depth: number }

// Paths as folder/file rows; only the contents of expanded folders are listed.
const tree = (paths: string[], open: string[]): TreeRow[] => {
  const root: Node = { dirs: new Map(), files: [] }
  for (const p of paths) {
    const parts = p.split('/')
    let node = root
    for (const d of parts.slice(0, -1)) {
      if (!node.dirs.has(d)) node.dirs.set(d, { dirs: new Map(), files: [] })
      node = node.dirs.get(d)!
    }
    node.files.push(parts[parts.length - 1])
  }
  const rows: TreeRow[] = []
  const walk = (node: Node, prefix: string, depth: number) => {
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const path = prefix + name
      rows.push({ isDir: true, path, name, depth })
      if (open.includes(path)) walk(child, path + '/', depth + 1)
    }
    for (const name of node.files.sort()) {
      rows.push({ isDir: false, path: prefix + name, name, depth })
    }
  }
  walk(root, '', 0)
  return rows
}

const refresh = async ($: any) => {
  // shortcut: git lists tracked + untracked-not-ignored files, so a project outside git shows nothing
  // -z: names come unquoted, so a non-ASCII one is not escaped
  const git = (...args: string[]) => $.process.run(['git', 'ls-files', ...args, '-z'])
  const r = await git('--cached', '--others', '--exclude-standard')
  // --cached still lists a tracked file deleted from disk, which cannot be opened
  const gone = new Set<string>(r.exitCode === 0 ? (await git('--deleted')).stdout.split('\0') : [])
  const list = r.exitCode === 0 ? [...new Set<string>(r.stdout.split('\0'))].filter(p => p && !gone.has(p)) : []
  await update($, files, () => list.slice(0, MAX_FILES))
  await update($, total, () => list.length)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'file-tree',
      description: 'Show the file tree; select a file to edit it in a pane',
    })
    void $.ui.open({ id: TREE, title: 'Files' })
    await refresh($)

    return next(e)
  })

  // /clear starts a new session (fresh $.state) without a session.start: fill the pane again
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      void $.ui.open({ id: TREE, title: 'Files' })
      await refresh($).catch(() => {})
    }

    return next(e)
  })

  on('command.run', { command: 'file-tree' }, async $ => {
    await $.ui.open({ id: TREE, title: 'Files' })
    await refresh($)

    return { text: 'File tree opened.' }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    // a read-only call changes no file
    if (!ran.isReadOnly) await refresh($).catch(() => {})

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: TREE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const open = await read($, expanded)
    const current = await read($, edit)
    const rows = tree(await read($, files), open)
    const hidden = (await read($, total)) - MAX_FILES

    return (
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>No files.</Text>}
        {rows.map(r =>
          r.isDir ? (
            <Button
              key={`dir:${r.path}`}
              plain
              label={`${'  '.repeat(r.depth)}${open.includes(r.path) ? '▾' : '▸'} ${r.name}/`}
              onPress={() =>
                update($, expanded, list =>
                  list.includes(r.path) ? list.filter(x => x !== r.path) : [...list, r.path],
                )
              }
            />
          ) : (
            <Button
              key={`file:${r.path}`}
              plain
              label={`${'  '.repeat(r.depth)}${current.path === r.path ? '▸' : ' '} ${r.name}`}
              onPress={async () => {
                const raw = await $.fs.read(r.path).catch(() => null)
                if (raw === null || raw.includes('\0')) {
                  $.ui.toast(`${r.path}: not editable (binary or over 4 MiB)`)
                  return
                }
                // Reopening the file the editor left unsaved keeps those edits; opening another drops them, said aloud.
                const cur = await read($, edit)
                const kept = cur.path === r.path && cur.draft !== cur.saved
                if (cur.path && cur.path !== r.path && cur.draft !== cur.saved) $.ui.toast(`Unsaved edits to ${cur.path} discarded`)
                await update($, edit, () => (kept ? { ...cur, saved: raw } : { path: r.path, saved: raw, draft: raw }))
                await $.ui.open({ id: EDITOR, title: r.name, focus: true, closeOnEscape: true })
              }}
            />
          ),
        )}
        {hidden > 0 && <Text dimColor>… {hidden} more files not shown</Text>}
      </Box>
    )
  })

  on('ui.message', async ($, e, next) => {
    const d = e.data as { type?: string; text?: string }
    if (e.requestId !== EDITOR || typeof d?.text !== 'string') return next(e)
    const text = d.text
    const cur = await read($, edit)
    if (!cur.path) return {}

    // The editor posts its text on every change, so closing it (Esc) keeps the edits for the next open of the file.
    if (d.type === 'draft') {
      await update($, edit, c => (c.path === cur.path ? { ...c, draft: text } : c))
      return {}
    }
    if (d.type !== 'save') return next(e)

    // The file may have changed since it was opened (Claude edited it): warn instead of overwriting; a second save overwrites.
    const now = await $.fs.read(cur.path).catch(() => null)
    if (now !== null && now !== cur.saved) {
      await update($, edit, c => ({ ...c, saved: now, draft: text }))
      $.ui.toast(`${cur.path} changed on disk since you opened it. Save again to overwrite it.`)
      return {}
    }
    try {
      await $.fs.write(cur.path, text)
    } catch (err) {
      $.ui.toast(`Could not save ${cur.path}: ${(err as Error).message}`)
      return {}
    }
    await update($, edit, () => none)
    await $.ui.close({ id: EDITOR })
    $.ui.toast(`Saved ${cur.path}`)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: EDITOR }, async ($, e) => {
    const cur = await read($, edit)

    // vscode and mobile have no Client, so no editor: show the text read-only.
    if (e.surface === 'vscode' || e.surface === 'mobile') {
      const { Box, Text, Code } = $.ui.resolve(e)
      if (cur.path === '') return <Text dimColor>Select a file in the Files pane.</Text>

      return (
        <Box flexDirection="column">
          <Text bold>{cur.path}</Text>
          <Text dimColor>Read-only here: editing needs the terminal or desktop app.</Text>
          <Code source={cur.saved} path={cur.path} startLine={1} />
        </Box>
      )
    }
    const { Box, Text, Client } = $.ui.resolve(e)

    if (cur.path === '') {
      return <Text dimColor>Select a file in the Files pane.</Text>
    }

    return (
      <Box flexDirection="column">
        <Text bold>{cur.path}</Text>
        <Client
          key={`ed:${cur.path}`}
          module="./editor.tsx"
          props={{ text: cur.draft, saved: cur.saved }}
          height={Math.max(5, (e.viewport?.rows ?? 30) - 6)}
        />
      </Box>
    )
  })
}
