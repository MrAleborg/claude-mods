import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { GitInfo, Issues } from '../types'

const PANE = 'git-pane'
const empty: GitInfo = { isRepo: false, branch: '', files: [], diff: { path: '', text: '' }, untracked: [], graph: '' }
const info = atom({ plugin: 'git-pane', key: 'info' } as const, empty, {
  shape: 'info-3',
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
  { isAvailable: false, total: 0, items: [] } as Issues,
  { shape: 'issues-3' },
)
const isIssuesOpen = atom(
  { plugin: 'git-pane', key: 'isIssuesOpen' } as const,
  true,
  { shape: 'issues-open-1' },
)
const openIssues = atom({ plugin: 'git-pane', key: 'openIssues' } as const, [] as number[], {
  shape: 'open-issues-1',
})

const MAX_DIFF = 20000
const MAX_UNTRACKED = 500

type IssueRow = Issues['items'][number] & { depth: number; hasKids: boolean }

// Issues nested under their open parent; a sub-issue whose parent is closed or not fetched is a root.
const issueTree = (items: Issues['items'], expanded: number[]): IssueRow[] => {
  const known = new Set(items.map(i => i.number))
  const kids = (p: number | null) => items.filter(i => (i.parent !== null && known.has(i.parent) ? i.parent : null) === p)
  const rows: IssueRow[] = []
  const walk = (p: number | null, depth: number) => {
    for (const i of kids(p)) {
      const hasKids = items.some(c => c.parent === i.number)
      rows.push({ ...i, depth, hasKids })
      if (hasKids && expanded.includes(i.number)) walk(i.number, depth + 1)
    }
  }
  walk(null, 0)
  return rows
}

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

// Colours a `git log --graph --oneline --decorate` line the way git does in a terminal; piped output has none.
const refColor = (r: string) =>
  r.startsWith('HEAD') ? 'cyan' : r.startsWith('tag: ') ? 'yellow' : r.includes('/') ? 'red' : 'green'
type Part = { text: string; color?: string; dim?: boolean; bold?: boolean }
const graphParts = (line: string): Part[] => {
  const m = /^([^0-9a-f]*)([0-9a-f]{4,})(?: \((.*?)\))?(.*)$/.exec(line)
  if (!m) return [{ text: line, dim: true }]
  const refs = m[3] ? m[3].split(', ') : []
  return [
    { text: m[1], dim: true },
    { text: m[2], color: 'yellow' },
    ...(refs.length ? [{ text: ' (', color: 'yellow' }] : []),
    ...refs.flatMap((r, i) => [
      ...(i ? [{ text: ', ', color: 'yellow' }] : []),
      { text: r, color: refColor(r), bold: true },
    ]),
    ...(refs.length ? [{ text: ')', color: 'yellow' }] : []),
    { text: m[4] },
  ]
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

// "… 12 more lines" under a list cut to the room it has, so a cut never looks like the end.
const more = (n: number, what = 'lines') => (n > 0 ? `… ${n} more ${what}` : '')

// One diff per refresh, the selected file's; the counts of all files come from one --numstat, so the cost does not grow
// with the number of changed files and a diff cut at MAX_DIFF does not skew them.
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
  // --numstat -z: "added\tdeleted\tpath", or "added\tdeleted\t" then old and new paths for a rename; "-" for binary
  const num = (await git('diff', 'HEAD', '--numstat', '-z')).stdout.split('\0')
  const counts = new Map<string, { added: number | null; deleted: number | null }>()
  for (let i = 0; i < num.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(num[i] as string)
    if (!m) continue
    const path = m[3] ? m[3] : ((i += 2), num[i] as string)
    counts.set(path, { added: m[1] === '-' ? null : Number(m[1]), deleted: m[2] === '-' ? null : Number(m[2]) })
  }
  const files: GitInfo['files'] = []
  for (let i = 0; i < parts.length; ) {
    const status = parts[i] as string
    i += /^[RC]/.test(status) ? 3 : 2
    const path = parts[i - 1] as string
    files.push({ path, status, ...(counts.get(path) ?? { added: null, deleted: null }) })
  }
  const wanted = await read($, tab)
  const selected = files.find(f => f.path === wanted) ?? files[0]
  // --name-status paths are from the repo root; :(top) reads them from there when the session runs in a subfolder
  const d = selected ? await git('diff', 'HEAD', '--', `:(top)${selected.path}`) : { stdout: '' }
  const other = await git('ls-files', '--others', '--exclude-standard', '-z')
  const untracked = other.stdout.split('\0').filter(Boolean).slice(0, MAX_UNTRACKED)
  const log = await git('log', '--graph', '--oneline', '--decorate', '--all', '-n', '40')
  await update($, info, () => ({
    isRepo: true,
    branch: head.stdout.trim(),
    files,
    diff: { path: selected?.path ?? '', text: d.stdout.slice(0, MAX_DIFF) },
    untracked,
    graph: log.stdout,
  }))
}

// gh issue list has no parent field, so GraphQL; gh fills {owner}/{repo} from the current repo
const issuesQuery = (extra: string) => `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){
  issues(states:OPEN,first:30,orderBy:{field:CREATED_AT,direction:DESC}){totalCount nodes{number title ${extra} labels(first:10){nodes{name}}}}}}`
// Sub-issues and blockers are newer GitHub fields; where the API refuses them, the plain list still shows.
const QUERIES = [issuesQuery('parent{number} blockedBy(first:10){nodes{number state}}'), issuesQuery('')]

// Open GitHub issues via gh; kept out of refresh since it hits the network.
const refreshIssues = async ($: any) => {
  const ask = (query: string) => $.process.run(['gh', 'api', 'graphql', '-F', 'owner={owner}', '-F', 'repo={repo}', '-f', `query=${query}`])
  let r = await ask(QUERIES[0] as string)
  if (r.exitCode !== 0) r = await ask(QUERIES[1] as string)
  let items: Issues['items'] = []
  let total = 0
  try {
    if (r.exitCode === 0) {
      const list = JSON.parse(r.stdout).data.repository.issues
      total = list.totalCount ?? list.nodes.length
      items = list.nodes.map((i: any) => ({
        number: i.number,
        title: i.title,
        labels: i.labels.nodes.map((l: any) => l.name),
        parent: i.parent?.number ?? null,
        blockedBy: (i.blockedBy?.nodes ?? []).filter((b: any) => b.state === 'OPEN').map((b: any) => b.number), // closed blockers no longer block
      })).sort((a: any, b: any) => a.number - b.number) // newest last
    }
  } catch {}
  await update($, issues, () => ({ isAvailable: r.exitCode === 0, total: Math.max(total, items.length), items }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'git-pane',
      description: 'Show branch, diffs, git graph and issues in a pane',
    })
    void $.ui.open({ id: PANE, title: 'Git' })
    await refresh($).catch(() => {})
    void refreshIssues($).catch(() => {})

    return next(e)
  })

  // /clear starts a new session (fresh $.state) without a session.start: fill the pane again
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      void $.ui.open({ id: PANE, title: 'Git' })
      await refresh($).catch(() => {})
      void refreshIssues($).catch(() => {})
    }

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
    // a read-only call changes no file
    if (!ran.isReadOnly) await refresh($).catch(() => {})

    return ran
  })

  // another plugin's $.fs.write (the file editor's save) updates the diffs
  on('fs.write', async ($, e, next) => {
    const done = await next(e)
    await refresh($).catch(() => {})

    return done
  })

  on('turn.complete', async ($, e, next) => {
    await refresh($).catch(() => {})
    void refreshIssues($).catch(() => {})

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const g = await read($, info)
    const open = await read($, isGraphOpen)
    const isDiff = await read($, isDiffOpen)
    const total = g.files.reduce((t, f) => ({ added: t.added + (f.added ?? 0), deleted: t.deleted + (f.deleted ?? 0) }), { added: 0, deleted: 0 })
    const isUntracked = await read($, isUntrackedOpen)
    const closed = await read($, collapsed)
    const shown = await read($, preview)
    const untrackedRows = tree(g.untracked, closed)
    const gh = await read($, issues)
    const isIssues = await read($, isIssuesOpen)
    const expanded = await read($, openIssues)

    if (!g.isRepo) {
      return <Text dimColor>Not a git repository.</Text>
    }

    const selected = g.files.find(f => f.path === g.diff.path)
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 12)
    const all = selected ? parse(g.diff.text) : []
    const rows = all.slice(0, room)
    const allGraph = g.graph.split('\n').filter(Boolean)
    const graphLines = allGraph.slice(0, 15)
    // A tab shows the file's name; two files with the same name show their paths.
    const label = (path: string) => {
      const name = path.split('/').pop() as string
      return g.files.filter(f => f.path.split('/').pop() === name).length > 1 ? path : name
    }
    const count = (n: number | null) => (n === null ? '?' : String(n))

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
            {g.files.map(f => (
              <Button
                key={f.path}
                onPress={async () => {
                  await update($, tab, () => f.path)
                  await refresh($).catch(() => {})
                }}
              >
                {f === selected ? '▸ ' : ''}
                {f.status} {label(f.path)}{' '}
                <Text color="green">+{count(f.added)}</Text>{' '}
                <Text color="red">-{count(f.deleted)}</Text>
              </Button>
            ))}
          </Box>
          {/* shortcut: viewport.columns is the whole conversation, not the pane; fixed width, upgrade if the pane width becomes readable */}
          {selected && (
            <Text>
              <Text color="green">+{count(selected.added)} added</Text>{'  '}
              <Text color="red">-{count(selected.deleted)} deleted</Text>
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
          {all.length > room && <Text dimColor>{more(all.length - room)}</Text>}
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
              .slice(0, room)
              .map((l, i) => (
                <Text>
                  <Text dimColor>{String(i + 1).padStart(4)} </Text>
                  {l}
                </Text>
              ))}
            {shown.text.split('\n').length > room && <Text dimColor>{more(shown.text.split('\n').length - room)}</Text>}
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
            {graphLines.map(l => (
              <Text>{graphParts(l).map(p => <Text color={p.color} dimColor={p.dim} bold={p.bold}>{p.text}</Text>)}</Text>
            ))}
            {allGraph.length > graphLines.length && <Text dimColor>{more(allGraph.length - graphLines.length)}</Text>}
          </Box>
        )}
        <Text> </Text>
        <Button
          key="issues"
          plain
          label={`${isIssues ? '▾' : '▸'} Issues (${gh.items.length}${gh.total > gh.items.length ? ` of ${gh.total}` : ''})`}
          onPress={() => update($, isIssuesOpen, v => !v)}
        />
        {isIssues && !gh.isAvailable && <Text dimColor>{'  '}gh unavailable or no GitHub remote.</Text>}
        {isIssues && gh.isAvailable && gh.items.length === 0 && <Text dimColor>{'  '}No open issues.</Text>}
        {isIssues &&
          issueTree(gh.items, expanded).map(i => {
            const body = (
              <Text>
                <Text dimColor>
                  {'  '.repeat(i.depth + 1)}
                  {i.hasKids ? (expanded.includes(i.number) ? '▾ ' : '▸ ') : '  '}#{i.number}
                </Text>{' '}
                {i.title}
                {i.blockedBy.length > 0 && <Text color="red"> ⊘ blocked by {i.blockedBy.map(n => `#${n}`).join(', ')}</Text>}
                {i.labels.length > 0 && <Text color="cyan"> [{i.labels.join(', ')}]</Text>}
              </Text>
            )

            return i.hasKids ? (
              <Button
                key={`issue:${i.number}`}
                plain
                onPress={() =>
                  update($, openIssues, list =>
                    list.includes(i.number) ? list.filter(x => x !== i.number) : [...list, i.number],
                  )
                }
              >
                {body}
              </Button>
            ) : (
              <Box key={`issue:${i.number}`}>{body}</Box>
            )
          })}
      </Box>
    )
  })
}
