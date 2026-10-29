export type AgentRun = { id: string; name: string; desc?: string; agentId?: string; doing?: string; task?: string; log?: string[]; parentId?: string; state?: 'paused' | 'killed'; isDone: boolean }
export type Step = { content: string; status: 'pending' | 'in_progress' | 'completed' }

declare module 'claude-code' {
  interface PluginState {
    'agent-monitor': { agents: Shaped<AgentRun[]>; steps: Shaped<Step[]>; folded: Shaped<{ plan: boolean; agents: boolean }>; opened: Shaped<Record<string, boolean>>; main: Shaped<{ doing?: string; log?: string[]; tasks?: string[] }> }
  }
}
