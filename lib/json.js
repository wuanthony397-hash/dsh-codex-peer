/**
 * Lossless-JSON sanitising for tool results.
 *
 * A tool's `execute` must return a value the harness can round-trip as JSON:
 * `undefined`, `NaN`, `Infinity`, functions, symbols, and `Date` instances are
 * not JSON values, and a single stray `undefined` (a version that was never
 * probed, an optional field that was not set) makes the whole call fail with
 * "value is not lossless JSON" — which is exactly how the live `codex_status`
 * call failed the first time it ran.
 *
 * Rather than trusting every branch of every tool to remember that, every
 * registered tool passes its result through {@link withLosslessResult}:
 *
 * | input | output |
 * | --- | --- |
 * | `undefined` (object property) | dropped |
 * | `undefined` (array element) | `null` |
 * | `NaN`, `±Infinity` | `null` |
 * | `Date` | ISO string |
 * | `bigint` | decimal string |
 * | function, symbol | dropped / `null` |
 * | shared reference | the value itself (only true cycles become `null`) |
 *
 * @module dsh-codex-peer/json
 */

/** How deep a value may nest before it is replaced with `null`. */
const MAX_DEPTH = 32

/**
 * Copy `value` into lossless-JSON form.
 * @param value - anything a tool wants to return.
 * @param seen - the ancestor chain, used to break cycles.
 * @param depth - the current nesting depth.
 * @returns a JSON-safe copy, or `undefined` when the value itself is dropped.
 */
export function toJsonValue(value, seen = new WeakSet(), depth = 0) {
  if (value === null) return null
  // `undefined` is a signal to the caller, not a value: an object property that
  // holds it is dropped, an array element that holds it becomes null.
  if (value === undefined) return undefined
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'bigint') return value.toString()
  if (type === 'function' || type === 'symbol') return undefined
  if (value instanceof Date) return value.toISOString()
  if (depth >= MAX_DEPTH) return null
  if (seen.has(value)) return null
  seen.add(value)
  let result
  if (Array.isArray(value)) {
    result = value.map((item) => {
      const clean = toJsonValue(item, seen, depth + 1)
      return clean === undefined ? null : clean
    })
  } else if (value instanceof Map) {
    result = {}
    for (const [key, child] of value.entries()) {
      const clean = toJsonValue(child, seen, depth + 1)
      if (clean !== undefined) result[String(key)] = clean
    }
  } else if (value instanceof Set) {
    result = [...value].map((item) => {
      const clean = toJsonValue(item, seen, depth + 1)
      return clean === undefined ? null : clean
    })
  } else {
    result = {}
    for (const [key, child] of Object.entries(value)) {
      const clean = toJsonValue(child, seen, depth + 1)
      if (clean !== undefined) result[key] = clean
    }
  }
  seen.delete(value)
  return result
}

/**
 * Wrap a tool so its result is always lossless JSON.
 * @param tool - a tool definition (`{ name, description, parameters, output, execute, presentCall? }`).
 * @returns a copy of the tool whose `execute` (and `presentCall`) sanitise their result.
 */
export function withLosslessResult(tool) {
  return {
    ...tool,
    async execute(args, exec) {
      const value = await tool.execute(args, exec)
      return value === undefined ? null : toJsonValue(value)
    },
    ...(typeof tool.presentCall === 'function'
      ? {
          presentCall(args) {
            return toJsonValue(tool.presentCall(args))
          },
        }
      : {}),
  }
}
