/**
 * dsh-codex-peer — run the local Codex CLI as a peer agent from inside DSH.
 *
 * The plugin is a bridge, not an integration: Codex keeps its own session,
 * tools, sandbox, and model, DSH keeps its own, and the two exchange work
 * through ordinary tool calls and the files in the shared working tree.
 *
 * Host-only by design: five tools, one approval gate, and a state directory
 * holding the run artifacts and the shared work list. Nothing is registered in
 * the client bundle, and no runtime dependency is declared (the Harness injects
 * its own packages).
 *
 * @module dsh-codex-peer
 */
import { Config, resolveStateDir } from './lib/config.js'
import { createApprovalGate } from './lib/gate.js'
import { createLedger } from './lib/ledger.js'
import { locateCodex } from './lib/locate.js'
import { createTaskStore } from './lib/tasks.js'
import { registerTools } from './lib/tools.js'

/** The plugin name cordis logs and the patch file refer to. */
export const name = 'codex-peer'

/** The plugin only needs the tool registry; jobs and subprocess are optional. */
export const inject = ['tools']

export { Config }

/** @returns a scoped logger when the context provides one. */
function resolveLogger(ctx) {
  if (typeof ctx.logger !== 'function') return undefined
  try {
    return ctx.logger('codex-peer')
  } catch {
    return ctx.logger
  }
}

/**
 * Wire the peer into the Harness.
 * @param ctx - the plugin context.
 * @param config - the validated {@link Config}.
 */
export function apply(ctx, config) {
  const logger = resolveLogger(ctx)
  const stateDir = resolveStateDir(config)
  const ledger = createLedger({ dir: stateDir })
  try {
    ledger.ensure()
  } catch (error) {
    throw new Error(`dsh-codex-peer: the state directory ${stateDir} could not be prepared: ${error?.message ?? String(error)}`)
  }

  const peer = { config, ledger, stateDir, tasks: createTaskStore({ dir: stateDir }), jobs: undefined, subprocess: undefined, logger }

  ctx.effect(() => {
    const disposeTools = registerTools(ctx, peer)
    const disposeGate = ctx.on('tools/pre-execute', createApprovalGate(peer))
    return () => {
      if (typeof disposeGate === 'function') disposeGate()
      disposeTools()
    }
  }, 'codex-peer tools and approval gate')

  // Background runs are optional: without the job service a run still works,
  // it just cannot be promoted and `background: true` is refused with a reason.
  ctx.inject(['jobs'], (jobCtx) => {
    peer.jobs = jobCtx.jobs
    jobCtx.effect(() => () => {
      if (peer.jobs === jobCtx.jobs) peer.jobs = undefined
    })
  })

  // Prefer the managed subprocess seam: it scrubs the environment, terminates
  // a whole process range, and reaps children when the service is disposed.
  ctx.inject(['subprocess'], (subprocessCtx) => {
    peer.subprocess = subprocessCtx.subprocess
    subprocessCtx.effect(() => () => {
      if (peer.subprocess === subprocessCtx.subprocess) peer.subprocess = undefined
    })
  })

  const located = locateCodex(config)
  const tasks = peer.tasks.summary()
  logger?.info?.(
    'state directory %s · codex %s · tasks %s',
    stateDir,
    located.available ? `${located.path} (${located.source})` : 'not found — set codexPath in the plugin config',
    `${tasks.total} (${tasks.todo} todo, ${tasks.doing} doing, ${tasks.blocked} blocked, ${tasks.done} done, ${tasks.unverified} unverified)`,
  )
}
