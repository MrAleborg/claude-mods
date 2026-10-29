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
  const r = await $.process.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard'])
  const list = r.exitCode === 0 ? r.stdout.split('\n').filter(Boolean) : []
  await update($, files, () => [...new Set<string>(list)].slice(0, MAX_FILES))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'file-tree',
      description: 'Show the file tree; select a file to edit it in a pane',
    })
    // shortcut: tabs follow open order and no API orders them; staggered opens keep
    // Agents & plan | Git | Files | MCP servers, upgrade if ui.open gains an order
    void $.clock.sleep(300).then(() => $.ui.open({ id: TREE, title: 'Files' }))
    await refresh($)

    return next(e)
  })

  on('command.run', { command: 'file-tree' }, async $ => {
    await $.ui.open({ id: TREE, title: 'Files' })
    await refresh($)

    return { text: 'File tree opened.' }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    await refresh($).catch(() => {})

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: TREE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const open = await read($, expanded)
    const current = await read($, edit)
    const rows = tree(await read($, files), open)

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
                await update($, edit, () => ({ path: r.path, saved: raw, draft: raw }))
                await $.ui.open({ id: EDITOR, title: r.name, focus: true, closeOnEscape: true })
              }}
            />
          ),
        )}
      </Box>
    )
  })

  on('ui.message', async ($, e, next) => {
    const d = e.data as { type?: string; text?: string }
    if (d?.type !== 'save' || typeof d.text !== 'string') return next(e)

    const cur = await read($, edit)
    await $.fs.write(cur.path, d.text)
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
          props={{ text: cur.saved }}
          height={Math.max(5, (e.viewport?.rows ?? 30) - 6)}
        />
      </Box>
    )
  })
}
