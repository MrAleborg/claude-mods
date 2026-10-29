import { expect, test } from 'claude-code/testing'

import { group } from './register'

const PANE = {
  plugin: 'mcp-pane',
  component: 'Pane',
  requestId: 'mcp-pane',
  props: {
    title: 'MCP servers',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const TOOLS = [
  { name: 'Bash', description: '', mcp: false },
  { name: 'mcp__claude_ai_Claude_Docs__batch', description: '', mcp: true },
  { name: 'mcp__claude_ai_Claude_Docs__update', description: '', mcp: true },
  { name: 'mcp__plugin_chrome-devtools-mcp_chrome-devtools__new_page', description: '', mcp: true },
]

test('group splits server from tool, servers holding "__" too', () => {
  expect(group(['mcp__a__b__c_d', 'mcp__x__y', 'Bash'])).toEqual([
    { name: 'a__b', tools: ['c_d'] },
    { name: 'x', tools: ['y'] },
  ])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane lists servers and expands one to its tools (${surface})`, async ($, on) => {
    on('command.register', () => ({ value: { command: 'mcp-pane' } }))
    on('clock.sleep', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('tool.list', () => ({ value: TOOLS }))

    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'claude_ai_Claude_Docs' }))?.text).toContain('claude_ai_Claude_Docs (2)')
    expect(await ui.find({ key: 'plugin_chrome-devtools-mcp_chrome-devtools' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /batch/ })).toBeUndefined()
    await ui.press({ key: 'claude_ai_Claude_Docs' })
    expect(await ui.find({ type: 'Text', text: /batch/ })).toBeDefined()
    await ui.unmount()
  })
}

test('no MCP tools: says so', async ($, on) => {
  on('command.register', () => ({ value: { command: 'mcp-pane' } }))
  on('clock.sleep', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.list', () => ({ value: [TOOLS[0]] }))
  await $.command.run({ command: 'mcp-pane' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No MCP servers/ })).toBeDefined()
  await ui.unmount()
})
