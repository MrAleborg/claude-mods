import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { GitInfo, Issues } from '../types'

const PANE = 'git-pane'
const empty: GitInfo = { isRepo: false, branch: '', files: [], untracked: [], graph: '' }
const info = atom({ plugin: 'git-pane', key: 'info' } as const, empty, {
  shape: 'info-2',
})
const tab = atom({ plugin: 'git-pane', key: 'tab' } as const, '', {
  shape: 'tab-1',
})
const isDiffOpen = atom(
  { plugin: 'git-pane', key: 'isDiffOpen' } as const,
  true,
  { shape: 'diff-1' },
)
const isUntrackedOpen = atom(
  { plugin: 'git-pane', key: 'isUntrackedOpen' } as const,
  true,
  { shape: 'untracked-1' },
)
const preview = atom(
  { plugin: 'git-pane', key: 'preview' } as const,
  { path: '', text: '' },
  { shape: 'preview-1' },
)
const collapsed = atom({ plugin: 'git-pane', key: 'collapsed' } as const, [], {
  shape: 'collapsed-1',
})
const isGraphOpen = atom(
  { plugin: 'git-pane', key: 'isGraphOpen' } as const,
  false,
  { shape: 'graph-1' },
)
const issues = atom(
  { plugin: 'git-pane', key: 'issues' } as const,
  { isAvailable: false, items: [] } as Issues,
  { shape: 'issues-1' },
)
const isIssuesOpen = atom(
  { plugin: 'git-pane', key: 'isIssuesOpen' } as const,
  true,
  { shape: 'issues-open-1' },
)

const MAX_DIFF = 20000
const MAX_UNTRACKED = 500

type Node = { dirs: Map<string, Node>; files: string[] }
type TreeRow = { isDir: boolean; path: string; name: string; depth: number }

// Untracked paths as folder/file rows, skipping what sits under a collapsed folder.
const tree = (paths: string[], closed: string[]): TreeRow[] => {
  const root: Node = { dirs: new Map(), files: [] }
  for (const p of paths) {
    const parts = p.split('/')
    let node = root
    for (const d of parts.slice(0, -1)) {
      if (!node.dirs.has(d)) node.dirs.set(d, { dirs: new Map(), files: [] })
      node = node.dirs.get(d)!
    }
    // an untracked nested repo comes as "sub/": a folder row, no nameless file
    if (parts[parts.length - 1]) node.files.push(parts[parts.length - 1])
  }
  const rows: TreeRow[] = []
  const walk = (node: Node, prefix: string, depth: number) => {
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const path = prefix + name
      rows.push({ isDir: true, path, name, depth })
      if (!closed.includes(path)) walk(child, path + '/', depth + 1)
    }
    for (const name of node.files.sort()) {
      rows.push({ isDir: false, path: prefix + name, name, depth })
    }
  }
  walk(root, '', 0)
  return rows
}

type Row = { kind: '+' | '-' | ' ' | '@'; no: number | null; text: string }

// Drops the git headers and numbers each line; the tab already names the file.
const parse = (diff: string): Row[] => {
  const rows: Row[] = []
  let o = 0
  let n = 0
  let inHunk = false
  for (const l of diff.split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)/.exec(l)
    if (m) {
      o = +m[1]
      n = +m[2]
      inHunk = true
      rows.push({ kind: '@', no: null, text: m[3] })
    } else if (!inHunk || l.startsWith('\\') || l === '') {
      continue
    } else if (l[0] === '+') {
      rows.push({ kind: '+', no: n++, text: l.slice(1) })
    } else if (l[0] === '-') {
      rows.push({ kind: '-', no: o++, text: l.slice(1) })
    } else {
      rows.push({ kind: ' ', no: n, text: l.slice(1) })
      o++
      n++
    }
  }
  return rows
}

const stats = (rows: Row[]) => ({
  added: rows.filter(r => r.kind === '+').length,
  deleted: rows.filter(r => r.kind === '-').length,
})

