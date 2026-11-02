import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'agent-monitor',
  component: 'Pane',
  requestId: 'agent-monitor',
  props: { title: 'Agents & plan', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const SURFACES = ['terminal', 'desktop'] as const

// Every text the pane shows, in order, Buttons' labels included.
const texts = async (ui: { findAll: (q: object) => Promise<{ text?: string }[]> }) => (await ui.findAll({})).map(x => x.text ?? '').filter(Boolean)

const todo = (todos: { content: string; status: 'pending' | 'in_progress' | 'completed' }[]) =>
  ({ tool: 'TodoWrite', todos: todos.map(t => ({ ...t, activeForm: t.content })) }) as any

const spawn = (over: object = {}) =>
  ({ tool_use_id: 'tu1', prompt: 'go', description: 'work', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus', ...over }) as any

const PLAN_STEP = 'mcp__agent-monitor__plan_step'

test('session start registers both commands, the plan_step tool, and opens the pane', async ($, on) => {
  const commands: string[] = []
  const tools: string[] = []
  const opened: string[] = []
  on('command.register', (_, e) => (commands.push(e.name), { value: { command: e.name } }) as any)
  on('tool.register', (_, e) => (tools.push(e.name), { value: {} }) as any)
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }) as any)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as any)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)

  expect(commands).toEqual(['monitor', 'monitor-clear'])
  expect(tools).toEqual(['plan_step'])
  expect(opened).toEqual(['agent-monitor'])
})

test('/monitor opens the pane', async ($, on) => {
  const opened: string[] = []
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }) as any)

  const out = await $.command.run({ command: 'monitor', args: '' } as any)

  expect(opened).toEqual(['agent-monitor'])
  expect((out as { text?: string }).text).toBe('Agent monitor pane opened.')
})

test('empty state shows no plan and only Main', async $ => {
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const t = await texts(ui)
    expect(t.some(x => /no todo list yet/.test(x))).toBe(true)
    expect(t.some(x => /Plan \(0\/0\)/.test(x))).toBe(true)
    expect(t.some(x => /Agents \(0 running\)/.test(x))).toBe(true)
    expect(t.some(x => /○ Main/.test(x))).toBe(true)
    await ui.unmount()
  }
})

test('TodoWrite draws a numbered plan as a tree with counts and Main assigned', async ($, on) => {
  on('tool.call', () => ({ result: {} }) as any)
  await $.tool.call(todo([
    { content: '1. Build', status: 'pending' },
    { content: '1.1 Routes', status: 'completed' },
    { content: '1.2 Views', status: 'in_progress' },
  ]))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const t = await texts(ui)
    expect(t.some(x => /▾ ▶? ?○ Build \(1\/2\)|Build \(1\/2\)/.test(x))).toBe(true)
    expect(t.some(x => /✔ Routes/.test(x))).toBe(true)
    expect(t.some(x => /▶ Views/.test(x))).toBe(true)
    expect(t.some(x => /Assigned \(1\)/.test(x))).toBe(true)
    expect(t.some(x => /● Main/.test(x))).toBe(true)
    expect(t.some(x => /Plan \(1\/3\)/.test(x))).toBe(true)
    await ui.unmount()
  }
})

test('a TodoWrite rewrite keeps dropped steps and completes the dropped in-progress one', async ($, on) => {
  on('tool.call', () => ({ result: {} }) as any)
  await $.tool.call(todo([{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }]))
  await $.tool.call(todo([{ content: 'C', status: 'pending' }]))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const t = await texts(ui)
  expect(t.some(x => /✔ A/.test(x))).toBe(true)
  expect(t.some(x => /○ B/.test(x))).toBe(true)
  expect(t.some(x => /○ C/.test(x))).toBe(true)
  await ui.unmount()
})

test('plan_step sets a step by number, creates one with a title, and reports a missing one', async ($, on) => {
  on('tool.call', () => ({ result: {} }) as any)
  await $.tool.call(todo([{ content: '1. One', status: 'pending' }]))

  const set = await $.tool.call({ tool: PLAN_STEP, step: '1', status: 'completed' } as any)
  const made = await $.tool.call({ tool: PLAN_STEP, step: '2', status: 'pending', title: 'Two' } as any)
  const miss = await $.tool.call({ tool: PLAN_STEP, step: '9', status: 'completed' } as any)

  expect((set as any).result).toBe('Step 1 is now completed.')
  expect((made as any).result).toBe('Step 2 is now pending.')
  expect((miss as any).result).toBe('No step numbered 9 in the plan.')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const t = await texts(ui)
  expect(t.some(x => /✔ One/.test(x))).toBe(true)
  expect(t.some(x => /○ Two/.test(x))).toBe(true)
  await ui.unmount()
})

