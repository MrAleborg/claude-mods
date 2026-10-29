export type GitInfo = {
  isRepo: boolean
  branch: string
  untracked: string[]
  files: { path: string; status: string; diff: string }[]
  graph: string
}

export type Issues = {
  isAvailable: boolean
  items: { number: number; title: string; labels: string[] }[]
}

declare module 'claude-code' {
  interface PluginState {
    'git-pane': {
      info: Shaped<GitInfo>
      tab: Shaped<string>
      isDiffOpen: Shaped<boolean>
      isUntrackedOpen: Shaped<boolean>
      collapsed: Shaped<string[]>
      preview: Shaped<{ path: string; text: string }>
      isGraphOpen: Shaped<boolean>
      issues: Shaped<Issues>
      isIssuesOpen: Shaped<boolean>
    }
  }
}
