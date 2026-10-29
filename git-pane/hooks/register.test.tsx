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

// Answers each git command by its argv; `over` replaces a subcommand's answer.
const git = (on: any, over: Record<string, (argv: string[]) => any> = {}) => {
  const calls: string[][] = []
  on('process.run', (_: any, e: any) => {
    const argv = [...e.argv]
    calls.push(argv)
    const key = argv[0] === 'gh' ? 'gh' : argv[1] === 'diff' && argv.includes('--name-status') ? 'names' : argv[1]
    if (over[key]) return { value: over[key](argv) }
    switch (key) {
      case 'rev-parse': return { value: ok('main\n') }
      case 'names': return { value: ok('M\0src/a.ts\0A\0b.txt\0') }
      case 'diff': return { value: ok(argv.at(-1) === 'src/a.ts' ? DIFF : '@@ -0,0 +1 @@\n+new\n') }
      case 'ls-files': return { value: ok('notes/todo.md\0x.txt\0') }
      case 'log': return { value: ok('* abc123 (HEAD -> main) first\n') }
      case 'gh': return { value: ok('[{"number":7,"title":"Parser crash","labels":[{"name":"bug"}]}]') }
    }
    return { value: fail() }
  })
  return calls
}

const engine = (on: any) => {
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'git-pane' } }))
  on('clock.sleep', () => ({ value: undefined }))
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
  const diffs = calls.filter(c => c[1] === 'diff' && !c.includes('--name-status'))
  expect(diffs.map(c => c.at(-1))).toEqual(['café.txt'])
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
  expect((await ui.find({ key: 'issues' }))?.text).toContain('Issues (1)')
  expect((await ui.find({ type: 'Text', text: /#7/ }))?.text).toMatch(/#7 Parser crash \[bug\]/)
  await ui.press({ key: 'issues' })
  expect(await ui.find({ type: 'Text', text: /#7/ })).toBeUndefined()
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
