/**
 * Starting the Codex child process.
 *
 * Two launchers exist because the composition decides, not the plugin:
 *
 * - **Managed** (`ctx.subprocess`, the sanctioned seam) is preferred. It gives
 *   the run what a raw spawn cannot: environment scrubbing, a SIGTERM→grace→
 *   SIGKILL ladder against the whole managed process range, and — because the
 *   service terminates everything it started when it is disposed — no orphan
 *   `codex.exe` if the harness goes away. The prompt is handed over as
 *   `stdio.stdin = { data }`, and stdout/stderr are piped straight to the
 *   event reader.
 * - **Direct** (`node:child_process`) is the fallback for a composition with no
 *   subprocess provider. It is the same shape, minus the scrub and the managed
 *   range, so it kills the tree with `taskkill /T` on Windows and the process
 *   group elsewhere.
 *
 * Both expose the same small surface so {@link module:dsh-codex-peer/runner}
 * does not care which one ran.
 *
 * @module dsh-codex-peer/launch
 */
import { spawn } from 'node:child_process'

/**
 * Terminate a process and everything it started (direct-launch fallback only).
 * @param pid - the direct child's process id.
 * @param options - `platform`, `spawnImpl`.
 */
export function killProcessTree(pid, options = {}) {
  const platform = options.platform ?? process.platform
  const spawnImpl = options.spawnImpl ?? spawn
  if (typeof pid !== 'number' || pid <= 0) return
  if (platform === 'win32') {
    try {
      const killer = spawnImpl('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on?.('error', () => {})
    } catch {
      // The tree may already be gone; nothing useful left to do.
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

/**
 * The environment a directly spawned Codex child gets.
 * @param config - the validated plugin configuration.
 * @param env - the parent environment.
 * @returns the child environment.
 */
export function childEnv(config, env = process.env) {
  const configured = typeof config.codexHome === 'string' ? config.codexHome.trim() : ''
  return configured === '' ? { ...env } : { ...env, CODEX_HOME: configured }
}

/**
 * The environment overrides a managed child gets: only what the user asked for,
 * because the service already scrubs the ambient parent environment.
 * @param config - the validated plugin configuration.
 * @returns an overrides object, empty when nothing was configured.
 */
export function managedEnvOverrides(config) {
  const configured = typeof config.codexHome === 'string' ? config.codexHome.trim() : ''
  return configured === '' ? undefined : { CODEX_HOME: configured }
}

/** Launch through `node:child_process`. */
export function launchDirect(options) {
  const child = options.spawnImpl(options.executable, options.argv, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: options.platform !== 'win32',
  })
  const done = new Promise((resolve, reject) => {
    child.once('error', (error) => reject(error))
    child.once('close', (exitCode, signal) => resolve({ exitCode: exitCode === null ? null : exitCode, signal: signal ?? null }))
  })
  return {
    kind: 'direct',
    stdinFed: false,
    stdin: child.stdin ?? undefined,
    stdout: child.stdout ?? undefined,
    stderr: child.stderr ?? undefined,
    pid: typeof child.pid === 'number' ? child.pid : undefined,
    done,
    terminate: () => killProcessTree(child.pid, { platform: options.platform, spawnImpl: options.spawnImpl }),
  }
}

/** Launch through the managed subprocess seam. */
export function launchManaged(options) {
  const handle = options.subprocess.spawn({
    argv: [options.executable, ...options.argv],
    cwd: options.cwd,
    stdio: {
      stdin: { data: options.stdinData },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    graceMs: options.graceMs,
    ...(options.envOverrides === undefined ? {} : { env: options.envOverrides }),
    ...(options.signal === undefined || options.signal === null ? {} : { signal: options.signal }),
  })
  return {
    kind: 'subprocess',
    stdinFed: true,
    stdin: handle.stdin,
    stdout: handle.stdout,
    stderr: handle.stderr,
    pid: undefined,
    done: handle.done,
    terminate: () => {
      handle.terminate()
    },
  }
}

/**
 * Start the child with the best launcher this composition offers.
 *
 * A managed launch that throws on the way in (a provider that rejects the spec,
 * a service that disappeared between load and call) falls back to the direct
 * launcher with a note, so a bad interaction with the seam degrades into a
 * working run instead of a failed one.
 *
 * @param options - `subprocess?`, `executable`, `argv`, `cwd`, `env`, `envOverrides?`,
 *   `stdinData`, `graceMs`, `signal`, `platform`, `spawnImpl`.
 * @returns `{ launch, note? }`.
 */
export function createLaunch(options) {
  const managed = options.subprocess
  if (managed !== undefined && managed !== null && typeof managed.spawn === 'function') {
    try {
      return { launch: launchManaged({ ...options, subprocess: managed }) }
    } catch (error) {
      return {
        launch: launchDirect(options),
        note: `the managed subprocess seam rejected the spawn (${error?.message ?? String(error)}); falling back to a direct child process`,
      }
    }
  }
  return { launch: launchDirect(options) }
}
