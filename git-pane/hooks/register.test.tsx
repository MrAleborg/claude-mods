import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'git-pane',
  component: 'Pane',
  requestId: 'git-pane',
  props: {
    title: 'Git',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const fail = () => ({ exitCode: 128, stdout: '', stderr: 'fatal', isStdoutTruncated: false, isStderrTruncated: false })

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -3,2 +3,3 @@ fn',
  ' a',
  '-b',
  '+c',
  '+d',
  '\\ No newline at end of file',
  '',
].join('\n')

const gql = (nodes: any[]) =>
  JSON.stringify({ data: { repository: { issues: { totalCount: nodes.length, nodes: nodes.map(n => ({ blockedBy: { nodes: [] }, ...n })) } } } })

// Answers each git command by its argv; `over` replaces a subcommand's answer.
const git = (on: any, over: Record<string, (argv: string[]) => any> = {}) => {
  const calls: string[][] = []
  on('process.run', (_: any, e: any) => {
    const argv = [...e.argv]
    calls.push(argv)
    const key = argv[0] === 'gh' ? 'gh' : argv[1] === 'diff' && argv.includes('--name-status') ? 'names' : argv[1] === 'diff' && argv.includes('--numstat') ? 'numstat' : argv[1]
    if (over[key]) return { value: over[key](argv) }
    switch (key) {
      case 'rev-parse': return { value: ok('main\n') }
      case 'names': return { value: ok('M\0src/a.ts\0A\0b.txt\0') }
      case 'numstat': return { value: ok('2\t1\tsrc/a.ts\0' + '1\t0\tb.txt\0') }
      case 'diff': return { value: ok(argv.at(-1) === ':(top)src/a.ts' ? DIFF : '@@ -0,0 +1 @@\n+new\n') }
      case 'ls-files': return { value: ok('notes/todo.md\0x.txt\0') }
      case 'log': return { value: ok('* abc123 (HEAD -> main) first\n') }
      case 'gh': return { value: ok(gql([
        { number: 9, title: 'Newer', labels: { nodes: [] }, parent: null },
        { number: 7, title: 'Parser crash', labels: { nodes: [{ name: 'bug' }] }, parent: null },
      ])) }
    }
    return { value: fail() }
  })
  return calls
}

const engine = (on: any) => {
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'git-pane' } }))
  on('ui.open', (_: any, e: any) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  return opened
}

const start = ($: any) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`session.start opens the pane with branch and diff stats (${surface})`, async ($, on) => {
    const opened = engine(on)
    git(on)
    await start($)
    expect(opened).toContain('git-pane')

    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /⎇/ }))?.text).toContain('main')
    // two files: src/a.ts +2 -1, b.txt +1 -0
    expect((await ui.find({ key: 'diff' }))?.text).toMatch(/2 files.*\+3.*-1/)
    await ui.unmount()
  })
}

test('diff lines are numbered from the hunk header', async ($, on) => {
  engine(on)
  git(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('   3   a')
  expect(texts).toContain('   4 - b')
  expect(texts).toContain('   4 + c')
  expect(texts).toContain('   5 + d')
  expect(texts.some(t => t.includes('No newline'))).toBe(false)
  await ui.unmount()
})

test('not a git repository', async ($, on) => {
  engine(on)
  git(on, { 'rev-parse': fail })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Not a git repository.')
  await ui.unmount()
})

test('detached HEAD shows HEAD as the branch', async ($, on) => {
  engine(on)
  git(on, { 'rev-parse': () => ok('HEAD\n') })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /⎇/ }))?.text).toContain('HEAD')
  await ui.unmount()
})

test('a repository with no commits yet is still a repository', async ($, on) => {
  engine(on)
  // real git in a fresh `git init`: rev-parse --abbrev-ref HEAD exits 128, diff HEAD too
  git(on, {
    'rev-parse': fail,
    names: fail,
    diff: fail,
    log: fail,
    'symbolic-ref': () => ok('main\n'),
  })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Not a git repository/ })).toBeUndefined()
  await ui.unmount()
})

test('a non-ASCII path git quotes is diffed by its real name', async ($, on) => {
  engine(on)
  // without -z, git prints this path quoted as "caf\303\251.txt"; with -z it is the raw name
  const calls = git(on, { names: () => ok('M\0café.txt\0') })
  await start($)
  const diffs = calls.filter(c => c[1] === 'diff' && !c.includes('--name-status') && !c.includes('--numstat'))
  expect(diffs.map(c => c.at(-1))).toEqual([':(top)café.txt'])
})

