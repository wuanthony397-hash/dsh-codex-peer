/**
 * Run the suite with `process.platform` pretending to be Linux.
 *
 * The Windows CI leg and the Linux CI leg take different branches (case folding
 * in `normalizeCwd`, `taskkill` vs `process.kill`, detached spawning), and a
 * Windows-only developer machine otherwise never exercises the Linux ones. This
 * wrapper is how the same suite can be run against the Linux assumptions
 * locally:
 *
 *     node test/run-as-linux.mjs
 *
 * It is a development helper, not a test: it runs the real suite unchanged.
 */
Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
await import('./unit.test.js')
