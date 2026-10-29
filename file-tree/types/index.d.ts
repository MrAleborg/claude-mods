export type Edit = { path: string; saved: string; draft: string }

declare module 'claude-code' {
  interface PluginState {
    'file-tree': {
      files: Shaped<string[]>
      expanded: Shaped<string[]>
      edit: Shaped<Edit>
    }
  }
}