const refresh = async ($: any) => {
  const git = (...args: string[]) => $.process.run(['git', ...args])
  // symbolic-ref names the branch even before the first commit; rev-parse covers a detached HEAD
  let head = await git('symbolic-ref', '--short', 'HEAD')
  if (head.exitCode !== 0) head = await git('rev-parse', '--abbrev-ref', 'HEAD')
  if (head.exitCode !== 0) {
    await update($, info, () => empty)
    return
  }
  // -z: paths come unquoted, NUL-separated; a rename or copy (R100, C75) carries two paths
  const names = await git('diff', 'HEAD', '--name-status', '-z')
  const parts = names.stdout.split('\0').filter(Boolean)
  const files: GitInfo['files'] = []
  for (let i = 0; i < parts.length; ) {
    const status = parts[i]
    i += /^[RC]/.test(status) ? 3 : 2
    const path = parts[i - 1]
    const d = await git('diff', 'HEAD', '--', path)
    files.push({ path, status, diff: d.stdout.slice(0, MAX_DIFF) })
  }
  const other = await git('ls-files', '--others', '--exclude-standard', '-z')
  const untracked = other.stdout.split('\0').filter(Boolean).slice(0, MAX_UNTRACKED)
  const log = await git('log', '--graph', '--oneline', '--decorate', '--all', '-n', '40')
  await update($, info, () => ({
    isRepo: true,
    branch: head.stdout.trim(),
    files,
    untracked,
    graph: log.stdout,
  }))
}