test('"blocked by" shows blocked until the named step completes', async ($, on) => {
  on('tool.call', () => ({ result: {} }) as any)
  await $.tool.call(todo([{ content: '1. First', status: 'pending' }, { content: '2. Second blocked by 1', status: 'pending' }]))
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await texts(ui)).some(x => /⊘ Second blocked by 1/.test(x))).toBe(true)
  await ui.unmount()

  await $.tool.call({ tool: PLAN_STEP, step: '1', status: 'completed' } as any)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const t = await texts(ui)
  expect(t.some(x => /○ Second$/.test(x))).toBe(true)
  await ui.unmount()
})

test('an agent links to its step, runs, logs its calls, and completes the step when it stops', async ($, on) => {
  on('tool.call', () => ({ result: {} }) as any)
  on('agent.spawn', () => ({ model: 'opus', agentId: 'a1' }) as any)
  on('classic.SubagentStart', () => ({}) as any)
  on('classic.SubagentStop', () => ({}) as any)
  await $.tool.call(todo([{ content: '1. Build', status: 'pending' }, { content: '1.2 Icons', status: 'pending' }]))

  await $.agent.spawn(spawn({ description: 'Step 1.2 check icons', name: 'Zed' }))
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'general-purpose' } as any)
  await $.tool.call({ tool: 'Bash', command: 'ls -la', agentId: 'a1' } as any)

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let t = await texts(ui)
  expect(t.some(x => /Agents \(1 running\)/.test(x))).toBe(true)
  expect(t.some(x => /● Zed$/.test(x))).toBe(true)
  expect(t.some(x => /▶ Icons/.test(x))).toBe(true)
  expect(t.some(x => /↳ Bash ls -la/.test(x))).toBe(true)
  expect(await ui.find({ key: 'kill-tu1' })).toBeDefined()
  await ui.unmount()

  await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'general-purpose', stop_hook_active: false, agent_transcript_path: '', last_assistant_message: '' } as any)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  t = await texts(ui)
  expect(t.some(x => /Agents \(0 running\)/.test(x))).toBe(true)
  expect(t.some(x => /✔ Icons/.test(x))).toBe(true)
  expect(await ui.find({ key: 'kill-tu1' })).toBeUndefined()
  await ui.unmount()
})

test('an unnamed agent with no step reference takes the first in-progress step and a random name', async ($, on) => {
  on('tool.call', () => ({ result: {} }) as any)
  on('agent.spawn', () => ({ model: 'opus' }) as any)
  await $.tool.call(todo([{ content: 'Write docs', status: 'in_progress' }]))
  await $.agent.spawn(spawn({ description: 'docs' }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const t = await texts(ui)
  expect(t.some(x => /● [A-Z][a-z]+$/.test(x))).toBe(true)
  expect(t.some(x => /☰ Write docs/.test(x))).toBe(true)
  await ui.unmount()
})

test('tasks a TaskUpdate gives an agent as owner show under that agent', async ($, on) => {
  let n = 0
  on('tool.call', (_, e) => ({ result: e.tool === 'TaskCreate' ? { task: { id: String(++n) } } : {} }) as any)
  on('agent.spawn', () => ({ model: 'opus' }) as any)
  on('classic.SubagentStart', () => ({}) as any)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Fix A', description: '' } as any)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Fix B', description: '' } as any)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Fix C', description: '' } as any)
  await $.agent.spawn(spawn({ description: 'fixer', name: 'Zed' }))
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'general-purpose' } as any)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', owner: 'a1', status: 'in_progress' } as any)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', owner: 'a1', status: 'completed' } as any)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '3', status: 'in_progress' } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const t = await texts(ui)
  // Leaf texts only (a Box's text joins its children).
  const rows = t.map(x => x.trim())
  const zed = rows.lastIndexOf('▾ ● Zed · opus')
  expect(rows.lastIndexOf('☰ Fix A')).toBeGreaterThan(zed)
  expect(rows.lastIndexOf('✔ Fix B')).toBeGreaterThan(zed)
  expect(rows.indexOf('☰ Fix C')).toBeGreaterThan(rows.lastIndexOf('▾ ● Main'))
  expect(rows.indexOf('☰ Fix C')).toBeLessThan(zed)
  expect(rows).not.toContain('▶ Fix B')
  await ui.unmount()
})

