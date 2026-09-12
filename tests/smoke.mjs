/**
 * Off-harness smoke test for the host half: load the plugin module, run its
 * `apply` against a stub context, then execute the registered tool on a real
 * audio file against the live MiniMax endpoint.
 *
 * Usage: node tests/smoke.mjs <audio-file> [response_format] [timestamp_level]
 * Requires MINIMAX_API_KEY in the environment.
 */

import { apply, name, Config } from '../lib/index.js'

const [audio, format, level] = process.argv.slice(2)
if (audio === undefined) {
  console.error('usage: node tests/smoke.mjs <audio-file> [response_format] [timestamp_level]')
  process.exit(2)
}

const registrations = []
const ctx = {
  tools: { register: (tool) => registrations.push(tool) },
  // No settings service: the smoke test exercises the composition-entry path.
  inject: () => {},
  get: () => undefined,
}

apply(ctx, { apiKeyEnv: 'MINIMAX_API_KEY' })

console.log(`plugin: ${name}`)
console.log(`config schema: ${typeof Config}, tool count: ${registrations.length}`)
const tool = registrations[0]
console.log(`registered tool: ${tool.name}`)

const args = { path: audio }
if (format !== undefined) args.response_format = format
if (level !== undefined) args.timestamp_level = level

const started = Date.now()
const value = await tool.execute(args, { signal: undefined })
console.log(`elapsed: ${Date.now() - started} ms`)
console.log(JSON.stringify(value, null, 2))