// Open GitHub issues via gh; kept out of refresh since it hits the network.
const refreshIssues = async ($: any) => {
  const r = await $.process.run(['gh', 'issue', 'list', '--json', 'number,title,labels', '--limit', '30'])
  let items: Issues['items'] = []
  try {
    if (r.exitCode === 0) {
      items = JSON.parse(r.stdout).map((i: any) => ({
        number: i.number,
        title: i.title,
        labels: i.labels.map((l: any) => l.name),
      }))
    }
  } catch {}
  await update($, issues, () => ({ isAvailable: r.exitCode === 0, items }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'git-pane',
      description: 'Show branch, diffs, git graph and issues in a pane',
    })
    // shortcut: tabs follow open order and no API orders them; staggered opens keep
    // Agents & plan | Git | Files | MCP servers, upgrade if ui.open gains an order
    void $.clock.sleep(150).then(() => $.ui.open({ id: PANE, title: 'Git' }))
    await refresh($)
    void refreshIssues($).catch(() => {})

    return next(e)
  })

  on('command.run', { command: 'git-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Git' })
    await refresh($)
    await refreshIssues($).catch(() => {})

    return { text: 'Git pane opened.' }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    await refresh($).catch(() => {})

    return ran
  })

  // another plugin's $.fs.write (the file editor's save) updates the diffs
  on('fs.write', async ($, e, next) => {
    const done = await next(e)
    await refresh($).catch(() => {})

    return done
  })

  on('turn.complete', async ($, e, next) => {
    await refresh($)
    void refreshIssues($).catch(() => {})

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const g = await read($, info)
    const open = await read($, isGraphOpen)
    const isDiff = await read($, isDiffOpen)
    const total = g.files.reduce(
      (t, f) => {
        const n = stats(parse(f.diff))
        return { added: t.added + n.added, deleted: t.deleted + n.deleted }
      },
      { added: 0, deleted: 0 },
    )
    const isUntracked = await read($, isUntrackedOpen)
    const closed = await read($, collapsed)
    const shown = await read($, preview)
    const untrackedRows = tree(g.untracked, closed)
    const gh = await read($, issues)
    const isIssues = await read($, isIssuesOpen)

    if (!g.isRepo) {
      return <Text dimColor>Not a git repository.</Text>
    }

    const wanted = await read($, tab)
    const selected = g.files.find(f => f.path === wanted) ?? g.files[0]
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 12)
    const all = selected ? parse(selected.diff) : []
    const rows = all.slice(0, room)
    const { added, deleted } = stats(all)
    const graphLines = g.graph.split('\n').slice(0, 15)

    return (
      <Box flexDirection="column">
        <Text bold>⎇{'    '}{g.branch}</Text>
        <Text> </Text>
        <Button
          key="diff"
          plain
          onPress={() => update($, isDiffOpen, v => !v)}
        >
          {isDiff ? '▾' : '▸'} Diffs ({g.files.length} {g.files.length === 1 ? 'file' : 'files'},{' '}
          <Text color="green">+{total.added}</Text>{' '}
          <Text color="red">-{total.deleted}</Text>)
        </Button>
        {isDiff && (
        <Box flexDirection="column" borderStyle="round">
          {g.files.length === 0 && <Text dimColor>No changes.</Text>}
          <Box flexWrap="wrap">
            {g.files.map(f => {
              const n = stats(parse(f.diff))

              return (
                <Button key={f.path} onPress={() => update($, tab, () => f.path)}>
                  {f === selected ? '▸ ' : ''}
                  {f.status} {f.path.split('/').pop()}{' '}
                  <Text color="green">+{n.added}</Text>{' '}
                  <Text color="red">-{n.deleted}</Text>
                </Button>
              )
            })}
          </Box>
          {/* shortcut: viewport.columns is the whole conversation, not the pane; fixed width, upgrade if the pane width becomes readable */}
          {selected && (
            <Text>
              <Text color="green">+{added} added</Text>{'  '}
              <Text color="red">-{deleted} deleted</Text>
            </Text>
          )}
          <Text dimColor wrap="truncate">{'─'.repeat(24)}</Text>
          {selected && rows.length === 0 && <Text dimColor>No text diff.</Text>}
          {rows.map(r =>
            r.kind === '@' ? (
              <Text dimColor>⋯ {r.text}</Text>
            ) : (
              <Text>
                <Text dimColor>{String(r.no).padStart(4)} </Text>
                <Text color={r.kind === '+' ? 'green' : r.kind === '-' ? 'red' : undefined}>
                  {r.kind} {r.text}
                </Text>
              </Text>
            ),
          )}
        </Box>
        )}
        <Text> </Text>
        <Button
          key="untracked"
          plain
          label={`${isUntracked ? '▾' : '▸'} Untracked (${g.untracked.length})`}
          onPress={() => update($, isUntrackedOpen, v => !v)}
        />
        {isUntracked && g.untracked.length === 0 && <Text dimColor>{'  '}None.</Text>}
        {isUntracked &&
          untrackedRows.map(r =>
            r.isDir ? (
              <Button
                key={`dir:${r.path}`}
                plain
                label={`${'  '.repeat(r.depth + 1)}${closed.includes(r.path) ? '▸' : '▾'} ${r.name}/`}
                onPress={() =>
                  update($, collapsed, list =>
                    list.includes(r.path) ? list.filter(x => x !== r.path) : [...list, r.path],
                  )
                }
              />
            ) : (
              <Button
                key={`file:${r.path}`}
                plain
                label={`${'  '.repeat(r.depth + 1)}${shown.path === r.path ? '▸' : ' '} ${r.name}`}
                onPress={async () => {
                  const raw = await $.fs.read(r.path).catch(() => null)
                  const text =
                    raw === null ? '(unreadable)' : raw.includes('\0') ? '(binary file)' : raw.slice(0, MAX_DIFF)
                  await update($, preview, cur => (cur.path === r.path ? { path: '', text: '' } : { path: r.path, text }))
                }}
              />
            ),
          )}
        {isUntracked && g.untracked.includes(shown.path) && (
          <Box flexDirection="column" borderStyle="round">
            <Text bold>{shown.path}</Text>
            <Text dimColor wrap="truncate">{'─'.repeat(24)}</Text>
            {shown.text
              .split('\n')
              .slice(0, Math.max(3, (e.viewport?.rows ?? 30) - 12))
              .map((l, i) => (
                <Text>
                  <Text dimColor>{String(i + 1).padStart(4)} </Text>
                  {l}
                </Text>
              ))}
          </Box>
        )}
        <Text> </Text>
        <Button
          key="graph"
          plain
          label={`${open ? '▾' : '▸'} Git graph`}
          onPress={() => update($, isGraphOpen, v => !v)}
        />
        {open && (
          <Box flexDirection="column" borderStyle="round">
            {graphLines.map(l => <Text>{l}</Text>)}
          </Box>
        )}
        <Text> </Text>
        <Button
          key="issues"
          plain
          label={`${isIssues ? '▾' : '▸'} Issues (${gh.items.length})`}
          onPress={() => update($, isIssuesOpen, v => !v)}
        />
        {isIssues && !gh.isAvailable && <Text dimColor>{'  '}gh unavailable or no GitHub remote.</Text>}
        {isIssues && gh.isAvailable && gh.items.length === 0 && <Text dimColor>{'  '}No open issues.</Text>}
        {isIssues &&
          gh.items.map(i => (
            <Text key={`issue:${i.number}`}>
              <Text dimColor>{'  '}#{i.number}</Text> {i.title}
              {i.labels.length > 0 && <Text color="cyan"> [{i.labels.join(', ')}]</Text>}
            </Text>
          ))}
      </Box>
    )
  })
}