test('a spawn naming plan tasks makes the agent their owner', async ($, on) => {
  let n = 0
  on('tool.call', (_, e) => ({ result: e.tool === 'TaskCreate' ? { task: { id: String(++n) } } : {} }) as any)
  on('agent.spawn', () => ({ model: 'opus' }) as any)
  for (const subject of ['Fix A', 'Fix B', 'Fix C']) await $.tool.call({ tool: 'TaskCreate', subject, description: '' } as any)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '3', status: 'in_progress' } as any)
  await $.agent.spawn(spawn({ description: 'Fix git-pane', prompt: 'You own plan tasks #1 and #2.', name: 'Zed', tool_use_id: 'tz' }))
  await $.agent.spawn(spawn({ description: 'other', name: 'Amy', tool_use_id: 'ta' }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = (await texts(ui)).map(x => x.trim())
  const zed = rows.lastIndexOf('▾ ● Zed · opus')
  const amy = rows.lastIndexOf('▾ ● Amy · opus')
  // Zed owns 1 and 2 (now started); Amy's guess (the first step in progress) skips the steps Zed owns.
  expect(rows.slice(zed, amy)).toEqual(expect.arrayContaining(['☰ Fix A', '☰ Fix B']))
  expect(rows.slice(amy)).toContain('☰ Fix C')
  expect(rows.slice(amy)).not.toContain('☰ Fix A')
  await ui.unmount()
})

test('each task of an agent folds its own calls', async ($, on) => {
  on('tool.call', () => ({ result: {} }) as any)
  on('agent.spawn', () => ({ model: 'opus' }) as any)
  on('classic.SubagentStart', () => ({}) as any)
  await $.tool.call(todo([{ content: '1.1 Build', status: 'pending' }, { content: '1.2 Test', status: 'pending' }]))
  await $.agent.spawn(spawn({ description: 'steps 1.1 and step 1.2', name: 'Zed' }))
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'general-purpose' } as any)
  await $.tool.call({ tool: 'Bash', command: 'echo build', agentId: 'a1' } as any)
  await $.tool.call({ tool: PLAN_STEP, step: '1.1', status: 'completed', agentId: 'a1' } as any)
  await $.tool.call({ tool: 'Bash', command: 'echo test', agentId: 'a1' } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = async () => (await texts(ui)).map(x => x.trim())
  expect(await rows()).toContain('▸ ✔ 1.1 Build')
  expect(await rows()).toContain('▸ ☰ 1.2 Test')
  await ui.press({ key: 'task-tu1-0' })
  let r = await rows()
  expect(r).toContain('✔ Bash echo build')
  expect(r).not.toContain('… Bash echo test')
  await ui.press({ key: 'task-tu1-0' })
  await ui.press({ key: 'task-tu1-1' })
  r = await rows()
  expect(r).toContain('… Bash echo test')
  expect(r).not.toContain('✔ Bash echo build')
  await ui.unmount()
})

test('agents spawned in parallel get different names and only their own tasks', async ($, on) => {
  let n = 0
  on('tool.call', (_, e) => ({ result: e.tool === 'TaskCreate' ? { task: { id: String(++n) } } : {} }) as any)
  on('agent.spawn', () => ({ model: 'opus' }) as any)
  for (const subject of ['1.1 Fix A', '2.1 Fix B']) await $.tool.call({ tool: 'TaskCreate', subject, description: '' } as any)
  await Promise.all([
    $.agent.spawn(spawn({ description: 'plan task #1', tool_use_id: 'ta' })),
    $.agent.spawn(spawn({ description: 'step 2.1', tool_use_id: 'tb' })),
  ])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = (await texts(ui)).map(x => x.trim())
  const names = [...new Set(rows.filter(x => /^▾ ● \w+ · opus$/.test(x)))]
  expect(names.length).toBe(2)
  expect(rows.filter(x => x === '☰ 1.1 Fix A').length).toBe(1)
  expect(rows.filter(x => x === '☰ 2.1 Fix B').length).toBe(1)
  await ui.unmount()
})

