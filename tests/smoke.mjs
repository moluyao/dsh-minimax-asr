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
const listeners = new Map()
const ctx = {
  tools: { register: (tool) => registrations.push(tool) },
  // No settings service: the smoke test exercises the composition-entry path.
  inject: () => {},
  // The announcement hook: kept so the no-web-server path can be exercised.
  on: (event, listener) => listeners.set(event, listener),
  logger: { warn: (message) => console.log(`warn: ${message}`) },
  get: () => undefined,
}

apply(ctx, { apiKeyEnv: 'MINIMAX_API_KEY' })

// --- the two tools ----------------------------------------------------------

console.log(`plugin: ${name}`)
console.log(`config schema: ${typeof Config}, tool count: ${registrations.length}`)
const tool = registrations.find(candidate => candidate.name === 'transcribe_audio')
const announce = registrations.find(candidate => candidate.name === 'announce_speech')
if (tool === undefined || announce === undefined) {
  throw new Error(`expected transcribe_audio and announce_speech, got ${registrations.map(t => t.name).join(', ')}`)
}
console.log(`registered tools: ${registrations.map(candidate => candidate.name).join(', ')}`)

// The spoken line is named by the turn, not scraped from the reply. With the
// composition-entry path (no settings service) the section defaults apply.
const session = { header: { id: 'smoke-session' } }
const spoken = await announce.execute(
  { text: '**测试**通过了，`13` 项检查全绿。要不要我接着做下一件事？' },
  { signal: undefined, agent: { session } },
)
console.log(`announce_speech -> ${JSON.stringify(spoken)}`)
if (spoken.spoken !== true || spoken.characters !== spoken.text.length) {
  throw new Error('announce_speech did not accept the spoken line')
}
if (/[*`]/u.test(spoken.text)) throw new Error('markdown survived into the spoken line')
console.log('spoken line accepted and flattened: ok')

let refused = false
try {
  await announce.execute({}, { signal: undefined, agent: { session } })
} catch (error) {
  refused = /text is required/u.test(error.message)
}
console.log(`an empty announcement is refused: ${refused}`)

const silent = await announce.execute({ silent: true }, { signal: undefined, agent: { session } })
console.log(`silent turn -> ${JSON.stringify(silent)}`)

// Announcing with no browser attached must be a silent no-op, not a crash.
const onSessionEvent = listeners.get('session/event')
console.log(`session/event hook: ${typeof onSessionEvent}`)
onSessionEvent(
  {
    id: 'smoke-session',
    events: [{
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '没有人听着。' }] } },
    }],
  },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
)
console.log('announce with no listeners: ok')

const args = { path: audio }
if (format !== undefined) args.response_format = format
if (level !== undefined) args.timestamp_level = level

const started = Date.now()
const value = await tool.execute(args, { signal: undefined })
console.log(`elapsed: ${Date.now() - started} ms`)
console.log(JSON.stringify(value, null, 2))
