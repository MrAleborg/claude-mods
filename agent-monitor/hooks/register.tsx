import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRun, Step } from '../types'

const PANE = 'agent-monitor'
const agents = atom({ plugin: 'agent-monitor', key: 'agents' } as const, [], { shape: 'agents-3' })
const steps = atom({ plugin: 'agent-monitor', key: 'steps' } as const, [], { shape: 'steps-1' })

const folded = atom({ plugin: 'agent-monitor', key: 'folded' } as const, { plan: false, agents: false }, { shape: 'folded-1' })

// One line on what a tool call does: the tool plus its most telling argument.
const gist = (e: Record<string, unknown>) => {
  const arg = e.command ?? e.file_path ?? e.pattern ?? e.query ?? e.url ?? e.description ?? ''

  return `${String(e.tool)} ${String(arg).replace(/\s+/g, ' ').slice(0, 60)}`.trim()
}

// Each section is its own box: a height in rows and a scroll offset, adjusted by the +/- buttons and the wheel.
const view = atom({ plugin: 'agent-monitor', key: 'view' } as const, { planRows: 10, agentsRows: 12, planOff: 0, agentsOff: 0 }, { shape: 'view-1' })
// Line counts of the two boxes as last drawn; read by the scroll hook, so a plain variable (no redraw).
const lens = { plan: 0, agents: 0 }

const opened = atom({ plugin: 'agent-monitor', key: 'opened' } as const, {}, { shape: 'opened-1' })

type Node = { step: Step; text: string; kids: Node[] }

// TodoWrite is flat, so depth comes from a convention in the text: two spaces of indent per level, or a dotted number ("1.2 ...").
// shortcut: no explicit parent ids; a step's parent is the nearest earlier step that is shallower.
const depthOf = (c: string) => {
  const m = /^( *)(?:(\d+(?:\.\d+)*)[.)]?\s+|[-*]\s+)?(.*)$/s.exec(c) as RegExpExecArray

  return { depth: Math.max(Math.floor(m[1].length / 2), m[2] ? m[2].split('.').length - 1 : 0), text: m[3] }
}

