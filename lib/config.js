/**
 * The configuration contract of dsh-codex-peer.
 *
 * Every deployment-varying choice lives here and nowhere else: no path, model,
 * timeout, or policy is hardcoded in the tools. `Config` is a schemastery
 * schema, so the Host validates it at activation (a bad value fails loudly at
 * load time) and the settings subsystem can expose the `.volatile()` subset.
 *
 * @module dsh-codex-peer/config
 */
import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ROUTING_DEFAULTS } from './plan.js'

/** The modes a peer request can run in. */
export const MODES = ['ask', 'plan', 'implement']

/** The sandbox modes the Codex CLI accepts. */
export const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * The fallback state directory, under the Harness home when the environment
 * names one and under `~/.dsh` otherwise.
 * @param env - the environment to read `DSH_HOME` from.
 * @returns the absolute directory that holds runs/ and the ledger.
 */
export function defaultStateDir(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const home = configured === '' ? join(homedir(), '.dsh') : configured
  return join(home, 'codex-peer')
}

/**
 * Resolve the configured state directory against the fallback.
 * @param config - the validated plugin configuration.
 * @param env - the environment to read `DSH_HOME` from.
 * @returns the absolute state directory.
 */
export function resolveStateDir(config, env = process.env) {
  const configured = typeof config.stateDir === 'string' ? config.stateDir.trim() : ''
  return configured === '' ? defaultStateDir(env) : configured
}

/**
 * Derive the sandbox that a mode runs under when neither the call nor the
 * configuration names one: mutating work gets a writable workspace, and
 * everything else stays read-only.
 * @param config - the validated plugin configuration.
 * @param mode - the resolved request mode.
 * @param requested - the sandbox named by the tool call, if any.
 * @returns one of {@link SANDBOXES}.
 */
export function deriveSandbox(config, mode, requested) {
  const fromCall = typeof requested === 'string' ? requested.trim() : ''
  if (fromCall !== '') return fromCall
  const configured = typeof config.defaultSandbox === 'string' ? config.defaultSandbox.trim() : ''
  if (configured !== '') return configured
  return mode === 'implement' ? 'workspace-write' : 'read-only'
}

export const Config = Schema.object({
  codexPath: Schema.string()
    .default('')
    .description(
      'Absolute path to the Codex CLI executable. Empty discovers it: config.codexPath, then CODEX_CLI_PATH in the Codex config.toml, then %LOCALAPPDATA%\\OpenAI\\Codex\\bin\\*\\codex.exe, then the npm shim and PATH.',
    ),
  codexHome: Schema.string()
    .default('')
    .description('Directory exported to the child as CODEX_HOME. Empty inherits CODEX_HOME, or ~/.codex.'),
  stateDir: Schema.string()
    .default('')
    .description('Where run artifacts and the peer ledger are stored. Empty means <DSH_HOME>/codex-peer.'),
  model: Schema.string()
    .default('')
    .description('Model passed to `codex exec -m`. Empty uses the model configured in the Codex CLI.'),
  defaultMode: Schema.union(MODES)
    .default('ask')
    .description('Mode used by codex_ask when the call does not name one.'),
  defaultSandbox: Schema.string()
    .default('')
    .description(
      'Sandbox passed to `codex exec -s`. Empty derives it from the mode: implement gets workspace-write, ask/plan/review get read-only.',
    ),
  requireApproval: Schema.union(['always', 'mutating', 'never'])
    .default('mutating')
    .description(
      'When the Harness asks the user before spawning Codex: always, only for calls that can write (implement mode, workspace-write, danger-full-access), or never.',
    ),
  callTimeoutMs: Schema.number()
    .default(600000)
    .min(1000)
    .description(
      'How long a foreground tool call waits for Codex before returning a background handle. The run keeps going; collect it with job_output.',
    ),
  runTimeoutMs: Schema.number()
    .default(1800000)
    .min(1000)
    .description('Hard cap on one Codex process. At expiry the process tree is killed and the run is reported as timed out.'),
  maxAnswerBytes: Schema.number()
    .default(120000)
    .min(1000)
    .description('How much of the final answer a tool result carries before it is truncated to the artifact path.'),
  progressKeepLines: Schema.number()
    .default(400)
    .min(10)
    .description('How many progress lines a run keeps in memory for background job_output reads and failure notes.'),
  terminateGraceMs: Schema.number()
    .default(5000)
    .min(1)
    .description(
      'How long the child may take to exit after termination starts (SIGTERM to SIGKILL grace on the managed subprocess seam; the tree-kill window on a direct launch).',
    ),
  extraArgs: Schema.array(Schema.string())
    .default([])
    .description('Extra arguments appended to every `codex exec` invocation, for example --add-dir or -c overrides.'),
  promptPreamble: Schema.string()
    .default('')
    .description('Replaces the built-in collaboration preamble that introduces the Harness peer to Codex.'),
  planFile: Schema.string()
    .default('')
    .description(
      'Optional repository-relative path for a markdown mirror of the work list, for example .codex-peer/PLAN.md. Empty writes no file: tasks.json in the state directory stays the single source of truth.',
    ),
  workspaceDir: Schema.string()
    .default('.codex-peer')
    .description(
      'Directory, relative to the working directory of each run, where the readable copy of the collaboration is written: worklist.md, LATEST.md, and runs/<runId>/transcript.md next to the raw artifacts. Empty string disables the workspace copy entirely — the state directory keeps its record either way.',
    ),
  routingRules: Schema.array(
    Schema.object({
      when: Schema.string().description('Lower-case word or phrase matched against a task title, its tags, and its scope.'),
      owner: Schema.union(['dsh', 'codex']).description('Who takes the task when this rule matches.'),
      reason: Schema.string().default('').description('One line explaining the split; it is shown with the task.'),
    }),
  )
    .default(ROUTING_DEFAULTS.map((rule) => ({ ...rule })))
    .description('The routing table used when a task has no owner: first matching rule wins, in order.'),
  defaultOwner: Schema.union(['dsh', 'codex'])
    .default('dsh')
    .description('Owner for a task no routing rule matches.'),
  maxCodexRunsPerTask: Schema.number()
    .default(5)
    .min(0)
    .description('How many Codex runs a task may spend before codex_ask refuses it. Raise it per task with codex_task action:set-budget.'),
  maxCodexTokensPerTask: Schema.number()
    .default(2000000)
    .min(0)
    .description('How many Codex tokens a task may spend before codex_ask refuses it; 0 disables the token ceiling.'),
  approvePerTask: Schema.boolean()
    .default(true)
    .description(
      'When true, one approval of codex_plan covers that task\u2019s mutating Codex runs and they are not asked again; when false every mutating run asks on its own.',
    ),
})