test('/clear reopens and refills the pane', async ($, on) => {
  const opened = engine(on)
  git(on)
  on('classic.SessionStart', () => ({}))
  await $.classic.SessionStart({ source: 'clear' })
  expect(opened).toContain('git-pane')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /⎇/ }))?.text).toContain('main')
  await ui.unmount()
})

test('/git-pane opens the pane and refreshes', async ($, on) => {
  const opened = engine(on)
  const calls = git(on)
  const r = await $.command.run({ command: 'git-pane' })
  expect(r).toMatchObject({ text: 'Git pane opened.' })
  expect(opened).toContain('git-pane')
  expect(calls.some(c => c[1] === 'log')).toBe(true)
})

test('a tool call refreshes, and a failing git does not break the call', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: { text: 'ran' } }))
  on('process.run', () => {
    throw new Error('git missing')
  })
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(r).toMatchObject({ result: { text: 'ran' } })
})

test('pressing a file tab, the graph and an untracked folder', async ($, on) => {
  engine(on)
  git(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'b.txt' })
  expect((await ui.find({ key: 'b.txt' }))?.text).toMatch(/^▸ A b\.txt/)
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('   1 + new')

  expect(await ui.find({ type: 'Text', text: /abc123/ })).toBeUndefined()
  await ui.press({ key: 'graph' })
  expect(await ui.find({ type: 'Text', text: /abc123/ })).toBeDefined()
  const parts = (await ui.find({ type: 'Text', text: /abc123/ }))?.children as any[]
  expect(parts.find(c => c.children?.[0] === 'abc123')?.props.color).toBe('yellow')
  expect(parts.find(c => c.children?.[0] === 'HEAD -> main')?.props).toMatchObject({ color: 'cyan', bold: true })

  expect(await ui.find({ key: 'file:notes/todo.md' })).toBeDefined()
  await ui.press({ key: 'dir:notes' })
  expect(await ui.find({ key: 'file:notes/todo.md' })).toBeUndefined()
  expect(await ui.find({ key: 'file:x.txt' })).toBeDefined()
  await ui.unmount()
})