// "Step 1.2 ..." or "[1.2] ..." in an agent's description or prompt names the plan step it works on;
// once "task" is said, every "#6" names a task too ("plan tasks #6, #7 and #8").
const stepRefs = (text: string) => [
  ...[...text.matchAll(/(?:\bsteps?\s*|\btasks?\s*#?|^\s*\[)(\d+(?:\.\d+)*)/gim)].map(m => m[1] as string),
  ...(/\btasks?\b/i.test(text) ? [...text.matchAll(/#(\d+)\b/g)].map(m => m[1] as string) : []),
]
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

// A step with an owner (TaskUpdate: agent id or name) is that agent's alone; else it is the step the agent was spawned on.
const owns = (a: AgentRun, s: Step) => (s.owner ? s.owner === a.id || s.owner === a.agentId || s.owner === a.name : a.task === s.content)

// The main session's tasks: steps in progress that no running agent has, remembered so finished ones stay listed.
const claimed = (plan: Step[], runs: AgentRun[], prev: string[] = []) => {
  const now = treeOf(plan)
    .flatMap(flat)
    .filter(n => !n.kids.length && n.step.status === 'in_progress' && !n.step.owner && !runs.some(a => owns(a, n.step)))
    .map(n => n.step.content)

  return [...prev, ...now.filter(c => !prev.includes(c))].slice(-30)
}

// USD per million tokens (input, output) by model family; cache reads cost 0.1x input, cache writes 1.25x.
// shortcut: assumed list prices matched by name, not read from the engine; check them against your plan and edit here.
const RATES: [RegExp, number, number][] = [[/opus/i, 15, 75], [/sonnet|fable/i, 3, 15], [/haiku/i, 1, 5]]

// An agent's session: size (the last response's tokens), model, and estimated cost (every response, priced by its own model), from its transcript.
// shortcut: a transcript over 4 MiB cannot be read, so its values stay at the last read; messages are told apart by id, so a repeated line counts once.
const sessionOf = async ($: any, path: string): Promise<{ tokens: number; model?: string; cost: number } | undefined> => {
  try {
    const text: string = await $.fs.read(path)
    const seen = new Set<string>()
    let tokens = 0
    let model: string | undefined
    let cost = 0
    for (const line of text.split('\n')) {
      const at = line.indexOf('"usage":{')
      if (at < 0) continue
      const id = /"id":"(msg_[^"]+)"/.exec(line)?.[1]
      if (id) {
        if (seen.has(id)) continue
        seen.add(id)
      }
      const u = line.slice(at, at + 400)
      const n = (k: string) => Number(new RegExp(`"${k}":(\\d+)`).exec(u)?.[1] ?? 0)
      const m = /"model":"([^"]+)"/.exec(line)?.[1]
      const [inp, out, w, r] = [n('input_tokens'), n('output_tokens'), n('cache_creation_input_tokens'), n('cache_read_input_tokens')]
      const [, pin, pout] = RATES.find(([re]) => m && re.test(m)) ?? [, 0, 0]
      cost += ((inp + 1.25 * w + 0.1 * r) * pin + out * pout) / 1e6
      tokens = inp + w + r + out
      model = m ?? model
    }

    return tokens ? { tokens, model, cost } : undefined
  } catch {
    return undefined
  }
}
const usd = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`
const kilo = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))
const addSkill = (list: string[] = [], s: string) => [...list.filter(x => x !== s), s].slice(-5)

const MARK = { completed: '✔', in_progress: '▶', pending: '○' } as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'monitor', description: 'Show running agents and plan progress in a pane' })
    await $.tool.register({
      name: 'plan_step',
      description: 'Set the status of a plan step shown in the agent-monitor pane, by its number (e.g. "1.2"). Pass title to create the step when it is not in the plan yet.',
      inputSchema: {
        type: 'object',
        properties: { step: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, title: { type: 'string' } },
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
    const { step, status, title } = e as unknown as { step: string; status: Step['status']; title?: string }
    let hit = false
    await update($, steps, old => {
      // A step is found by its number, its Task id, or its title, so a title never adds a second copy of a step.
      const same = (t: Step) => numberOf(t.content) === step || t.id === step || (!!title && depthOf(t.content).text === depthOf(title).text)
      const next = old.map(t => (same(t) ? ((hit = true), { ...t, status }) : t))

      // A title may already carry its number ("1.1 Touch files", "1. Build"); it is not added twice.
      return hit || !title ? next : [...next, { content: numberOf(title) === step ? title : `${step} ${title}`, status }]
    })
    hit ||= !!title

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
    // Steps named by number (or Task id) in the description or prompt; else the first step in progress at spawn (a guess).
    const plan = await read($, steps)
    const refs = new Set([...stepRefs(e.description), ...stepRefs(e.prompt)])
    const named = plan.filter(t => refs.has(numberOf(t.content) ?? '') || (!!t.id && refs.has(t.id)))
    const task = named[0]?.content ?? plan.find(t => t.status === 'in_progress' && !t.owner)?.content
    // tool_use_id can be empty for a resumed run; every Button needs a non-empty key.
    // An unnamed agent gets a random first name, one not already on the list while any are left.
    const id = e.tool_use_id || `spawn-${await $.clock.now()}`
    // Assigning an agent starts its step, so the Assigned section picks it up.
    // A step the agent was given by name becomes its own (unless already owned); a guessed one stays unowned.
    const owned = new Set(named.map(t => t.content))
    const given = new Set([...owned, ...(task ? [task] : [])])
    await update($, steps, old =>
      old.map(t => (given.has(t.content) ? { ...t, owner: owned.has(t.content) ? t.owner ?? id : t.owner, status: t.status === 'pending' ? 'in_progress' as const : t.status } : t)),
    )
    // The name is picked inside the update, so parallel spawns (retried on a version clash) never share one.
    await update($, agents, list => {
      const used = new Set(list.map(a => a.name))
      const free = NAMES.filter(n => !used.has(n))
      const pool = free.length ? free : NAMES
      const name = e.name ?? `${pool[Math.floor(Math.random() * pool.length)]}${free.length ? '' : `-${used.size}`}`
      const run: AgentRun = { model: e.model ?? e.parentModel, id, name, desc: e.description, task, parentId: e.parentAgentId, isDone: false }

      return [...list, run].slice(-50)
    })

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // Pause is soft: the agent is held at its next tool call; a call already running finishes.
    // shortcut: the hook's own budget may run out on a long pause; upgrade if the engine adds a real pause.
    while (e.agentId && (await read($, agents)).find(a => a.agentId === e.agentId)?.state === 'paused') {
      await $.clock.sleep(500, { signal: next.signal })
    }

    const skill = e.tool === 'Skill' ? String((e as unknown as { skill?: string }).skill ?? '') : ''
    if (skill) {
      if (e.agentId) await update($, agents, list => list.map(a => (a.agentId === e.agentId ? { ...a, skills: addSkill(a.skills, skill) } : a)))
    }

    if (!e.agentId) {
      const doing = gist(e)
      const [plan, runs] = [await read($, steps), await read($, agents)]
      await update($, main, m => ({ ...m, doing, tasks: claimed(plan, runs, m.tasks) }))
    }

    if (e.agentId) {
      const doing = gist(e)
      // Each call is filed under the step the agent is on: its first owned step not yet completed.
      const plan = await read($, steps)
      const onTask = (a: AgentRun) => plan.find(t => owns(a, t) && t.status !== 'completed')?.content ?? a.task
      await update($, agents, list => list.map(a => (a.agentId === e.agentId ? { ...a, doing, log: [...(a.log ?? []), { task: onTask(a), line: doing }].slice(-30) } : a)))
    }

    const out = await next(e)
    // Task tools change one task at a time and return the id only in the result, so the plan is built from the answered call.
    // shortcut: Task tasks are flat (no nesting) unless the subject carries "1.2 ..." numbering.
    const input = e as unknown as { tool: string; taskId?: string; subject?: string; owner?: string; status?: Step['status'] | 'deleted' }
    const task = (out as { result?: { task?: { id?: string; subject?: string } } }).result?.task
    if (e.tool === 'TaskCreate' && task?.id) {
      const step: Step = { id: task.id, content: task.subject ?? input.subject ?? '', status: 'pending' }
      await update($, steps, old => [...old, step].slice(-100))
    }
    if (e.tool === 'TaskUpdate' && input.taskId) {
      await update($, steps, old =>
        input.status === 'deleted'
          ? old.filter(t => t.id !== input.taskId)
          : old.map(t => (t.id === input.taskId ? { ...t, content: input.subject ?? t.content, owner: input.owner ?? t.owner, status: input.status ?? t.status } as Step : t)),
      )
      const [plan, runs] = [await read($, steps), await read($, agents)]
      await update($, main, m => ({ ...m, tasks: claimed(plan, runs, m.tasks) }))
    }

    return out
  })

  // The classic events carry the transcript path; a subagent's lives beside the session's, under subagents/.
  on('classic.PostToolUse', async ($, e, next) => {
    const path = e.agent_id ? `${e.transcript_path.replace(/\.jsonl$/, '')}/subagents/agent-${e.agent_id}.jsonl` : e.transcript_path
    const effort = e.effort?.level
    const ses = await sessionOf($, path)
    if (ses || effort) {
      if (e.agent_id) await update($, agents, list => list.map(a => (a.agentId === e.agent_id ? { ...a, ...ses, effort: effort ?? a.effort } : a)))
      else await update($, main, m => ({ ...m, ...ses, effort: effort ?? m.effort }))
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
      await update($, steps, old => old.map(t => (t.content === done.task && owns(done, t) ? { ...t, status: 'completed' as const } : t)))
    }

    return next(e)
  })

  // The wheel scrolls the box under the pointer; elsewhere the pane's own window takes it.
  // shortcut: keys scroll nothing in a box, wheel only; upgrade if a focused box is wanted.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!e.pointer) return next(e)
    const [v, fold] = [await read($, view), await read($, folded)]
    // Body rows: header, bordered box (h + 2), header, bordered box.
    const hPlan = Math.min(v.planRows, Math.max(lens.plan, 1))
    const hAgents = Math.min(v.agentsRows, Math.max(lens.agents, 1))
    const planEnd = 1 + (fold.plan ? 0 : hPlan + 2)
    const agentsStart = planEnd + 1
    const r = e.pointer.row
    const target = !fold.plan && r >= 1 && r < planEnd ? 'plan' : !fold.agents && r >= agentsStart + 1 && r < agentsStart + 1 + hAgents + 2 ? 'agents' : undefined
    if (!target) return next(e)
    const [offKey, len, hh] = target === 'plan' ? ['planOff', lens.plan, hPlan] as const : ['agentsOff', lens.agents, hAgents] as const
    await update($, view, x => ({ ...x, [offKey]: Math.max(0, Math.min(Math.max(0, len - hh), x[offKey] + e.by)) }))

    return { deny: 'scrolled a box' }
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
    const whoHas = (s: Step) => [...runs.filter(a => !a.isDone && owns(a, s)).map(a => a.name), ...(liveMain.includes(s.content) ? ['Main'] : [])]
    const now = treeOf(plan).flatMap(flat).filter(n => n.step.status !== 'completed' && whoHas(n.step).length > 0)

    const status = (n: Node) => (n.kids.length && leaves(n).every(x => x === 'completed') ? 'completed' : n.step.status)
    const byNum = new Map(treeOf(plan).flatMap(flat).map(n => [numberOf(n.step.content), n] as const))
    // Plan nodes are open unless toggled shut.
    const node = (n: Node, path: string, depth: number): unknown[] => {
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
        return [<Text dimColor={st === 'completed'} color={blocked ? 'red' : undefined}>{`${pad}  ${icon} ${label}`}</Text>]
      }
      const done = leaves(n).filter(x => x === 'completed').length

      return [
        <Button plain
          key={key}
          label={`${pad}${open[key] ? '▸' : '▾'} ${icon} ${label} (${done}/${leaves(n).length})`}
          onPress={() => update($, opened, o => ({ ...o, [key]: !o[key] }))}
        />,
        ...(open[key] ? [] : n.kids.flatMap((k, i) => node(k, `${path}.${i}`, depth + 1))),
      ]
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
    const mainRun: AgentRun = { id: 'main', name: 'Main', doing: mainState.doing, tokens: mainState.tokens, cost: mainState.cost, effort: mainState.effort, model: mainState.model, isDone: false }
    // A step an agent ever owned (running or done) is listed under that agent alone.
    // Only leaf steps: a step remembered before it had substeps is a parent now.
    const leafSteps = new Set(treeOf(plan).flatMap(flat).filter(n => !n.kids.length).map(n => n.step.content))
    const mainTasks = (mainState.tasks ?? []).filter(c => leafSteps.has(c) && plan.some(t => t.content === c && !t.owner && !runs.some(a => owns(a, t))))
    const kids = (a: AgentRun) => (a.agentId ? runs.filter(c => c.parentId === a.agentId) : [])
    const roots = runs.filter(a => !a.parentId || !runs.some(p => p.agentId === a.parentId))
    // Subagents hang under their parent and show while the parent is open.
    const row = (a: AgentRun, depth: number): unknown[] => {
      const pad = '  '.repeat(depth)
      const isMain = a.id === 'main'
      const sub = isMain ? roots.slice(-10) : kids(a)
      const tone = toneOf(a)
      const log = isMain ? [] : a.log ?? []
      // Agents open one level by default: the task shows, its commands stay folded.
      const isOpen = open[a.id] ?? true
      const owned = plan.filter(t => owns(a, t)).map(t => t.content)
      const tasks = isMain ? mainTasks : owned.length || !a.task ? owned : [a.task]
      const skills = a.skills ?? []
      const hasMore = tasks.length > 0 || log.length > 0 || sub.length > 0 || skills.length > 0

      return [
        <Box>
          <Button plain
            key={`agent-${a.id}`}
            onPress={() => update($, opened, o => ({ ...o, [a.id]: !(o[a.id] ?? true) }))}
          >
            <Text color={tone} strikethrough={a.state === 'killed'}>
              {`${pad}  ${hasMore ? (isOpen ? '▾' : '▸') : ' '} ${a.isDone ? '✔' : isMain && !a.doing ? '○' : '●'} ${a.name}${a.model ? ` · ${a.model}${a.effort ? ` (${a.effort})` : ''}` : ''}${a.tokens ? ` · ${kilo(a.tokens)} tok` : ''}`}
            </Text>
          </Button>
          {a.agentId && !a.isDone && (
            <Button plain key={`pause-${a.id}`} label={a.state === 'paused' ? ' ▶' : ' ‖'} onPress={() => setState(a, a.state === 'paused' ? undefined : 'paused')} />
          )}
          {a.agentId && !a.isDone && <Button plain key={`kill-${a.id}`} label=" ■" onPress={() => kill(a)} />}
          {!isMain && <Button plain key={`rm-${a.id}`} label=" ✕" onPress={() => update($, agents, l => l.filter(x => x.id !== a.id))} />}
        </Box>,
        ...(isOpen && skills.length ? [<Text dimColor>{`${pad}      ⚙ ${skills.join(', ')}`}</Text>] : []),
        ...(isOpen ? tasks.flatMap((task, i) => {
          // Each task folds its own calls; calls filed under no listed task show under the agent.
          const mine = log.filter(l => l.task === task)
          const k = `t-${a.id}-${i}`
          const done = (a.isDone && task === a.task) || plan.some(t => t.content === task && t.status === 'completed')

          return [
            <Button plain
              key={`task-${a.id}-${i}`}
              label={`${pad}    ${mine.length ? (open[k] ? '▾' : '▸') : ' '} ${done ? '✔' : '☰'} ${task}`}
              onPress={() => update($, opened, o => ({ ...o, [k]: !o[k] }))}
            />,
            ...(open[k] ? mine.map(l => <Text dimColor>{`${pad}        ${a.isDone || l !== log[log.length - 1] ? '✔' : '…'} ${l.line}`}</Text>) : []),
          ]
        }) : []),
        ...(a.doing && !a.isDone ? [<Text dimColor>{`${pad}        ↳ ${a.doing}`}</Text>] : []),
        ...(isOpen ? log.filter(l => !l.task || !tasks.includes(l.task)).map(l => (
          <Text dimColor>{`${pad}        ${a.isDone || l !== log[log.length - 1] ? '✔' : '…'} ${l.line}`}</Text>
        )) : []),
        ...(isOpen ? sub.flatMap(c => row(c, depth + 1)) : []),
      ]
    }

    const v = await read($, view)
    const planLines: unknown[] = [
      ...(now.length > 0
        ? [
            <Button plain
              key="assigned"
              label={`  ${open.assigned ? '▸' : '▾'} Assigned (${now.length})`}
              onPress={() => update($, opened, o => ({ ...o, assigned: !o.assigned }))}
            />,
          ]
        : []),
      ...(open.assigned ? [] : now.flatMap(n => [
        <Text color="green">{`    ▶ ${n.text}`}</Text>,
        ...whoHas(n.step).map(name => <Text dimColor>{`        ● ${name}`}</Text>),
      ])),
      ...(plan.length === 0 ? [<Text dimColor>  no todo list yet</Text>] : []),
      ...treeOf(plan).flatMap((n, i) => node(n, String(i), 0)),
    ]
    const total = (mainState.cost ?? 0) + runs.reduce((t, a) => t + (a.cost ?? 0), 0)
    const agentLines: unknown[] = row(mainRun, 0)
    lens.plan = planLines.length
    lens.agents = agentLines.length

    // A box: header with fold, - and + resize buttons, then a fixed-height window over its lines.
    const box = (k: 'plan' | 'agents', title: string, lines: unknown[], rows: number, off: number) => {
      const key = k === 'plan' ? 'planRows' : 'agentsRows'
      const resize = (d: number) => () => update($, view, x => ({ ...x, [key]: Math.max(3, Math.min(60, x[key] + d)) }))
      const hh = Math.min(rows, Math.max(lines.length, 1))
      const start = Math.min(off, Math.max(0, lines.length - hh))

      return (
        <Box flexDirection="column">
          <Box>
            <Button plain key={k} label={`${fold[k] ? '▸' : '▾'} ${title}`} onPress={toggle(k)} />
            <Button plain key={`${k}-less`} label=" －" onPress={resize(-3)} />
            <Button plain key={`${k}-more`} label=" ＋" onPress={resize(3)} />
            {lines.length > hh && <Text dimColor>{` ${start + 1}-${start + hh}/${lines.length}`}</Text>}
          </Box>
          {!fold[k] && (
            <Box flexDirection="column" height={hh + 2} overflow="hidden" borderStyle="round" borderDimColor>
              {lines.slice(start, start + hh)}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {box('plan', `Plan (${plan.filter(s => s.status === 'completed').length}/${plan.length})`, planLines, v.planRows, v.planOff)}
        {box('agents', `Agents (${live.length} running)${total ? ` · run ~${usd(total)}` : ''}`, agentLines, v.agentsRows, v.agentsOff)}
      </Box>
    )
  })
}
