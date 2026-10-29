export type AgentRun = { id: string; name: string; desc?: string; agentId?: string; doing?: string; task?: string; log?: string[]; parentId?: string; skills?: string[]; tokens?: number; cost?: number; model?: string; effort?: string; state?: 'paused' | 'killed'; isDone: boolean }
export type Step = { content: string; status: 'pending' | 'in_progress' | 'completed' }

declare module 'claude-code' {
  interface PluginState {
    'agent-monitor': { agents: Shaped<AgentRun[]>; steps: Shaped<Step[]>; folded: Shaped<{ plan: boolean; agents: boolean }>; opened: Shaped<Record<string, boolean>>; view: Shaped<{ planRows: number; agentsRows: number; planOff: number; agentsOff: number }>; main: Shaped<{ doing?: string; log?: string[]; tasks?: string[]; skills?: string[]; tokens?: number; cost?: number; model?: string; effort?: string }> }
  }
}
