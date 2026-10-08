/**
 * Turning a peer request into a Codex invocation.
 *
 * Two things matter here and are easy to get wrong:
 *
 * 1. The prompt travels on stdin (`codex exec ... -`), never on the command
 *    line. Windows caps a command line at ~32k characters and a hand-off
 *    prompt easily exceeds that.
 * 2. `codex exec resume` accepts neither `-s/--sandbox` nor `-C/--cd`, so a
 *    resumed run pins its sandbox through `-c sandbox_mode=...` and inherits
 *    the working directory from the spawned process.
 *
 * The prompt itself is a collaboration contract, not just the user's words:
 * the peer never has a human on its channel, so the preamble tells Codex to
 * assume, proceed, and make its final message the hand-off.
 *
 * @module dsh-codex-peer/argv
 */

/** Extra arguments a mode adds when the caller does not override them. */
export const DEFAULT_PREAMBLE = [
  'You are Codex, working as a peer of a DeepSeek Harness (DSH) agent on one shared working tree.',
  'The DSH agent invoked you through a tool call and reads your final message as the hand-off; it can read every file you touch and will review the result.',
  '',
  'How to work as a peer:',
  '- Do the requested piece of work yourself, concretely. In a mutating task, change the working tree; do not only describe the change.',
  '- There is no interactive human on this channel and nobody will answer a question, so never end the turn waiting for one. When something is ambiguous, take the reading that best matches the request, state the assumption in your final message, and continue.',
  '- Keep changes inside the scope of the request; do not reformat or refactor unrelated code.',
  '- Verify what can be verified cheaply (build, tests, lint, a diff read) and report exactly what you ran and what it said.',
  '- Never claim work you did not do. If something is left undone, say so plainly and describe the state you left behind.',
  '',
  'Your final message is the deliverable and must stand alone without this conversation. Include: what you did or concluded, the files you changed with paths, the evidence your verification produced, what you deliberately left out, and any open questions for the DSH agent.',
].join('\n')

/**
 * The instruction sentence that gives a mode its shape.
 * @param mode - `ask`, `plan`, or `implement`.
 * @returns the instruction text.
 */
export function modeInstruction(mode) {
  if (mode === 'plan') {
    return [
      'Mode: plan.',
      'Read whatever you need and produce a concrete, ordered implementation plan for the DSH agent to execute.',
      'Modify nothing on disk. Name the exact files to change, the shape of each change, the order of the steps, the checks that prove the result, and the risks you see.',
    ].join(' ')
  }
  if (mode === 'implement') {
    return [
      'Mode: implement.',
      'Carry the work out in the working tree now, not as a proposal.',
      'Run the relevant checks when they are cheap enough to run in this turn, and report their real output.',
    ].join(' ')
  }
  return [
    'Mode: ask.',
    'Answer the request from the working tree and your own knowledge.',
    'Do not modify any file; if the answer requires a change, describe the change instead of making it.',
  ].join(' ')
}

/**
 * The preamble this deployment uses.
 * @param config - the validated plugin configuration.
 * @returns the configured preamble, or the built-in one.
 */
export function buildPreamble(config) {
  const configured = typeof config?.promptPreamble === 'string' ? config.promptPreamble.trim() : ''
  return configured === '' ? DEFAULT_PREAMBLE : configured
}

/**
 * Assemble the full prompt for one run.
 * @param options - `config`, `mode`, `cwd`, `prompt`, `resume` (the thread id being resumed, if any), `extraContext`.
 * @returns the text written to Codex's stdin.
 */
export function buildPrompt(options) {
  const { config, mode, cwd, prompt, resume, extraContext } = options
  const sections = [buildPreamble(config), modeInstruction(mode)]
  sections.push(
    resume === undefined || resume === null
      ? `Working directory for this thread: ${cwd}`
      : `Working directory for this thread: ${cwd}\nThis call continues thread ${resume}; its earlier messages and tool results are already in your context. Do not repeat finished work.`,
  )
  if (typeof extraContext === 'string' && extraContext.trim() !== '') sections.push(`Additional context:\n${extraContext.trim()}`)
  sections.push('--- request ---')
  sections.push(String(prompt ?? '').trim())
  return `${sections.join('\n\n')}\n`
}

/**
 * Build the Codex command line.
 * @param options - `mode`, `sandbox`, `model`, `cwd`, `answerPath`, `outputSchemaPath`, `resumeThreadId`, `extraArgs`.
 * @returns the argument vector, prompt excluded (it arrives on stdin).
 */
export function buildExecArgv(options) {
  const { sandbox, model, cwd, answerPath, outputSchemaPath, resumeThreadId, extraArgs } = options
  const args = resumeThreadId === undefined || resumeThreadId === null ? ['exec'] : ['exec', 'resume', String(resumeThreadId)]
  args.push('--json')
  if (typeof answerPath === 'string' && answerPath !== '') args.push('-o', answerPath)
  if (typeof outputSchemaPath === 'string' && outputSchemaPath !== '') args.push('--output-schema', outputSchemaPath)
  args.push('--skip-git-repo-check')
  if (resumeThreadId === undefined || resumeThreadId === null) {
    args.push('-C', cwd)
    args.push('-s', sandbox)
  } else {
    // `codex exec resume` has no -s/--sandbox and no -C/--cd: pin the sandbox
    // through config and let the spawned process cwd stand in for -C.
    args.push('-c', `sandbox_mode="${sandbox}"`)
  }
  if (typeof model === 'string' && model.trim() !== '') args.push('-m', model.trim())
  for (const extra of Array.isArray(extraArgs) ? extraArgs : []) {
    if (typeof extra === 'string' && extra !== '') args.push(extra)
  }
  args.push('-')
  return args
}