test('open GitHub issues are listed with labels and fold away', async ($, on) => {
  engine(on)
  git(on)
  await $.command.run({ command: 'git-pane' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'issues' }))?.text).toContain('Issues (2)')
  expect((await ui.find({ type: 'Text', text: /#7/ }))?.text).toMatch(/#7 Parser crash \[bug\]/)
  // newest last
  const rows = (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '').filter(x => /#\d/.test(x))
  expect(rows.findIndex(x => x.includes('#7'))).toBeLessThan(rows.findIndex(x => x.includes('#9')))
  await ui.press({ key: 'issues' })
  expect(await ui.find({ type: 'Text', text: /#7/ })).toBeUndefined()
  await ui.unmount()
})

test('sub-issues sit folded under their parent and expand on press', async ($, on) => {
  engine(on)
  git(on, {
    gh: () => ok(gql([
      { number: 5, title: 'Epic', labels: { nodes: [] }, parent: null },
      { number: 6, title: 'Child', labels: { nodes: [] }, parent: { number: 5 } },
      { number: 8, title: 'Grandchild', labels: { nodes: [] }, parent: { number: 6 } },
      { number: 4, title: 'Orphan', labels: { nodes: [] }, parent: { number: 1 } }, // parent closed
    ])),
  })
  await $.command.run({ command: 'git-pane' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'issues' }))?.text).toContain('Issues (4)')
  expect((await ui.find({ type: 'Text', text: /#4 Orphan/ }))?.text).toBeDefined()
  expect((await ui.find({ key: 'issue:5' }))?.text).toContain('▸ #5 Epic')
  expect(await ui.find({ type: 'Text', text: /Child/ })).toBeUndefined()
  await ui.press({ key: 'issue:5' })
  expect((await ui.find({ key: 'issue:6' }))?.text).toMatch(/^\s{4}▸ #6 Child/)
  expect(await ui.find({ type: 'Text', text: /Grandchild/ })).toBeUndefined()
  await ui.press({ key: 'issue:6' })
  expect((await ui.find({ type: 'Text', text: /#8 Grandchild/ }))?.text).toMatch(/^\s{8}#8/)
  await ui.press({ key: 'issue:5' })
  expect(await ui.find({ type: 'Text', text: /Child/ })).toBeUndefined()
  await ui.unmount()
})

test('blocked issues name their open blockers', async ($, on) => {
  engine(on)
  git(on, {
    gh: () => ok(gql([
      { number: 2, title: 'Base', labels: { nodes: [] }, parent: null },
      { number: 3, title: 'Waits', labels: { nodes: [] }, parent: null,
        blockedBy: { nodes: [{ number: 2, state: 'OPEN' }, { number: 1, state: 'CLOSED' }, { number: 9, state: 'OPEN' }] } },
    ])),
  })
  await $.command.run({ command: 'git-pane' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'issue:3' }))?.text).toContain('blocked by #2, #9')
  expect((await ui.find({ key: 'issue:2' }))?.text).not.toContain('blocked')
  await ui.unmount()
})

test('gh missing shows a hint instead of issues', async ($, on) => {
  engine(on)
  git(on, { gh: fail })
  await $.command.run({ command: 'git-pane' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /gh unavailable/ })).toBeDefined()
  await ui.unmount()
})

test('a nested repository listed as "sub/" draws no nameless file row', async ($, on) => {
  engine(on)
  // real `git ls-files --others --exclude-standard` output for an untracked nested repo
  git(on, { 'ls-files': () => ok('sub/\0') })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'file:sub/' })).toBeUndefined()
  await ui.unmount()
})

test('one diff is loaded per refresh, the selected file\'s, and counts come from --numstat', async ($, on) => {
  engine(on)
  const calls = git(on, {
    names: () => ok('M\0a\0M\0b\0M\0c\0M\0d\0'),
    numstat: () => ok('5\t0\ta\0' + '1\t1\tb\0' + '-\t-\tc\0' + '0\t3\td\0'),
  })
  await start($)
  const diffs = calls.filter(c => c[1] === 'diff' && !c.includes('--name-status') && !c.includes('--numstat'))
  expect(diffs.map(c => c.at(-1))).toEqual([':(top)a'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'diff' }))?.text).toMatch(/4 files.*\+6.*-4/)
  // a binary file has no line counts
  expect((await ui.find({ key: 'c' }))?.text).toMatch(/M c \+\? -\?/)
  await ui.press({ key: 'd' })
  expect(calls.filter(c => c[1] === 'diff' && c.at(-1) === ':(top)d').length).toBe(1)
  await ui.unmount()
})

test('a rename takes its counts from the new path', async ($, on) => {
  engine(on)
  git(on, { names: () => ok('R100\0old.ts\0new.ts\0'), numstat: () => ok('3\t2\t\0old.ts\0new.ts\0') })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'new.ts' }))?.text).toMatch(/R100 new\.ts \+3 -2/)
  await ui.unmount()
})

test('two changed files with the same name show their paths', async ($, on) => {
  engine(on)
  git(on, { names: () => ok('M\0a/register.tsx\0M\0b/register.tsx\0M\0c.ts\0'), numstat: () => ok('') })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'a/register.tsx' }))?.text).toContain('a/register.tsx')
  expect((await ui.find({ key: 'c.ts' }))?.text).toMatch(/M c\.ts/)
  await ui.unmount()
})

test('a diff longer than the pane says how many lines are left out', async ($, on) => {
  engine(on)
  const long = ['@@ -1,0 +1,100 @@', ...Array.from({ length: 100 }, (_, i) => `+l${i}`)].join('\n')
  git(on, { names: () => ok('M\0big.ts\0'), numstat: () => ok('100\t0\tbig.ts\0'), diff: () => ok(long) })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /… \d+ more lines/ })).toBeDefined()
  await ui.unmount()
})

test('the issue count says when more are open than were fetched', async ($, on) => {
  engine(on)
  git(on, { gh: () => ok(JSON.stringify({ data: { repository: { issues: { totalCount: 57, nodes: [{ number: 1, title: 'One', labels: { nodes: [] }, parent: null, blockedBy: { nodes: [] } }] } } } })) })
  await $.command.run({ command: 'git-pane', args: '' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'issues' }))?.text).toContain('Issues (1 of 57)')
  await ui.unmount()
})

test('where GitHub refuses the sub-issue and blocker fields, the plain list still shows', async ($, on) => {
  engine(on)
  git(on, {
    gh: argv => (argv.at(-1)?.includes('blockedBy')
      ? fail()
      : ok(JSON.stringify({ data: { repository: { issues: { totalCount: 1, nodes: [{ number: 4, title: 'Plain', labels: { nodes: [] } }] } } } }))),
  })
  await $.command.run({ command: 'git-pane', args: '' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /#4 Plain/ })).toBeDefined()
  await ui.unmount()
})

test('a read-only tool call runs no git', async ($, on) => {
  engine(on)
  const calls = git(on)
  on('tool.call', () => ({ result: {}, isReadOnly: true }))
  await start($)
  const before = calls.length
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' } as any)
  expect(calls.length).toBe(before)
})