test('a finished agent keeps its tasks; Main never lists them, and plan_step by id or title adds no copy', async ($, on) => {
  let n = 0
  on('tool.call', (_, e) => ({ result: e.tool === 'TaskCreate' ? { task: { id: String(++n) } } : {} }) as any)
  on('agent.spawn', () => ({ model: 'opus' }) as any)
  on('classic.SubagentStart', () => ({}) as any)
  on('classic.SubagentStop', () => ({}) as any)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Dummy A: count files', description: '' } as any)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Dummy B: read glossary', description: '' } as any)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' } as any)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' } as any)
  await $.agent.spawn(spawn({ description: 'Dummy A', prompt: 'plan task #1', name: 'Carol', tool_use_id: 'tc' }))
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'general-purpose' } as any)
  await $.tool.call({ tool: PLAN_STEP, step: '1', status: 'completed', title: 'Dummy A: count files', agentId: 'a1' } as any)
  await $.tool.call({ tool: PLAN_STEP, step: '9', status: 'completed', title: 'Dummy B: read glossary' } as any)
  await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'general-purpose', stop_hook_active: false, agent_transcript_path: '', last_assistant_message: '' } as any)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = (await texts(ui)).map(x => x.trim())
  const carol = rows.lastIndexOf('▾ ✔ Carol · opus')
  const main = rows.lastIndexOf('▾ ● Main')
  // One step each in the plan: no "1 Dummy A" or "9 Dummy B" copy.
  expect(rows.filter(x => /Dummy A/.test(x) && !/Dummy B/.test(x)).length).toBe(2)
  expect(rows.some(x => /^\S+ 9 Dummy B/.test(x))).toBe(false)
  // Dummy A sits under Carol only, even though Carol is done.
  expect(rows.lastIndexOf('✔ Dummy A: count files')).toBeGreaterThan(carol)
  expect(main).toBeGreaterThan(0)
  expect(rows.slice(main, carol).some(x => /Dummy A/.test(x))).toBe(false)
  expect(rows.slice(main, carol)).toContain('✔ Dummy B: read glossary')
  await ui.unmount()
})

test('plan_step with a title that already has its number does not number it twice', async ($, on) => {
  on('tool.call', () => ({ result: {} }) as any)
  await $.tool.call({ tool: PLAN_STEP, step: '1', status: 'in_progress', title: '1. Dummy mod test' } as any)
  await $.tool.call({ tool: PLAN_STEP, step: '1.1', status: 'pending', title: '1.1 Touch files' } as any)
  await $.tool.call({ tool: PLAN_STEP, step: '1.2', status: 'pending', title: 'Agent A' } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = (await texts(ui)).map(x => x.trim())
  expect(rows.some(x => x.startsWith('▾ ▶ Dummy mod test (0/2)'))).toBe(true)
  expect(rows).toContain('○ Touch files')
  expect(rows).toContain('○ Agent A')
  expect(rows.some(x => /1\.1 Touch|1\. Dummy/.test(x))).toBe(false)
  // Main had step 1 before it got substeps; a parent is not a task.
  expect(rows.some(x => /Dummy mod test/.test(x) && !x.includes('(0/2)'))).toBe(false)
  await ui.unmount()
})

test('pressing kill marks the agent killed and stops it with TaskStop', async ($, on) => {
  const stops: unknown[] = []
  on('tool.call', (_, e) => (e.tool === 'TaskStop' && stops.push((e as any).task_id), { result: {} }) as any)
  on('agent.spawn', () => ({ model: 'opus', agentId: 'a1' }) as any)
  on('classic.SubagentStart', () => ({}) as any)
  on('classic.SubagentStop', () => ({}) as any)
  await $.agent.spawn(spawn({ name: 'Zed' }))
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'general-purpose' } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'kill-tu1' })
  expect(stops).toEqual(['a1'])
  expect((await texts(ui)).some(x => /Agents \(0 running\)/.test(x))).toBe(true)
  await ui.unmount()
})

test('/monitor-clear empties plan and agents', async ($, on) => {
  on('tool.call', () => ({ result: {} }) as any)
  on('agent.spawn', () => ({ model: 'opus' }) as any)
  await $.tool.call(todo([{ content: 'X', status: 'pending' }]))
  await $.agent.spawn(spawn({ name: 'Zed' }))

  const out = await $.command.run({ command: 'monitor-clear', args: '' } as any)

  expect((out as any).text).toBe('Plan and agents cleared.')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const t = await texts(ui)
  expect(t.some(x => /no todo list yet/.test(x))).toBe(true)
  expect(t.some(x => /Zed/.test(x))).toBe(false)
  await ui.unmount()
})

test('PostToolUse reads the transcript into Main tokens, model and cost', async ($, on) => {
  const line = JSON.stringify({ message: { id: 'msg_1', model: 'claude-sonnet-4', usage: { input_tokens: 1000, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
  on('fs.read', () => ({ value: `${line}\n${line}\n` }) as any)
  on('classic.PostToolUse', () => ({}) as any)

  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 't', transcript_path: '/x/s.jsonl' } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // 1000 in at $3/M + 1000 out at $15/M = $0.018, counted once for the repeated id.
  expect((await texts(ui)).some(x => /Main · claude-sonnet-4 · 2.0k tok$/.test(x))).toBe(true)
  await ui.unmount()
})
