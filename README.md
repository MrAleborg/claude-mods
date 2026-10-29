# claude-mods

Four Claude Code mods that add panes beside the chat. Each installs on its own.

| Mod | What it does |
| --- | --- |
| `git-pane` | Right pane: current branch, per-file diff tabs with +/- counts, untracked files as a collapsible folder tree with preview, an expandable git graph, and open GitHub issues (via `gh`). |
| `file-tree` | Files pane (folder tree); selecting a file opens a small editor pane (Ctrl+S saves and closes). |
| `agent-monitor` | Pane showing the plan as a tree and every running agent. See `agent-monitor/README.md`. |
| `mcp-pane` | Pane listing the MCP servers connected in this session, each expandable to its tools. |

Panes open at session start on terminals 144 columns wide or more; below that, open them with `/git-pane`, `/file-tree`, `/monitor` or `/mcp-pane`.

## Install

At the prompt of a terminal session:

```
/plugin install git-pane --marketplace MrAleborg/claude-mods
```

From a shell:

```
claude plugin install git-pane --marketplace MrAleborg/claude-mods
```

Replace `git-pane` with `file-tree`, `agent-monitor` or `mcp-pane` for the others. In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `MrAleborg/claude-mods`, then Add plugin.

## Notes

- `git-pane` and `file-tree` read files through git, so they list nothing outside a git repository.
- The editor in `file-tree` is minimal: no selection, undo or search.
