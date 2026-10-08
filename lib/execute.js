/**
 * Turning a tool call into a Codex run, with or without the job service.
 *
 * The Harness has two shapes for long work and this module picks between them
 * at call time rather than at load time:
 *
 * - With the job service loaded, every run becomes a job owned by the calling
 *   agent. A `background: true` call returns its handle immediately; a
 *   foreground call waits up to `callTimeoutMs` and, if Codex is still working,
 *   is promoted to the same background handle instead of being killed. While it
 *   runs, `job_output` streams the progress lines this module feeds the job's
 *   output source.
 * - Without the job service, the run simply executes with its own
 *   `runTimeoutMs` ceiling, and `background: true` is refused with an
 *   explanation instead of silently behaving differently.
 *
 * @module dsh-codex-peer/execute
 */
import { createProgressLog } from './events.js'
import { describeOutcome, executeRun, planRun } from './runner.js'

/** @returns the job outcome vocabulary for one Codex outcome. */
export function jobResultFor(outcome) {
  const status = outcome.status === 'completed' ? 'completed' : outcome.status === 'failed' ? 'failed' : 'killed'
  return { status, detail: descriptionFor(outcome) }
}

/** @returns a one-line, human-facing description of an outcome. */
export function descriptionFor(outcome) {
  const bits = [outcome.status]
  if (outcome.resumedThreadId !== null) bits.push(`resumed ${outcome.resumedThreadId}`)
  if (typeof outcome.threadId === 'string' && outcome.threadId !== '') bits.push(`thread ${outcome.threadId}`)
  if (outcome.usage !== null) bits.push(`${outcome.usage.totalTokens} tokens`)
  bits.push(`${(outcome.durationMs / 1000).toFixed(1)}s`)
  if (outcome.exitCode !== null && outcome.exitCode !== 0) bits.push(`exit ${outcome.exitCode}`)
  return bits.join(' · ')
}

/**
 * Run one peer request.
 *
 * @param peer - `{ config, ledger, jobs?, logger? }`.
 * @param request - the plan request (`prompt`, `mode`, `sandbox`, `cwd`, `background`, …).
 * @param exec - the tool execution context (`signal`, `agent`).
 * @returns `{ kind, plan, jobId?, outcome?, progress, spawn? }` where `kind` is
 *   `run` (finished inside this call), `promoted` (foreground call outlived its
 *   timeout and now runs as a job), or `background` (returned immediately).
 */
export async function runPeerRequest(peer, request, exec) {
  const plan = planRun(peer, request, exec)
  const progress = createProgressLog({ maxLines: peer.config.progressKeepLines })
  const jobs = peer.jobs
  const background = request.background === true

  // A run may be attached to a work-list entry. Attaching one makes the budget
  // real: the call is refused before it starts when the task is out of runs or
  // tokens, and the settled run is charged back against the task so the next
  // call sees the truth.
  const taskId = typeof request.taskId === 'string' && request.taskId !== '' ? request.taskId : undefined
  let task
  if (taskId !== undefined) {
    if (peer.tasks === undefined) throw new Error('task ids need the work list, which this composition does not provide')
    task = peer.tasks.get(taskId)
    if (task === undefined) throw new Error(`unknown task "${taskId}"; call codex_task action:list to see the ids`)
    const budget = peer.tasks.budgetState(taskId)
    if (!budget.ok) throw new Error(budget.reason)
  }
  /** Charge a settled run to its task; accounting never fails a finished run. */
  const charge = (settled) => {
    if (task === undefined || settled === undefined || settled === null) return
    try {
      peer.tasks.recordRun(task.id, {
        runId: settled.runId,
        tokens: settled.usage === null || settled.usage === undefined ? undefined : settled.usage.totalTokens,
        threadId: typeof settled.threadId === 'string' ? settled.threadId : undefined,
      })
    } catch {
      // The run happened; a bookkeeping failure must not rewrite its outcome.
    }
  }

  if (jobs === undefined) {
    if (background === true) {
      throw new Error(
        'background Codex runs need the job service, which is not loaded in this profile: enable @deepseek-ai/dsh-tool-jobs (the dsh-base bundle loads it) or call again without background: true',
      )
    }
    const outcome = await executeRun(peer, plan, { signal: exec?.signal, progress })
    charge(outcome)
    return { kind: 'run', plan, outcome, progress }
  }

  const owner = exec?.agent?.id
  const controller = new AbortController()
  let spawnInfo
  let outcome
  const id = jobs.start({
    kind: 'codex',
    label: `codex ${plan.label}`,
    ...(owner === undefined ? {} : { owner }),
    output: [{ channel: 'stdout', read: (fromByte) => progress.read(fromByte) }],
    run: () => ({
      cancel: (reason) => {
        try {
          controller.abort(reason ?? 'the job was cancelled')
        } catch {
          // Aborting an already-aborted controller is not an error worth reporting.
        }
      },
      done: (async () => {
        try {
          const settled = await executeRun(peer, plan, {
            signal: controller.signal,
            progress,
            onSpawn: (info) => {
              spawnInfo = info
            },
          })
          outcome = settled
          charge(settled)
          progress.push(describeOutcome(settled))
          return jobResultFor(settled)
        } catch (error) {
          const message = error?.message ?? String(error)
          progress.push(`failed: ${message}`)
          return { status: 'failed', detail: message }
        }
      })(),
    }),
  })

  if (background === true) return { kind: 'background', plan, jobId: id, progress, spawn: spawnInfo }

  let waitError
  try {
    await jobs.wait(id, peer.config.callTimeoutMs, owner, exec?.signal)
  } catch (error) {
    waitError = error
  }

  if (waitError !== undefined && exec?.signal?.aborted === true) {
    try {
      jobs.kill(id, owner, 'the tool call was aborted before the Codex run finished')
    } catch {
      // Nothing to stop.
    }
    try {
      await jobs.wait(id, 5000, owner)
    } catch {
      // The job may already be gone.
    }
    try {
      jobs.remove(id, owner)
    } catch {
      // The record may already be gone.
    }
    throw waitError instanceof Error ? waitError : new Error(String(waitError))
  }

  if (outcome === undefined) {
    return { kind: 'promoted', plan, jobId: id, progress, spawn: spawnInfo, waitError }
  }

  try {
    jobs.remove(id, owner)
  } catch {
    // A leftover record only delays the next run; it is not worth failing this one.
  }
  charge(outcome)
  return { kind: 'run', plan, outcome, progress, jobId: id }
}
