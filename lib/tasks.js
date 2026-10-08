/**
 * The shared work list.
 *
 * One file records who is doing what, in what order, and what proves it is
 * done. Both agents read it, the DSH agent writes it, and `codex_plan` fills it
 * from a goal — either with the split the user named or with a split the agents
 * worked out.
 *
 * `tasks.json` is the current state; `tasks.ndjson` is the append-only history
 * of every change, so "who assigned what, when, and on whose authority" stays
 * answerable after the fact.
 *
 * Status vocabulary (deliberately small):
 *
 * | status | meaning |
 * | --- | --- |
 * | `todo` | agreed, not started |
 * | `doing` | someone is on it |
 * | `blocked` | waiting on something; the note says what |
 * | `done` | finished **and** backed by at least one evidence entry |
 * | `unverified` | claimed finished with no evidence — a flag, not a success |
 *
 * @module dsh-codex-peer/tasks
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonSafe, writeFileAtomic } from './ledger.js'

/** Every status a task may hold. */
export const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done', 'unverified']

/** Who owns a task. `shared` means both agents work it; `unassigned` is unresolved. */
export const TASK_OWNERS = ['dsh', 'codex', 'shared', 'unassigned']

/** How a task got its owner. */
export const ASSIGNED_BY = ['user', 'agent', 'routing']

/** The kinds of proof a finished task can carry. */
export const EVIDENCE_KINDS = ['command', 'artifact', 'review', 'note']

/** Statuses that count as finished, with or without proof. */
export const CLOSED_STATUSES = ['done', 'unverified']

/** @returns true when `value` is one of `allowed`. */
function oneOf(allowed, value) {
  return allowed.includes(value)
}

/**
 * Open the work list bound to one state directory.
 *
 * @param options - `dir` (absolute state directory), `now` (injectable clock).
 * @returns the store API.
 */
