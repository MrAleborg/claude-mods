import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Server } from '../types'

const PANE = 'mcp-pane'
const servers = atom({ plugin: 'mcp-pane', key: 'servers' } as const, [], {
  shape: 'servers-1',
})
const expanded = atom({ plugin: 'mcp-pane', key: 'expanded' } as const, [], {
  shape: 'expanded-1',
})

// MCP tools are named mcp__<server>__<tool>; the server part may itself hold "__"
export const group = (names: string[]): Server[] => {
  const by = new Map<string, string[]>()
  for (const n of names) {
    const m = /^mcp__(.+)__([^_].*?)$/.exec(n)
    if (!m) continue
    if (!by.has(m[1])) by.set(m[1], [])
    by.get(m[1])!.push(m[2])
  }
  return [...by]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, tools]) => ({ name, tools: tools.sort() }))
}

// shortcut: only servers whose tools reached the session; failed or auth-pending ones are absent, upgrade if an engine API lists server status
const refresh = async ($: any) => {
  const tools = await $.tool.list()
  await update($, servers, () => group(tools.filter((t: any) => t.mcp).map((t: any) => t.name)))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mcp-pane',
      description: 'Show the MCP servers of this session in a pane',
    })
    void $.ui.open({ id: PANE, title: 'MCP servers' })
    const done = await next(e)
    await refresh($).catch(() => {})

    return done
  })

  on('command.run', { command: 'mcp-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'MCP servers' })
    await refresh($)

    return { text: 'MCP servers pane opened.' }
  })

  on('turn.complete', async ($, e, next) => {
    await refresh($).catch(() => {})

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, servers)
    const open = await read($, expanded)

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>No MCP servers connected.</Text>}
        {list.map(s => (
          <Box key={s.name} flexDirection="column">
            <Button
              key={s.name}
              plain
              label={`${open.includes(s.name) ? '▾' : '▸'} ${s.name} (${s.tools.length})`}
              onPress={() =>
                update($, expanded, l => (l.includes(s.name) ? l.filter(x => x !== s.name) : [...l, s.name]))
              }
            />
            {open.includes(s.name) && s.tools.map(t => <Text dimColor>{'    '}{t}</Text>)}
          </Box>
        ))}
      </Box>
    )
  })
}
