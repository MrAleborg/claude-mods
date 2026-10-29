import { expect, test } from 'claude-code/testing'

const props = {
  title: 'Files',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const
const TREE = { plugin: 'file-tree', component: 'Pane', requestId: 'file-tree', props } as const
const EDITOR = { plugin: 'file-tree', component: 'Pane', requestId: 'file-editor', props } as const
const SURFACES = ['terminal', 'desktop'] as const

// The engine beneath the mod: git's file list, a file system in memory, and a log of UI calls.
const world = (on: any, paths: string[] | null, disk: Record<string, string> = {}) => {
  const log = { argv: [] as string[][], opened: [] as string[], closed: [] as string[], toasts: [] as string[] }
  on('process.run', (_: any, e: any) => {
    log.argv.push([...e.argv])
    return { value: paths ? { exitCode: 0, stdout: paths.join('\n') + '\n', stderr: '' } : { exitCode: 128, stdout: '', stderr: 'not a git repository' } }
  })
  // $.fs resolves a relative path against the project folder; the disk is keyed relative.
  const rel = (p: string) => Object.keys(disk).find(k => p === k || p.endsWith('/' + k)) ?? p
  on('fs.read', (_: any, e: any) => (rel(e.path) in disk ? { value: disk[rel(e.path)] } : { deny: 'ENOENT' }))
  on('fs.write', (_: any, e: any) => ((disk[rel(e.path)] = e.text), { value: undefined }))
  on('command.register', () => ({ value: { command: 'file-tree' } }))
  on('clock.sleep', () => ({ value: undefined }))
  on('ui.open', (_: any, e: any) => (log.opened.push(e.id), { value: { isPlaced: true } }))
  on('ui.close', (_: any, e: any) => (log.closed.push(e.id), { value: undefined }))
  on('ui.toast', (_: any, e: any) => (log.toasts.push(e.text), { value: undefined }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  return log
}
const start = ($: any) => $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
const labels = async (ui: any) => (await ui.findAll({ type: 'Button' })).map((b: any) => b.props.label)

test('the pane draws folders collapsed, before files, on every surface', async ($, on) => {
  world(on, ['src/b.ts', 'src/a.ts', 'README.md', '.env'])
  await start($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...TREE, surface })
    expect(await labels(ui)).toEqual(['▸ src/', '  .env', '  README.md'])
    await ui.unmount()
  }
})

test('pressing a folder expands it, pressing again collapses it', async ($, on) => {
  world(on, ['src/lib/x.ts', 'src/b.ts', 'src/a.ts'])
  await start($)
  const ui = await $.ui.mount({ ...TREE, surface: 'terminal' })
  await ui.press({ key: 'dir:src' })
  expect(await labels(ui)).toEqual(['▾ src/', '  ▸ lib/', '    a.ts', '    b.ts'])
  await ui.press({ key: 'dir:src/lib' })
  expect(await ui.find({ key: 'file:src/lib/x.ts' })).toBeDefined()
  await ui.press({ key: 'dir:src' })
  expect(await labels(ui)).toEqual(['▸ src/'])
  await ui.unmount()
})

test('outside git (or nothing listed) the pane says No files.', async ($, on) => {
  world(on, null)
  await start($)
  const ui = await $.ui.mount({ ...TREE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('No files.')
  await ui.unmount()
})

test('ignored files are left to git; empty folders cannot show', async ($, on) => {
  const log = world(on, ['a.ts'])
  await start($)
  expect(log.argv[0]).toEqual(['git', 'ls-files', '--cached', '--others', '--exclude-standard'])
})

test('selecting a file opens the editor; typing and ctrl+s saves it and clears the edit', async ($, on) => {
  const disk = { 'README.md': 'hello\nworld' }
  const log = world(on, ['README.md'], disk)
  await start($)
  const tree = await $.ui.mount({ ...TREE, surface: 'terminal' })
  await tree.press({ key: 'file:README.md' })
  expect(log.opened).toContain('file-editor')
  expect(await labels(tree)).toEqual(['▸ README.md'])

  const ed = await $.ui.mount({ ...EDITOR, surface: 'terminal' })
  await ed.resize({ columns: 40, rows: 10, in: 'ed:README.md' })
  await ed.key({ key: 'end', in: 'ed:README.md' })
  await ed.key({ key: '!', in: 'ed:README.md' })
  await ed.key({ key: 'return', in: 'ed:README.md' })
  await ed.key({ key: 'x', in: 'ed:README.md' })
  expect((await ed.find({ type: 'Text', text: /unsaved/, in: 'ed:README.md' }))).toBeDefined()
  await ed.key({ key: 's', ctrl: true, in: 'ed:README.md' })

  expect(disk['README.md']).toBe('hello!\nx\nworld')
  expect(log.closed).toContain('file-editor')
  expect(log.toasts).toContain('Saved README.md')
  expect((await ed.find({ type: 'Text' }))?.text).toBe('Select a file in the Files pane.')
  await ed.unmount()
  await tree.unmount()
})

test('a binary file is refused with a toast and no editor', async ($, on) => {
  const log = world(on, ['img.png'], { 'img.png': 'PNG\0\0' })
  await start($)
  const ui = await $.ui.mount({ ...TREE, surface: 'desktop' })
  await ui.press({ key: 'file:img.png' })
  expect(log.toasts[0]).toMatch(/not editable/)
  expect(log.opened).not.toContain('file-editor')
  await ui.unmount()
})

test('/file-tree opens the pane and a tool call refreshes the list', async ($, on) => {
  const paths = ['a.ts']
  const log = world(on, paths)
  on('tool.call', () => ({ result: {} }))
  const r: any = await $.command.run({ command: 'file-tree', args: '' } as any)
  expect(r?.text).toBe('File tree opened.')
  expect(log.opened).toContain('file-tree')

  paths.push('b.ts')
  await $.tool.call({ tool: 'Write', file_path: 'b.ts', content: '' })
  const ui = await $.ui.mount({ ...TREE, surface: 'desktop' })
  expect(await labels(ui)).toEqual(['  a.ts', '  b.ts'])
  await ui.unmount()
})

// Bug: vscode/mobile have no Client element, so the editor pane is the path over an empty box.
test('on a surface without Client (vscode) the editor pane shows more than the path', async ($, on) => {
  world(on, ['a.ts'], { 'a.ts': 'x' })
  await start($)
  const tree = await $.ui.mount({ ...TREE, surface: 'vscode' })
  await tree.press({ key: 'file:a.ts' })
  const ed = await $.ui.mount({ ...EDITOR, surface: 'vscode' })
  expect((await ed.findAll({ type: 'Text' })).length).toBeGreaterThan(1)
  await ed.unmount()
  await tree.unmount()
})
