export type Step = { content: string; activeForm: string; status: 'pending' | 'in_progress' | 'completed' }
export type Running = { id: string; label: string }

declare module 'claude-code' {
  interface PluginState {
    'plan-progress': { steps: Step[]; running: Running[] }
  }
}
