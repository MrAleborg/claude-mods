import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Running, Step } from '../types'

const PANE = 'plan-progress'
const steps = atom({ plugin: 'plan-progress', key: 'steps' } as const, [] as Step[])
const running = atom({ plugin: 'plan-progress', key: 'running' } as const, [] as Running[])

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'plan-pane',
      description: 'Show the plan progress and running agents in a pane',
    })
    void $.ui.open({ id: PANE, title: 'Plan' })

    return next(e)
  })

  on('command.run', { command: 'plan-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Plan' })

    return { text: 'Plan pane opened.' }
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    await update($, steps, () => e.todos)

    return next(e)
  })

  // shortcut: a background agent leaves the list when its launch returns, not when it ends; upgrade by reading background tasks
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const one: Running = {
      id: e.tool_use_id,
      label: `${e.subagent_type ?? 'agent'}: ${e.description}`,
    }
    await update($, running, list => [...list, one])
    try {
      return await next(e)
    } finally {
      await update($, running, list => list.filter(r => r.id !== one.id))
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const all = await read($, steps)
    const agents = await read($, running)
    const done = all.filter(s => s.status === 'completed').length
    const current = all.find(s => s.status === 'in_progress')
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 6 - agents.length)

    return (
      <Box flexDirection="column">
        {all.length === 0 && <Text dimColor>No plan yet.</Text>}
        {all.length > 0 && (
          <Text bold>
            Plan {done}/{all.length} {'█'.repeat(done)}{'░'.repeat(all.length - done)}
          </Text>
        )}
        {all.slice(0, room).map((s, i) => (
          <Text key={i} dimColor={s !== current}>
            {s.status === 'completed' ? '✔' : s === current ? '▶' : '○'}{' '}
            {s === current ? s.activeForm : s.content}
          </Text>
        ))}
        <Text bold>Agents</Text>
        {agents.length === 0 && <Text dimColor>None running.</Text>}
        {agents.map(r => (
          <Text key={r.id}>▶ {r.label}</Text>
        ))}
      </Box>
    )
  })
}
