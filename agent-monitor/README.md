# agent-monitor

A Claude Code mod that keeps a pane beside the chat showing what is being worked on: the plan, and every agent running it.

The pane opens at session start (reopen it with `/monitor`; `/monitor-clear` empties it). It needs a terminal at least 144 columns wide to open on its own.

## What it shows

- **Plan**: the session's todo list as a tree. Write steps as `1. Build`, `1.1 Routes` (or indent two spaces per level) and parents fold and unfold. Icons: `▶` in progress, `○` pending, `✔` completed, `⊘` blocked. A step is blocked when its text says `blocked`; `blocked by 2.3` clears once step 2.3 completes.
- **Assigned**: the steps someone is working on right now, with who has each one (an agent, or Main).
- **Agents**: Main first, then every subagent as a tree under its parent, with a random first name if it has none. A row reads `name · model (effort) · tokens`; under it are the agent's tasks, each opening to the commands the agent ran for it. Running is blue, paused yellow, done green, killed gray with a strikethrough. Each running row has pause (`‖`), kill (`■`) and remove (`✕`) buttons.

## Linking an agent to a step

Name the steps in the agent's description or prompt: `Step 1.2 check icons`, `[1.2] check icons`, or by Task id, `plan tasks #6, #7 and #8`. The agent then owns those steps. `TaskUpdate` with `owner` (the agent's id or name) gives it a step too. An agent with none takes the first step in progress that nobody owns. When it finishes, its own step is marked completed.

## Tool

`plan_step` sets a step's status by number, for sessions where TodoWrite is not available.

## Limits

Pause holds an agent at its next tool call; a command already running finishes. The plan merges each todo list rewrite, so finished steps stay listed until `/monitor-clear`.
