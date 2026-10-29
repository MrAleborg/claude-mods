export type Server = { name: string; tools: string[] }

declare module 'claude-code' {
  interface PluginState {
    'mcp-pane': {
      servers: Shaped<Server[]>
      expanded: Shaped<string[]>
    }
  }
}
