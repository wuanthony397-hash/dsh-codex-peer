/**
 * The on-disk record of peer runs.
 *
 * Layout under the state directory:
 *
 * ```
 * <stateDir>/
 *   runs.ndjson           append-only run index, newest last
 *   threads.json          { [workingDirectory]: threadId } for resume
 *   runs/<runId>/
 *     prompt.md           exactly what Codex received
 *     events.jsonl        the raw --json event stream
 *     stderr.txt          Codex diagnostics
 *     answer.md           the final message (also written by codex -o)
 *     meta.json           mode, sandbox, cwd, model, argv, outcome, usage
 * ```
 *
 * Writes are best-effort after `ensure()` has proven the directory writable:
 * a failing ledger append must never fail the peer run itself, so the runner
 * records the failure as a note instead.
 *
 * @module dsh-codex-peer/ledger
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A sortable, collision-resistant run id.
 * @param date - the run's start time.
 * @param random - a byte source (injectable for tests).
 * @returns an id such as `codex-20261008-172233-k3f9`.
 */
export function createRunId(date = new Date(), random = randomBytes) {
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  const suffix = random(3).toString('hex').slice(0, 4)
  return `codex-${stamp}-${suffix}`
}

/** Write text through a temporary file so readers never see a half file. */
export function writeFileAtomic(path, text) {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text, 'utf8')
  renameSync(temporary, path)
}

/** Read JSON, returning the fallback when the file is missing or corrupt. */
export function readJsonSafe(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * Create the ledger bound to one state directory.
 * @param options - `dir` (absolute state directory), `clock` (injectable).
 * @returns the ledger API. `ensure()` must run before any run is recorded.
 */
export function createLedger(options) {
  const dir = options.dir
  const clock = typeof options.clock === 'function' ? options.clock : () => new Date()
  const runsDir = join(dir, 'runs')
  const indexPath = join(dir, 'runs.ndjson')
  const threadsPath = join(dir, 'threads.json')

  const ledger = {
    dir,
    runsDir,
    indexPath,
    threadsPath,
    /** Create the state directory tree. Throws when the location is unusable. */
    ensure() {
      mkdirSync(runsDir, { recursive: true })
      if (!statSync(runsDir).isDirectory()) throw new Error(`codex-peer state directory is not a directory: ${runsDir}`)
      return dir
    },
    runDir(runId) {
      return join(runsDir, runId)
    },
    runPath(runId, file) {
      return join(runsDir, runId, file)
    },
    /** Create one run's artifact directory. */
    createRunDir(runId) {
      const path = ledger.runDir(runId)
      mkdirSync(path, { recursive: true })
      return path
    },
    /** Append one JSON record to the run index. */
    appendRun(record) {
      appendFileSync(indexPath, `${JSON.stringify(record)}\n`, 'utf8')
      return record
    },
    /**
     * Read the run index, newest first.
     * @param limit - maximum records returned.
     * @returns the records with their artifact directory attached.
     */
    listRuns(limit = 10) {
      let text = ''
      try {
        text = readFileSync(indexPath, 'utf8')
      } catch {
        return []
      }
      const records = []
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          records.push(JSON.parse(line))
        } catch {
          // A torn final line from an interrupted write is not fatal.
        }
      }
      records.reverse()
      return (limit <= 0 ? records : records.slice(0, limit)).map((record) => ({
        ...record,
        runDir: record.runId === undefined ? undefined : ledger.runDir(record.runId),
      }))
    },
    /** @returns the thread a working directory last used, if any. */
    lastThread(cwd) {
      const threads = readJsonSafe(threadsPath, {})
      const key = normalizeCwd(cwd)
      return typeof threads[key] === 'string' ? threads[key] : undefined
    },
    /** Remember the thread a working directory last used. */
    setLastThread(cwd, threadId) {
      if (typeof threadId !== 'string' || threadId === '') return
      const threads = readJsonSafe(threadsPath, {})
      threads[normalizeCwd(cwd)] = threadId
      threads.updatedAt = clock().toISOString()
      writeFileAtomic(threadsPath, `${JSON.stringify(threads, null, 2)}\n`)
    },
    /** @returns every remembered working directory, newest first. */
    listThreads() {
      const threads = readJsonSafe(threadsPath, {})
      return Object.entries(threads)
        .filter(([key, value]) => key !== 'updatedAt' && typeof value === 'string')
        .map(([cwd, threadId]) => ({ cwd, threadId }))
    },
    exists() {
      return existsSync(runsDir)
    },
  }
  return ledger
}

/** Working directories are compared case-insensitively on Windows. */
export function normalizeCwd(cwd) {
  const value = String(cwd ?? '').replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? value.toLowerCase() : value
}
