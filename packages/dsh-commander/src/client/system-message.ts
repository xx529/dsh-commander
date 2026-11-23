/**
 * Panel message interpretation for M3 (m2m3-contract-patch §3.1 / §2.6).
 *
 * The commander session receives ordinary user messages injected by the Host:
 *   `[session-reply] <last assistant text>\n---\ntaskId=… sessionId=…`
 *   `[board-edit] taskId=… by=user\n…\n---\neditIds=…`
 * The panel renders them as work-report / board-edit summary cards instead of
 * raw bubbles. Pure so `tests/client/system-message.test.ts` can pin it.
 */

/** Presentation class of one commander-session message. */
export type CommanderMessageKind = 'plain' | 'session-reply' | 'board-edit'

/** Interpreted view of one message bubble. */
export interface InterpretedCommanderMessage {
  kind: CommanderMessageKind
  /** Body without the marker line / metadata trailer. */
  body: string
  /** Metadata lines after the `---` separator (key=value lines). */
  meta: string[]
}

const SESSION_REPLY_MARKER = '[session-reply]'
const BOARD_EDIT_MARKER = '[board-edit]'

/** Interpret one commander-session message for rendering. */
export function interpretCommanderMessage(role: string, text: string): InterpretedCommanderMessage {
  if (role !== 'user') return { kind: 'plain', body: text, meta: [] }
  if (text.startsWith(SESSION_REPLY_MARKER)) {
    return splitInjectedMessage(text.slice(SESSION_REPLY_MARKER.length), 'session-reply')
  }
  if (text.startsWith(BOARD_EDIT_MARKER)) {
    return splitInjectedMessage(text.slice(BOARD_EDIT_MARKER.length), 'board-edit')
  }
  return { kind: 'plain', body: text, meta: [] }
}

function splitInjectedMessage(rest: string, kind: CommanderMessageKind): InterpretedCommanderMessage {
  const normalized = rest.replace(/^\s+/u, '')
  const separator = normalized.indexOf('\n---')
  const body = separator === -1 ? normalized : normalized.slice(0, separator)
  const trailer = separator === -1 ? '' : normalized.slice(separator + '\n---'.length)
  const meta = trailer
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line !== '' && line !== '---')
  return {
    kind,
    body: body.trim(),
    meta,
  }
}

/** Parse `key=value` metadata lines into a record (first occurrence wins). */
export function parseMetadata(meta: readonly string[]): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (const line of meta) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    if (parsed[key] !== undefined) continue
    parsed[key] = line.slice(index + 1).trim()
  }
  return parsed
}
