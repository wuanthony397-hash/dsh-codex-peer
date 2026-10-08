#!/usr/bin/env node
/**
 * Turn captured test output into GitHub annotations.
 *
 * The job log archive needs an authenticated request, but check-run annotations
 * are readable on a public repository — so a red run can explain itself to
 * anyone (including an agent) that only has the API.
 *
 * Usage: node .github/scripts/report-failure.mjs [test-output.txt]
 */
import { existsSync, readFileSync } from 'node:fs'

const file = process.argv[2] ?? 'test-output.txt'
if (!existsSync(file)) {
  console.log(`no ${file} to report`)
  process.exit(0)
}

const lines = readFileSync(file, 'utf8').split(/\r?\n/)
const failures = lines.filter((line) => /^(✖|not ok)|AssertionError|Expected values|^ℹ fail/.test(line.trim()))
const report = [...new Set([...failures, '--- last 40 lines of test output ---', ...lines.slice(-40)])]
  .map((line) => line.replace(/[\r\n]+/g, ' ').replace(/%/g, '%25').trim())
  .filter((line) => line !== '')
  .slice(0, 60)

for (const line of report) {
  console.log(`::error::${line.slice(0, 900)}`)
}
console.log(`reported ${report.length} line(s) for ${failures.length} failure marker(s)`)
