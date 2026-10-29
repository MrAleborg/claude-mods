import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRun, Step } from '../types'

const PANE = 'agent-monitor'
const agents = atom({ plugin: 'agent-monitor', key: 'agents' } as const, [], { shape: 'agents-2' })
const steps = atom({ plugin: 'agent-monitor', key: 'steps' } as const, [], { shape: 'steps-1' })

const folded = atom({ plugin: 'agent-monitor', key: 'folded' } as const, { plan: false, agents: false }, { shape: 'folded-1' })

// One line on what a tool call does: the tool plus its most telling argument.
const gist = (e: Record<string, unknown>) => {
  const arg = e.command ?? e.file_path ?? e.pattern ?? e.query ?? e.url ?? e.description ?? ''

  return `${String(e.tool)} ${String(arg).replace(/\s+/g, ' ').slice(0, 60)}`.trim()
}

const opened = atom({ plugin: 'agent-monitor', key: 'opened' } as const, {}, { shape: 'opened-1' })

type Node = { step: Step; text: string; kids: Node[] }

// TodoWrite is flat, so depth comes from a convention in the text: two spaces of indent per level, or a dotted number ("1.2 ...").
// shortcut: no explicit parent ids; a step's parent is the nearest earlier step that is shallower.
const depthOf = (c: string) => {
  const m = /^( *)(?:(\d+(?:\.\d+)*)[.)]?\s+|[-*]\s+)?(.*)$/s.exec(c) as RegExpExecArray

  return { depth: Math.max(Math.floor(m[1].length / 2), m[2] ? m[2].split('.').length - 1 : 0), text: m[3] }
}

// "Step 1.2 ..." or "[1.2] ..." in an agent's description or prompt names the plan step it works on.
const stepRef = (text: string) => /(?:\bstep\s*|^\s*\[)(\d+(?:\.\d+)*)/i.exec(text)?.[1]
const numberOf = (c: string) => /^ *(\d+(?:\.\d+)*)[.)]?\s/.exec(c)?.[1]

const treeOf = (steps: Step[]) => {
  const roots: Node[] = []
  const stack: { depth: number; node: Node }[] = []
  for (const step of steps) {
    const { depth, text } = depthOf(step.content)
    const node: Node = { step, text, kids: [] }
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop()
    ;(stack.length ? stack[stack.length - 1].node.kids : roots).push(node)
    stack.push({ depth, node })
  }

  return roots
}

const leaves = (n: Node): Step['status'][] => (n.kids.length ? n.kids.flatMap(leaves) : [n.step.status])

const flat = (n: Node): Node[] => [n, ...n.kids.flatMap(flat)]

const NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy', 'Mallory', 'Niaj', 'Olivia', 'Peggy', 'Rupert', 'Sybil', 'Trent', 'Victor', 'Wendy']

// TodoWrite has no blocked status, so a step says so in its text: "[blocked]", or "blocked by 1.2, 2.1" which clears
// once every named step is completed. shortcut: a named step missing from the plan keeps the block; upgrade if plans get pruned.
const BY = /\s*\(?\bblocked by\b[^)\n]*\)?/i
const blockers = (c: string) => /\bblocked by\b([^)\n]*)/i.exec(c)?.[1].match(/\d+(?:\.\d+)*/g)

const main = atom({ plugin: 'agent-monitor', key: 'main' } as const, {}, { shape: 'main-2' })

// The main session's tasks: steps in progress that no running agent has, remembered so finished ones stay listed.
const claimed = (plan: Step[], runs: AgentRun[], prev: string[] = []) => {
  const now = treeOf(plan)
    .flatMap(flat)
    .filter(n => !n.kids.length && n.step.status === 'in_progress' && !runs.some(a => !a.isDone && a.task === n.step.content))
    .map(n => n.step.content)

  return [...prev, ...now.filter(c => !prev.includes(c))].slice(-30)
}

