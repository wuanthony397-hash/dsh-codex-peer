/**
 * Reading the `codex exec --json` event stream.
 *
 * Codex prints one JSON object per line on stdout. This module owns the whole
 * interpretation: splitting partial chunks into lines, folding events into a
 * run report (thread id, usage, final answer, command and file-change log), and
 * rendering the human-readable progress lines that background readers see
 * through `job_output`.
 *
 * Every function here is pure or self-contained so the tests can drive it with
 * recorded event streams and no Codex process.
 *
 * @module dsh-codex-peer/events
 */

/**
 * Split streamed text into complete lines.
 * @returns `push(chunk)` for complete lines and `flush()` for the trailing remainder.
 */
export function createLineSplitter() {
  let buffered = ''
  return {
    /** @param chunk - newly arrived text. @returns the complete lines it completed. */
    push(chunk) {
      buffered += chunk
      const lines = []
      let index = buffered.indexOf('\n')
      while (index >= 0) {
        lines.push(buffered.slice(0, index))
        buffered = buffered.slice(index + 1)
        index = buffered.indexOf('\n')
      }
      return lines
    },
    /** @returns the unterminated remainder, if any. */
    flush() {
      const rest = buffered
      buffered = ''
      return rest
    },
  }
}

/**
 * A bounded, append-only progress log that background job readers can pull.
 * @param options - `maxLines` bounds memory; trimming marks later reads lossy.
 * @returns `{ push, text, read, lineCount }`.
 */
export function createProgressLog(options = {}) {
  const maxLines = typeof options.maxLines === 'number' && options.maxLines > 0 ? options.maxLines : 400
  let lines = []
  let trimmed = 0
  const text = () => (lines.length === 0 ? '' : `${lines.join('\n')}\n`)
  return {
    /** @param entry - one progress line; empty values are ignored. */
    push(entry) {
      const value = typeof entry === 'string' ? entry.trimEnd() : ''
      if (value === '') return
      lines.push(value)
      if (lines.length > maxLines) {
        trimmed += lines.length - maxLines
        lines = lines.slice(lines.length - maxLines)
      }
    },
    /** @returns the retained log. */
    text,
    /** @returns how many lines were dropped to stay bounded. */
    trimmedLines() {
      return trimmed
    },
    /**
     * Pull everything after an absolute byte offset, the shape the job
     * registry's output sources expect.
     * @param fromByte - the reader's cursor.
     * @returns `{ text, nextOffset, lossy }`.
     */
    read(fromByte) {
      const buffer = Buffer.from(text(), 'utf8')
      const start = Number.isFinite(fromByte) && fromByte > 0 ? Math.min(fromByte, buffer.length) : 0
      return {
        text: buffer.subarray(start).toString('utf8'),
        nextOffset: buffer.length,
        lossy: trimmed > 0 && start === 0,
      }
    },
  }
}

/**
 * The mutable accumulator for one Codex run.
 * @returns a fresh run report.
 */
export function createRunReport() {
  return {
    threadId: null,
    usage: null,
    answer: '',
    answerSeen: 0,
    commands: [],
    fileChanges: [],
    errors: [],
    notes: [],
    todos: null,
    eventCount: 0,
    parseErrors: 0,
  }
}

/** @returns the first line of a text, clipped for a progress entry. */
function firstLine(text, limit = 160) {
  const line = String(text ?? '')
    .split('\n')
    .find((candidate) => candidate.trim() !== '')
  if (line === undefined) return ''
  const trimmed = line.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed
}

/** @returns a normalized usage block from a Codex `usage` object. */
function normalizeUsage(usage) {
  const pick = (key) => (typeof usage?.[key] === 'number' ? usage[key] : 0)
  const input = pick('input_tokens')
  const output = pick('output_tokens')
  return {
    inputTokens: input,
    cachedInputTokens: pick('cached_input_tokens'),
    cacheWriteInputTokens: pick('cache_write_input_tokens'),
    outputTokens: output,
    reasoningOutputTokens: pick('reasoning_output_tokens'),
    totalTokens: input + output,
  }
}

/**
 * One rendered usage line.
 * @param usage - normalized usage.
 * @returns the progress text.
 */
export function formatUsage(usage) {
  const cached = usage.cachedInputTokens > 0 ? `, cached ${usage.cachedInputTokens}` : ''
  const reasoning = usage.reasoningOutputTokens > 0 ? `, reasoning ${usage.reasoningOutputTokens}` : ''
  return `tokens: in ${usage.inputTokens}${cached} · out ${usage.outputTokens}${reasoning}`
}

/**
 * Fold one parsed event into the report, and describe it for the progress log.
 * @param report - the run report to mutate.
 * @param event - one parsed JSONL event.
 * @returns the progress line, or null when the event is not worth a line.
 */