export function createTaskStore(options) {
  const dir = options.dir
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const file = join(dir, 'tasks.json')
  const historyPath = join(dir, 'tasks.ndjson')

  const empty = () => ({ version: 1, tasks: [], updatedAt: now().toISOString() })

  const read = () => {
    const state = readJsonSafe(file, undefined)
    if (state === undefined || typeof state !== 'object' || !Array.isArray(state.tasks)) return empty()
    return state
  }

  const persist = (state, event) => {
    state.updatedAt = now().toISOString()
    writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`)
    try {
      appendFileSync(historyPath, `${JSON.stringify({ at: state.updatedAt, ...event })}\n`, 'utf8')
    } catch {
      // History is an audit trail, not the state: losing a line must not fail the change.
    }
    return state
  }

  /** @returns the next free `task-<n>` id. */
  const nextId = (state) => {
    let highest = 0
    for (const task of state.tasks) {
      const match = /^task-(\d+)$/.exec(String(task.id))
      if (match !== null) highest = Math.max(highest, Number(match[1]))
    }
    return `task-${highest + 1}`
  }

  const normalizeEvidence = (entry) => {
    const kind = oneOf(EVIDENCE_KINDS, entry?.kind) ? entry.kind : 'note'
    const what = typeof entry?.what === 'string' ? entry.what.trim() : ''
    if (what === '') throw new Error('evidence needs a non-empty "what": the command that ran, the artifact that exists, or the review that was done')
    return {
      at: now().toISOString(),
      by: oneOf(TASK_OWNERS, entry?.by) ? entry.by : 'dsh',
      kind,
      what,
      result: typeof entry?.result === 'string' ? entry.result.trim() : undefined,
      runId: typeof entry?.runId === 'string' ? entry.runId : undefined,
    }
  }

  const store = {
    dir,
    file,
    historyPath,

    /** @returns the whole state object (a copy is not made; treat it as read-only). */
    state: read,

    /**
     * List tasks, oldest first.
     * @param filter - `{ status?, owner?, statuses? }`.
     * @returns the matching tasks.
     */
    list(filter = {}) {
      const tasks = read().tasks
      return tasks.filter((task) => {
        if (filter.status !== undefined && task.status !== filter.status) return false
        if (filter.owner !== undefined && task.owner !== filter.owner) return false
        if (Array.isArray(filter.statuses) && !filter.statuses.includes(task.status)) return false
        return true
      })
    },

    /**
     * Read one task.
     * @param id - the task id.
     * @returns the task, or undefined.
     */
    get(id) {
      return read().tasks.find((task) => task.id === id)
    },

    /**
     * Add tasks to the list.
     *
     * @param drafts - `{ title, owner?, scope?, tags?, acceptance?, assignedBy?, why?, status? }`.
     * @param defaults - `{ mode, budget, approvedAt, assignedBy }` applied to every created task.
     * @returns the created tasks.
     */
    createMany(drafts, defaults = {}) {
      const state = read()
      const created = []
      for (const draft of drafts) {
        const title = typeof draft?.title === 'string' ? draft.title.trim() : ''
        if (title === '') throw new Error('every task needs a non-empty title')
        const owner = oneOf(TASK_OWNERS, draft.owner) ? draft.owner : 'unassigned'
        const task = {
          id: nextId(state),
          title,
          goal: typeof draft.goal === 'string' ? draft.goal.trim() : undefined,
          owner,
          assignedBy: oneOf(ASSIGNED_BY, draft.assignedBy) ? draft.assignedBy : (defaults.assignedBy ?? 'agent'),
          why: typeof draft.why === 'string' ? draft.why.trim() : undefined,
          status: oneOf(TASK_STATUSES, draft.status) ? draft.status : 'todo',
          mode: defaults.mode,
          scope: Array.isArray(draft.scope) ? draft.scope.map(String) : [],
          tags: Array.isArray(draft.tags) ? draft.tags.map(String) : [],
          acceptance: typeof draft.acceptance === 'string' ? draft.acceptance.trim() : '',
          blockedBy: [],
          evidence: [],
          budget: { ...defaults.budget },
          spent: { runs: 0, tokens: 0 },
          codexThreadId: null,
          runs: [],
          approvedAt: defaults.approvedAt ?? null,
          createdAt: now().toISOString(),
          updatedAt: now().toISOString(),
        }
        state.tasks.push(task)
        created.push(task)
      }
      persist(state, { event: 'create', ids: created.map((task) => task.id), mode: defaults.mode, assignedBy: defaults.assignedBy ?? 'agent' })
      return created
    },

    /**
     * Patch one task.
     * @param id - the task id.
     * @param patch - any of `owner`, `status`, `scope`, `tags`, `acceptance`, `note`, `approvedAt`, `codexThreadId`, `blockedBy`.
     * @returns the updated task.
     * @throws when the task does not exist, when a status is unknown, or when `done` is claimed without evidence.
     */
    update(id, patch = {}) {
      const state = read()
      const task = state.tasks.find((candidate) => candidate.id === id)
      if (task === undefined) throw new Error(`unknown task "${id}"; call codex_task action:list to see the ids`)
      if (patch.owner !== undefined) {
        if (!oneOf(TASK_OWNERS, patch.owner)) throw new Error(`unknown owner "${patch.owner}"; use ${TASK_OWNERS.join(', ')}`)
        task.owner = patch.owner
        task.assignedBy = oneOf(ASSIGNED_BY, patch.assignedBy) ? patch.assignedBy : 'user'
      }
      if (patch.status !== undefined) {
        if (!oneOf(TASK_STATUSES, patch.status)) throw new Error(`unknown status "${patch.status}"; use ${TASK_STATUSES.join(', ')}`)
        if (patch.status === 'done' && task.evidence.length === 0) {
          throw new Error(
            `task ${id} cannot be marked done without evidence: record what proves it with codex_task action:record-evidence, or mark it "unverified" and say what is missing`,
          )
        }
        if (patch.status === 'unverified' && typeof patch.note !== 'string') {
          throw new Error(`marking ${id} "unverified" needs a note saying what is missing`)
        }
        task.status = patch.status
      }
      if (Array.isArray(patch.scope)) task.scope = patch.scope.map(String)
      if (Array.isArray(patch.tags)) task.tags = patch.tags.map(String)
      if (Array.isArray(patch.blockedBy)) task.blockedBy = patch.blockedBy.map(String)
      if (typeof patch.acceptance === 'string') task.acceptance = patch.acceptance.trim()
      if (typeof patch.codexThreadId === 'string' || patch.codexThreadId === null) task.codexThreadId = patch.codexThreadId
      if (typeof patch.approvedAt === 'string') task.approvedAt = patch.approvedAt
      if (typeof patch.note === 'string' && patch.note.trim() !== '') task.notes = [...(task.notes ?? []), { at: now().toISOString(), by: patch.by ?? 'dsh', text: patch.note.trim() }]
      task.updatedAt = now().toISOString()
      persist(state, { event: 'update', id, patch: { ...patch, evidence: undefined } })
      return task
    },

    /**
     * Record the proof behind a task.
     * @param id - the task id.
     * @param entry - `{ kind, what, result?, by?, runId? }`.
     * @param options - `{ status? }` applied together with the entry.
     * @returns the updated task.
     */
    recordEvidence(id, entry, options = {}) {
      const state = read()
      const task = state.tasks.find((candidate) => candidate.id === id)
      if (task === undefined) throw new Error(`unknown task "${id}"; call codex_task action:list to see the ids`)
      task.evidence = [...task.evidence, normalizeEvidence(entry)]
      if (options.status !== undefined) {
        if (!oneOf(TASK_STATUSES, options.status)) throw new Error(`unknown status "${options.status}"; use ${TASK_STATUSES.join(', ')}`)
        task.status = options.status
      } else if (task.status === 'doing' || task.status === 'todo') {
        task.status = 'doing'
      }
      task.updatedAt = now().toISOString()
      persist(state, { event: 'evidence', id, kind: task.evidence.at(-1).kind })
      return task
    },

    /**
     * Raise or lower a task's Codex budget.
     * @param id - the task id.
     * @param budget - `{ maxRuns?, maxTokens? }`; omitted fields keep their value.
     * @returns the updated task.
     */
    setBudget(id, budget) {
      const state = read()
      const task = state.tasks.find((candidate) => candidate.id === id)
      if (task === undefined) throw new Error(`unknown task "${id}"; call codex_task action:list to see the ids`)
      const maxRuns = Number.isFinite(budget?.maxRuns) ? Math.max(0, Math.trunc(budget.maxRuns)) : task.budget.maxRuns
      const maxTokens = Number.isFinite(budget?.maxTokens) ? Math.max(0, Math.trunc(budget.maxTokens)) : task.budget.maxTokens
      task.budget = { maxRuns, maxTokens }
      task.updatedAt = now().toISOString()
      persist(state, { event: 'budget', id, budget: task.budget })
      return task
    },

    /**
     * Charge one Codex run to a task.
     * @param id - the task id.
     * @param run - `{ runId, tokens?, threadId? }`.
     * @returns the updated task.
     */
    recordRun(id, run) {
      const state = read()
      const task = state.tasks.find((candidate) => candidate.id === id)
      if (task === undefined) return undefined
      task.spent = {
        runs: task.spent.runs + 1,
        tokens: task.spent.tokens + (Number.isFinite(run?.tokens) ? run.tokens : 0),
      }
      if (typeof run?.runId === 'string') task.runs = [...task.runs, run.runId]
      if (typeof run?.threadId === 'string' && run.threadId !== '') task.codexThreadId = run.threadId
      task.updatedAt = now().toISOString()
      persist(state, { event: 'run', id, runId: run?.runId, tokens: run?.tokens })
      return task
    },

    /**
     * Whether a task may still spend a Codex run.
     * @param id - the task id.
     * @returns `{ ok, reason?, task? }`; `reason` names the limit and how to raise it.
     */
    budgetState(id) {
      const task = store.get(id)
      if (task === undefined) return { ok: false, reason: `unknown task "${id}"` }
      if (task.spent.runs >= task.budget.maxRuns) {
        return {
          ok: false,
          task,
          reason: `task ${id} reached its Codex run budget (${task.spent.runs}/${task.budget.maxRuns}); raise it with codex_task action:set-budget if the work must continue`,
        }
      }
      if (task.spent.tokens >= task.budget.maxTokens) {
        return {
          ok: false,
          task,
          reason: `task ${id} reached its Codex token budget (${task.spent.tokens}/${task.budget.maxTokens}); raise it with codex_task action:set-budget if the work must continue`,
        }
      }
      return { ok: true, task }
    },

    /** @returns counts per status plus the total. */
    summary() {
      const tasks = read().tasks
      const counts = { total: tasks.length }
      for (const status of TASK_STATUSES) counts[status] = tasks.filter((task) => task.status === status).length
      return counts
    },

    /** Replace the whole list (used by `codex_plan replace`). */
    replaceAll(drafts, defaults = {}) {
      writeFileAtomic(file, `${JSON.stringify(empty(), null, 2)}\n`)
      return store.createMany(drafts, defaults)
    },
  }

  return store
}
