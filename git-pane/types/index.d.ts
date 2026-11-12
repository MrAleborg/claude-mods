export type GitInfo = {
  isRepo: boolean
  branch: string
  untracked: string[]
  // added/deleted are null for a binary file
  files: { path: string; status: string; added: number | null; deleted: number | null }[]
  // the selected file's diff, the only one loaded
  diff: { path: string; text: string }
  graph: string
}

export type Issues = {
  isAvailable: boolean
  // open issues on GitHub; items holds the newest 30
  total: number
  items: { number: number; title: string; labels: string[]; parent: number | null; blockedBy: number[] }[]
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
      openIssues: Shaped<number[]>
    }
  }
}
