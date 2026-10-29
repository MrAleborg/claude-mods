import type { ClientModule } from 'claude-code'

type Props = { text: string }
type State = { lines: string[]; row: number; col: number; top: number }

// A small line editor: arrows, Enter (one new line), Backspace/Delete, ctrl+s posts the text.
// shortcut: no selection, undo or wide-character handling; upgrade if real editing is needed.
const Editor: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const view = Math.max(1, surface.rows - 1)

  if (surface.state === undefined) {
    surface.onKey(k => {
      const s = surface.state
      if (!s) return
      if (k.ctrl && k.key === 's') {
        surface.post({ type: 'save', text: s.lines.join('\n') })
        return
      }
      const lines = [...s.lines]
      let { row, col } = s
      const line = lines[row]
      if (k.key === 'return') {
        lines.splice(row, 1, line.slice(0, col), line.slice(col))
        row += 1
        col = 0
      } else if (k.key === 'backspace') {
        if (col > 0) {
          lines[row] = line.slice(0, col - 1) + line.slice(col)
          col -= 1
        } else if (row > 0) {
          col = lines[row - 1].length
          lines.splice(row - 1, 2, lines[row - 1] + line)
          row -= 1
        }
      } else if (k.key === 'delete') {
        if (col < line.length) lines[row] = line.slice(0, col) + line.slice(col + 1)
        else if (row < lines.length - 1) lines.splice(row, 2, line + lines[row + 1])
      } else if (k.key === 'left') {
        if (col > 0) col -= 1
        else if (row > 0) (row -= 1, (col = lines[row].length))
      } else if (k.key === 'right') {
        if (col < line.length) col += 1
        else if (row < lines.length - 1) (row += 1, (col = 0))
      } else if (k.key === 'up') {
        row = Math.max(0, row - 1)
      } else if (k.key === 'down') {
        row = Math.min(lines.length - 1, row + 1)
      } else if (k.key === 'pageup') {
        row = Math.max(0, row - view)
      } else if (k.key === 'pagedown') {
        row = Math.min(lines.length - 1, row + view)
      } else if (k.key === 'home') {
        col = 0
      } else if (k.key === 'end') {
        col = line.length
      } else if (k.key === 'tab') {
        lines[row] = line.slice(0, col) + '  ' + line.slice(col)
        col += 2
      } else if ((k.key.length === 1 || k.key === 'space') && !k.ctrl && !k.meta) {
        const ch = k.key === 'space' ? ' ' : k.key
        lines[row] = line.slice(0, col) + ch + line.slice(col)
        col += 1
      } else {
        return
      }
      col = Math.min(col, lines[row].length)
      const top = row < s.top ? row : row >= s.top + view ? row - view + 1 : s.top
      surface.setState({ lines, row, col, top })
    })
    surface.setState({ lines: props.text.split('\n'), row: 0, col: 0, top: 0 })

    return <Text dimColor>…</Text>
  }

  const { lines, row, col, top } = surface.state
  const isDirty = lines.join('\n') !== props.text

  return (
    <Box flexDirection="column">
      <Text dimColor>
        ctrl+s save · Esc close{isDirty ? ' · ● unsaved' : ''}
      </Text>
      {lines.slice(top, top + view).map((l, i) => {
        const n = top + i
        const gutter = <Text dimColor>{String(n + 1).padStart(4)} </Text>

        return n === row ? (
          <Text>
            {gutter}
            {l.slice(0, col)}
            <Text inverse>{l[col] ?? ' '}</Text>
            {l.slice(col + 1)}
          </Text>
        ) : (
          <Text>
            {gutter}
            {l}
          </Text>
        )
      })}
    </Box>
  )
}

export default Editor