export function applyEvent(report, event) {
  report.eventCount += 1
  const type = typeof event?.type === 'string' ? event.type : 'unknown'
  if (type === 'thread.started') {
    report.threadId = typeof event.thread_id === 'string' ? event.thread_id : report.threadId
    return `thread ${report.threadId ?? '(unknown)'} started`
  }
  if (type === 'turn.started') return null
  if (type === 'turn.completed') {
    report.usage = normalizeUsage(event.usage)
    return `turn completed · ${formatUsage(report.usage)}`
  }
  if (type === 'turn.failed') {
    const message = event.error?.message ?? event.message ?? 'turn failed'
    report.errors.push(String(message))
    return `turn failed: ${firstLine(message)}`
  }
  if (type === 'error') {
    const message = event.message ?? event.error?.message ?? 'error'
    report.errors.push(String(message))
    return `error: ${firstLine(message)}`
  }
  if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
    return applyItem(report, event.item, type === 'item.completed')
  }
  return null
}

/** @returns the progress line for one item event. */
function applyItem(report, item, completed) {
  const kind = typeof item?.type === 'string' ? item.type : 'item'
  if (kind === 'agent_message') {
    const text = typeof item.text === 'string' ? item.text : ''
    if (text !== '') {
      report.answer = text
      report.answerSeen += 1
    }
    return completed ? `answer: ${firstLine(text)}` : null
  }
  if (kind === 'reasoning') return null
  if (kind === 'command_execution') {
    if (!completed) return null
    const command = firstLine(item.command ?? '', 120)
    const exit = item.exit_code === undefined || item.exit_code === null ? '?' : item.exit_code
    report.commands.push({ command, exitCode: typeof item.exit_code === 'number' ? item.exit_code : null, status: item.status ?? null })
    return `$ ${command} → exit ${exit}`
  }
  if (kind === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : []
    const paths = changes.map((change) => `${change?.kind ?? 'update'} ${change?.path ?? '?'}`)
    if (paths.length > 0) report.fileChanges.push(...paths)
    return `files: ${paths.join(', ') || '(none reported)'}`
  }
  if (kind === 'error') {
    const message = String(item.message ?? 'error')
    report.errors.push(message)
    return `error: ${firstLine(message)}`
  }
  if (kind === 'todo_list') {
    const items = Array.isArray(item.items) ? item.items : []
    report.todos = items
    return `plan: ${items.length} step(s)`
  }
  if (kind === 'mcp_tool_call') return `mcp: ${item.tool ?? '?'}`
  if (kind === 'web_search') return `search: ${firstLine(item.query ?? '')}`
  return completed ? `${kind}` : null
}

/**
 * Parse one JSONL line.
 * @param line - a raw line from stdout.
 * @returns `{ event }` when it parsed, `{ raw }` when it did not.
 */
export function parseEventLine(line) {
  const trimmed = line.trim()
  if (trimmed === '') return { raw: '' }
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed !== null && typeof parsed === 'object') return { event: parsed }
    return { raw: trimmed }
  } catch {
    return { raw: trimmed }
  }
}

/**
 * Build the incremental reader that turns stdout chunks into report updates.
 * @param options - `report` (defaults to a fresh one), `progress` log, `maxLineBytes`.
 * @returns `{ report, progress, push(chunk, channel), flush(), summary() }`.
 */
export function createStreamReader(options = {}) {
  const report = options.report ?? createRunReport()
  const progress = options.progress ?? createProgressLog({ maxLines: options.progressKeepLines })
  const splitter = createLineSplitter()
  const stderrSplitter = createLineSplitter()
  const maxLineBytes = typeof options.maxLineBytes === 'number' ? options.maxLineBytes : 4 * 1024 * 1024

  const handleLine = (raw) => {
    if (Buffer.byteLength(raw, 'utf8') > maxLineBytes) {
      report.notes.push('an event line exceeded the reader limit and was ignored')
      return
    }
    const parsed = parseEventLine(raw)
    if (parsed.event === undefined) {
      if (parsed.raw !== '') {
        report.parseErrors += 1
        progress.push(`stdout: ${firstLine(parsed.raw)}`)
      }
      return
    }
    const entry = applyEvent(report, parsed.event)
    if (entry !== null) progress.push(entry)
  }

  return {
    report,
    progress,
    /**
     * Feed one chunk.
     * @param chunk - the chunk text.
     * @param channel - `stdout` (event stream) or `stderr` (diagnostics).
     */
    push(chunk, channel = 'stdout') {
      if (channel === 'stderr') {
        for (const line of stderrSplitter.push(chunk)) {
          const text = line.trim()
          if (text !== '') progress.push(`stderr: ${firstLine(text)}`)
        }
        return
      }
      for (const line of splitter.push(chunk)) handleLine(line)
    },
    /** Consume any unterminated tail. */
    flush() {
      const tail = splitter.flush()
      if (tail.trim() !== '') handleLine(tail)
      const stderrTail = stderrSplitter.flush()
      if (stderrTail.trim() !== '') progress.push(`stderr: ${firstLine(stderrTail)}`)
    },
    /** @returns the report plus the progress text, for ledger records. */
    summary() {
      return { report, progress: progress.text() }
    },
  }
}
