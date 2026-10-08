/**
 * Locating and identifying the local Codex CLI.
 *
 * The desktop Codex app does not put itself on PATH, so discovery walks the
 * places a Windows install actually leaves behind, in order of trust: the
 * plugin configuration, the `CODEX_CLI_PATH` entry the Codex app writes into
 * its own `config.toml`, the versioned bin directory under LOCALAPPDATA, the
 * npm shim, and finally PATH.
 *
 * @module dsh-codex-peer/locate
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * The Codex home directory the child runs against.
 * @param config - the validated plugin configuration.
 * @param env - the environment.
 * @returns the absolute CODEX_HOME directory.
 */
export function codexHomeDir(config, env = process.env) {
  const configured = typeof config.codexHome === 'string' ? config.codexHome.trim() : ''
  if (configured !== '') return configured
  const fromEnv = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : ''
  if (fromEnv !== '') return fromEnv
  return join(homedir(), '.codex')
}

/**
 * The path of the Codex configuration file for this home.
 * @param config - the validated plugin configuration.
 * @param env - the environment.
 * @returns the absolute config.toml path (it may not exist).
 */
export function codexConfigPath(config, env = process.env) {
  return join(codexHomeDir(config, env), 'config.toml')
}

/**
 * Read `CODEX_CLI_PATH` out of a Codex configuration file.
 * @param file - the absolute config.toml path.
 * @returns the configured executable path, or undefined when absent or unreadable.
 */
export function readConfiguredCodexPath(file) {
  try {
    const text = readFileSync(file, 'utf8')
    const match = /^[ \t]*CODEX_CLI_PATH[ \t]*=[ \t]*(["'])(.+?)\1[ \t]*$/m.exec(text)
    return match === null ? undefined : match[2]
  } catch {
    return undefined
  }
}

/** @returns true when the path exists and is a regular file. */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** @returns the sorted names of a directory's subdirectories, or an empty list. */
function subdirectories(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * Every candidate executable this machine offers, best first.
 *
 * Candidates are returned even when they do not exist only by the caller's
 * request; {@link locateCodex} filters them.
 *
 * @param config - the validated plugin configuration.
 * @param env - the environment.
 * @returns ordered `{ path, source }` candidates, deduplicated by path.
 */
export function codexCandidates(config, env = process.env) {
  const candidates = []
  const explicit = typeof config.codexPath === 'string' ? config.codexPath.trim() : ''
  if (explicit !== '') candidates.push({ path: explicit, source: 'config.codexPath' })

  const home = codexHomeDir(config, env)
  const configured = readConfiguredCodexPath(join(home, 'config.toml'))
  if (configured !== undefined && configured.trim() !== '') {
    candidates.push({ path: configured.trim(), source: `CODEX_CLI_PATH in ${join(home, 'config.toml')}` })
  }

  const localAppData = typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA.trim() : ''
  if (localAppData !== '') {
    const binRoot = join(localAppData, 'OpenAI', 'Codex', 'bin')
    for (const name of subdirectories(binRoot).sort().reverse()) {
      candidates.push({ path: join(binRoot, name, 'codex.exe'), source: 'the OpenAI Codex install' })
    }
  }

  const appData = typeof env.APPDATA === 'string' ? env.APPDATA.trim() : ''
  if (appData !== '') candidates.push({ path: join(appData, 'npm', 'codex.cmd'), source: 'the npm global shim' })

  const path = typeof env.PATH === 'string' ? env.PATH : ''
  for (const dir of path.split(delimiter)) {
    if (dir.trim() === '') continue
    for (const file of ['codex.exe', 'codex.cmd', 'codex.bat', 'codex']) {
      candidates.push({ path: join(dir.trim(), file), source: 'PATH' })
    }
  }

  const seen = new Set()
  return candidates.filter((candidate) => {
    const key = candidate.path.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Pick the executable to run.
 * @param config - the validated plugin configuration.
 * @param env - the environment.
 * @returns `{ available, path, source, candidates, missing }` where `missing`
 *   lists the candidates that were considered but are not files.
 */
export function locateCodex(config, env = process.env) {
  const candidates = codexCandidates(config, env)
  const existing = candidates.filter((candidate) => isFile(candidate.path))
  const found = existing[0]
  if (found === undefined) return { available: false, path: undefined, source: undefined, candidates, missing: candidates }
  return { available: true, path: found.path, source: found.source, candidates, missing: candidates.filter((c) => c !== found && !isFile(c.path)) }
}

/**
 * Ask the CLI for its version. Failures are reported, never thrown: a broken
 * install is a diagnostic, not an error the model must handle.
 * @param executable - the absolute executable path.
 * @param options - `timeoutMs` for the probe.
 * @returns `{ ok, version?, error? }`.
 */
export function probeCodexVersion(executable, options = {}) {
  const timeout = typeof options.timeoutMs === 'number' ? options.timeoutMs : 30000
  const env = options.env ?? process.env
  return new Promise((resolve) => {
    execFile(
      executable,
      ['--version'],
      { timeout, windowsHide: true, env },
      (error, stdout, stderr) => {
        if (error !== null) {
          resolve({ ok: false, error: `${error.message}${stderr.trim() === '' ? '' : ` (${stderr.trim().split('\n')[0]})`}` })
          return
        }
        resolve({ ok: true, version: stdout.trim() })
      },
    )
  })
}

export { isFile }