const MARK = { completed: '✔', in_progress: '▶', pending: '○' } as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'monitor', description: 'Show running agents and plan progress in a pane' })
    await $.tool.register({
      name: 'plan_step',
      description: 'Set the status of a plan step shown in the agent-monitor pane, by its number (e.g. "1.2").',
      inputSchema: {
        type: 'object',
        properties: { step: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
        required: ['step', 'status'],
      },
    })
    await $.command.register({ name: 'monitor-clear', description: 'Clear the plan and the agent list in the pane' })
    void $.ui.open({ id: PANE, title: 'Agents & plan' })

    return next(e)
  })

  on('command.run', { command: 'monitor' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Agents & plan' })

    return { text: 'Agent monitor pane opened.' }
  })

  on('tool.call', { tool: 'mcp__agent-monitor__plan_step' }, async ($, e) => {
    const { step, status } = e as unknown as { step: string; status: Step['status'] }
    let hit = false
    await update($, steps, old => old.map(t => (numberOf(t.content) === step ? ((hit = true), { ...t, status }) : t)))

    const [plan, runs] = [await read($, steps), await read($, agents)]
    await update($, main, m => ({ ...m, tasks: claimed(plan, runs, m.tasks) }))

    return { result: hit ? `Step ${step} is now ${status}.` : `No step numbered ${step} in the plan.` }
  })

  on('command.run', { command: 'monitor-clear' }, async $ => {
    await update($, steps, () => [])
    await update($, agents, () => [])
    await update($, opened, () => ({}))
    await update($, main, () => ({}))

    return { text: 'Plan and agents cleared.' }
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    // Merge so finished steps stay listed after the model rewrites or clears its todo list.
    await update($, steps, old => {
      const fresh: Step[] = e.todos.map(t => ({ content: t.content, status: t.status }))
      const seen = new Set(fresh.map(t => t.content))

      return [...old.filter(t => !seen.has(t.content)).map(t => ({ ...t, status: t.status === 'in_progress' ? 'completed' as const : t.status })), ...fresh].slice(-100)
    })

    return next(e)
  })

  // The Agent tool returns at launch for background agents, so completion comes from the subagent events.
  on('agent.spawn', async ($, e, next) => {
    // The step named by number in the description or prompt; else the first step in progress at spawn (a guess).
    const plan = await read($, steps)
    const ref = stepRef(e.description) ?? stepRef(e.prompt)
    const task = (ref ? plan.find(t => numberOf(t.content) === ref) : undefined)?.content ?? plan.find(t => t.status === 'in_progress')?.content
    // tool_use_id can be empty for a resumed run; every Button needs a non-empty key.
    // An unnamed agent gets a random first name, one not already on the list while any are left.
    const used = new Set((await read($, agents)).map(a => a.name))
    const free = NAMES.filter(n => !used.has(n))
    const pool = free.length ? free : NAMES
    const name = e.name ?? `${pool[Math.floor(Math.random() * pool.length)]}${free.length ? '' : `-${used.size}`}`
    // Assigning an agent starts its step, so the Assigned section picks it up.
    if (task) {
      await update($, steps, old => old.map(t => (t.content === task && t.status === 'pending' ? { ...t, status: 'in_progress' as const } : t)))
    }
    const run: AgentRun = { id: e.tool_use_id || `spawn-${await $.clock.now()}`, name, desc: e.description, task, parentId: e.parentAgentId, isDone: false }
    await update($, agents, list => [...list, run].slice(-50))

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // Pause is soft: the agent is held at its next tool call; a call already running finishes.
    // shortcut: the hook's own budget may run out on a long pause; upgrade if the engine adds a real pause.
    while (e.agentId && (await read($, agents)).find(a => a.agentId === e.agentId)?.state === 'paused') {
      await $.clock.sleep(500, { signal: next.signal })
    }

    if (!e.agentId) {
      const doing = gist(e)
      const [plan, runs] = [await read($, steps), await read($, agents)]
      await update($, main, m => ({ doing, log: [...(m.log ?? []), doing].slice(-30), tasks: claimed(plan, runs, m.tasks) }))
    }

    if (e.agentId) {
      const doing = gist(e)
      await update($, agents, list => list.map(a => (a.agentId === e.agentId ? { ...a, doing, log: [...(a.log ?? []), doing].slice(-30) } : a)))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await update($, main, m => ({ ...m, doing: undefined }))

    return next(e)
  })

  on('classic.SubagentStart', async ($, e, next) => {
    // shortcut: pairs a start with the oldest unpaired spawn, wrong if two spawn at once; upgrade if ids appear on agent.spawn
    await update($, agents, list => {
      const i = list.findIndex(a => !a.agentId && !a.isDone)
      return i < 0 ? list : list.map((a, j) => (j === i ? { ...a, agentId: e.agent_id } : a))
    })

    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    await update($, agents, list => list.map(a => (a.agentId === e.agent_id ? { ...a, isDone: true } : a)))
    // shortcut: a finished agent completes its step once no other agent still works on it; success is not checked.
    const list = await read($, agents)
    const done = list.find(a => a.agentId === e.agent_id)
    if (done?.state !== 'killed' && done?.task && !list.some(a => !a.isDone && a.task === done.task)) {
      await update($, steps, old => old.map(t => (t.content === done.task ? { ...t, status: 'completed' as const } : t)))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [runs, plan] = [await read($, agents), await read($, steps)]
    const fold = await read($, folded)
    const open = await read($, opened)
    const toggle = (k: 'plan' | 'agents') => () => update($, folded, f => ({ ...f, [k]: !f[k] }))
    const live = runs.filter(a => !a.isDone)
    // Assigned = steps a running agent has, or that Main has (in progress, no agent); empty when nobody is on any.
    const liveMain = claimed(plan, runs)
    const whoHas = (c: string) => [...runs.filter(a => !a.isDone && a.task === c).map(a => a.name), ...(liveMain.includes(c) ? ['Main'] : [])]
    const now = treeOf(plan).flatMap(flat).filter(n => whoHas(n.step.content).length > 0)

    const status = (n: Node) => (n.kids.length && leaves(n).every(x => x === 'completed') ? 'completed' : n.step.status)
    const byNum = new Map(treeOf(plan).flatMap(flat).map(n => [numberOf(n.step.content), n] as const))
    // Plan nodes are open unless toggled shut.
    const node = (n: Node, path: string, depth: number): unknown => {
      const pad = '  '.repeat(depth + 1)
      const st = status(n)
      const refs = blockers(n.step.content)
      const blocked =
        st !== 'completed' &&
        (refs ? refs.some(r => { const b = byNum.get(r); return !b || status(b) !== 'completed' }) : /\bblocked\b/i.test(n.step.content))
      const label = blocked || !refs ? n.text : n.text.replace(BY, '')
      const icon = blocked ? '⊘' : MARK[st]
      const key = `pc-${path}`
      if (!n.kids.length) {
        return <Text dimColor={st === 'completed'} color={blocked ? 'red' : undefined}>{`${pad}  ${icon} ${label}`}</Text>
      }
      const done = leaves(n).filter(x => x === 'completed').length

      return (
        <Box flexDirection="column">
          <Button plain
            key={key}
            label={`${pad}${open[key] ? '▸' : '▾'} ${icon} ${label} (${done}/${leaves(n).length})`}
            onPress={() => update($, opened, o => ({ ...o, [key]: !o[key] }))}
          />
          {!open[key] && n.kids.map((k, i) => node(k, `${path}.${i}`, depth + 1))}
        </Box>
      )
    }

    const setState = (a: AgentRun, state?: 'paused' | 'killed') =>
      update($, agents, l => l.map(x => (x.id === a.id ? { ...x, state } : x)))
    const kill = async (a: AgentRun) => {
      await setState(a, 'killed')
      await update($, agents, l => l.map(x => (x.id === a.id ? { ...x, isDone: true } : x)))
      await $.tool.call({ tool: 'TaskStop', task_id: a.agentId })
    }
    // running blue, paused yellow, done green, killed gray
    const toneOf = (a: AgentRun) => (a.id === 'main' ? (a.doing ? 'blue' : 'gray') : a.state === 'killed' ? 'gray' : a.state === 'paused' ? 'yellow' : a.isDone ? 'green' : 'blue')
    const mainState = await read($, main)
    const mainRun: AgentRun = { id: 'main', name: 'Main', doing: mainState.doing, log: mainState.log, isDone: false }
    const mainTasks = (mainState.tasks ?? []).filter(c => plan.some(t => t.content === c) && !runs.some(a => !a.isDone && a.task === c))
    const kids = (a: AgentRun) => (a.agentId ? runs.filter(c => c.parentId === a.agentId) : [])
    const roots = runs.filter(a => !a.parentId || !runs.some(p => p.agentId === a.parentId))
    // Subagents hang under their parent and show while the parent is open.
    const row = (a: AgentRun, depth: number): unknown => {
      const pad = '  '.repeat(depth)
      const sub = kids(a)
      const tone = toneOf(a)
      const log = a.log ?? []
      // Agents open one level by default: the task shows, its commands stay folded.
      const isOpen = open[a.id] ?? true
      const isMain = a.id === 'main'
      const tasks = isMain ? mainTasks : a.task ? [a.task] : []
      const hasMore = tasks.length > 0 || log.length > 0 || sub.length > 0

      return (
        <Box flexDirection="column">
          <Box>
            <Button plain
              key={`agent-${a.id}`}
              onPress={() => update($, opened, o => ({ ...o, [a.id]: !(o[a.id] ?? true) }))}
            >
              <Text color={tone} strikethrough={a.state === 'killed'}>
                {`${pad}  ${hasMore ? (isOpen ? '▾' : '▸') : ' '} ${a.isDone ? '✔' : isMain && !a.doing ? '○' : '●'} ${a.name}${a.desc ? ` · ${a.desc}` : ''}${sub.length ? ` (+${sub.length})` : ''}`}
              </Text>
            </Button>
            {a.agentId && !a.isDone && (
              <Button plain key={`pause-${a.id}`} label={a.state === 'paused' ? ' ▶' : ' ‖'} onPress={() => setState(a, a.state === 'paused' ? undefined : 'paused')} />
            )}
            {a.agentId && !a.isDone && <Button plain key={`kill-${a.id}`} label=" ■" onPress={() => kill(a)} />}
            {!isMain && <Button plain key={`rm-${a.id}`} label=" ✕" onPress={() => update($, agents, l => l.filter(x => x.id !== a.id))} />}
          </Box>
          {isOpen && tasks.map((task, i) => (
            <Button plain
              key={`task-${a.id}-${i}`}
              label={`${pad}    ${i === 0 && log.length ? (open[`t-${a.id}`] ? '▾' : '▸') : ' '} ${a.isDone || plan.some(t => t.content === task && t.status === 'completed') ? '✔' : '☰'} ${task}`}
              onPress={() => update($, opened, o => ({ ...o, [`t-${a.id}`]: !o[`t-${a.id}`] }))}
            />
          ))}
          {a.doing && !a.isDone && <Text dimColor>{`${pad}        ↳ ${a.doing}`}</Text>}
          {isOpen && (tasks.length === 0 || open[`t-${a.id}`]) && log.map((l, i, all) => (
            <Text dimColor>{`${pad}        ${a.isDone || i < all.length - 1 ? '✔' : '…'} ${l}`}</Text>
          ))}
          {isOpen && sub.map(c => row(c, depth + 1))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Button plain key="plan" label={`${fold.plan ? '▸' : '▾'} Plan (${plan.filter(s => s.status === 'completed').length}/${plan.length})`} onPress={toggle('plan')} />
        {now.length > 0 && (
          <Button plain
            key="assigned"
            label={`  ${open.assigned ? '▸' : '▾'} Assigned (${now.length})`}
            onPress={() => update($, opened, o => ({ ...o, assigned: !o.assigned }))}
          />
        )}
        {!open.assigned && now.map(n => (
          <Box flexDirection="column">
            <Text color="green">{`    ▶ ${n.text}`}</Text>
            {whoHas(n.step.content).map(name => (
              <Text dimColor>{`        ● ${name}`}</Text>
            ))}
          </Box>
        ))}
        {!fold.plan && plan.length === 0 && <Text dimColor>  no todo list yet</Text>}
        {!fold.plan && treeOf(plan).map((n, i) => node(n, String(i), 0))}
        <Button plain key="agents" label={`${fold.agents ? '▸' : '▾'} Agents (${live.length} running)`} onPress={toggle('agents')} />
        {!fold.agents && row(mainRun, 0)}
        {!fold.agents && roots.slice(-10).map(a => row(a, 0))}
      </Box>
    )
  })
}
