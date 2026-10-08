/**
 * The approval gate in front of work that lets Codex write.
 *
 * Starting Codex is starting a second agent with write access to the same
 * working tree, and (unlike a Harness tool call) that child is not wrapped by
 * the Harness sandbox: the sandbox mode handed to `codex exec` is the only
 * bound on what it writes. So the gate asks the user — by returning
 * `{ kind: 'ask' }` from the `tools/pre-execute` waterfall, which routes
 * through the approval service and is denied when no approver exists
 * (fail-closed).
 *
 * Three policies, in order of what the call is:
 *
 * - `codex_plan` is the act of agreeing to a split, so it is asked for once
 *   (unless `requireApproval: never`). Approving it stamps the plan, and with
 *   `approvePerTask` (default) the tasks it created no longer ask on every
 *   run — one decision instead of one per turn.
 * - `codex_ask` / `codex_review` carrying a `taskId` whose task is already
 *   approved pass straight through under `approvePerTask`.
 * - Everything else follows `requireApproval`: `mutating` (default) asks only
 *   when the run may write, `always` asks for every peer call, `never` turns
 *   the gate off for deployments that supervise the split themselves.
 *
 * @module dsh-codex-peer/gate
 */
import { deriveSandbox } from './config.js'

/** Tools whose calls the gate inspects. */
const GATED_TOOLS = new Set(['codex_ask', 'codex_review', 'codex_plan'])

/**
 * Decide whether one call needs the user's approval.
 * @param requireApproval - `always` | `mutating` | `never`.
 * @param run - `{ mode, sandbox }` the call resolves to.
 * @returns true when the call must be confirmed first.
 */
export function needsApproval(requireApproval, run) {
  if (requireApproval === 'never') return false
  if (requireApproval === 'always') return true
  return run.mode === 'implement' || run.sandbox === 'workspace-write' || run.sandbox === 'danger-full-access'
}

/**
 * Whether a plan call needs approval. A plan is where the user agrees to let
 * Codex write inside the scope of the tasks it creates, so it is asked for
 * once under every policy except `never`.
 * @param requireApproval - the configured policy.
 * @returns true when the plan call must be confirmed.
 */
export function planNeedsApproval(requireApproval) {
  return requireApproval !== 'never'
}

/** @returns the tool-call arguments, whether the executor spells them `arguments` or `args`. */
function callArguments(exec) {
  const value = exec?.arguments ?? exec?.args
  return value !== null && typeof value === 'object' ? value : {}
}

/** @returns true when an approved task already covers this call. */
function coveredByTask(peer, args) {
  if (peer.config.approvePerTask !== true) return false
  const taskId = args.taskId
  if (typeof taskId !== 'string' || taskId === '') return false
  const task = peer.tasks?.get(taskId)
  return task !== undefined && typeof task.approvedAt === 'string' && task.approvedAt !== ''
}

/**
 * Build the `tools/pre-execute` listener.
 * @param peer - the runtime peer object.
 * @returns a waterfall listener that asks when a call may write.
 */
export function createApprovalGate(peer) {
  return (exec, next) => {
    const toolName = exec?.name
    if (typeof toolName !== 'string' || !GATED_TOOLS.has(toolName)) return next()
    const args = callArguments(exec)
    const cwd = String(args.cwd ?? exec?.agent?.session?.header?.cwd ?? '(the session working directory)')

    if (toolName === 'codex_plan') {
      if (!planNeedsApproval(peer.config.requireApproval)) return next()
      const drafts = Array.isArray(args.tasks) ? args.tasks.length : 0
      const scope = drafts > 0 ? `${drafts} task(s) you listed` : 'the tasks Codex and this agent work out'
      return {
        kind: 'ask',
        reason: `dsh-codex-peer would record a shared work plan for "${String(args.goal ?? '(no goal given)')}" in ${cwd}, covering ${scope}. Approving it lets Codex write inside the scope of those tasks without asking again${peer.config.approvePerTask === true ? '' : ' (per-run approval is on, so each run still asks)'}.`,
        displayReason: `Approve Codex peer plan: ${String(args.goal ?? '').slice(0, 80)}`,
      }
    }

    if (coveredByTask(peer, args)) return next()

    const mode = toolName === 'codex_review' ? 'ask' : (args.mode ?? peer.config.defaultMode)
    const sandbox = toolName === 'codex_review' ? 'read-only' : deriveSandbox(peer.config, mode, args.sandbox)
    if (!needsApproval(peer.config.requireApproval, { mode, sandbox })) return next()

    const what = mode === 'implement' ? 'edit the working tree' : `run in the ${sandbox} sandbox`
    return {
      kind: 'ask',
      reason: `dsh-codex-peer would start the Codex CLI as a peer agent to ${what} in ${cwd}, with sandbox mode "${sandbox}". Codex runs as its own process outside the Harness sandbox, so that sandbox mode is the only bound on what it writes.`,
      displayReason: `Start Codex peer (${mode}, ${sandbox}) in ${cwd}`,
    }
  }
}
