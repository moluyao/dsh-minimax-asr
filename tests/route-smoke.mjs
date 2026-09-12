/**
 * Off-harness test for the browser voice-input route.
 *
 * Loads the plugin, captures the route the host half registers, then drives it
 * with synthetic node HTTP requests: a real recording through the live MiniMax
 * endpoint, plus every refusal the fence and the size guard must produce.
 *
 * Usage: node tests/route-smoke.mjs [audio-file]
 * Requires MINIMAX_API_KEY in the environment.
 */

import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { apply, TRANSCRIBE_ROUTE, DIAGNOSTICS_ROUTE } from '../lib/index.js'

const audioPath = process.argv[2]
if (audioPath === undefined) {
  console.error('usage: MINIMAX_API_KEY=... node tests/route-smoke.mjs <audio-file>')
  console.error('  any speech file MiniMax accepts (wav/aiff/flac/m4a/mp3/aac/opus/ogg, <=500s, <=50MB)')
  process.exit(2)
}
const audio = readFileSync(audioPath)

function check(condition, label) {
  if (!condition) throw new Error(`FAIL: ${label}`)
  console.log(`ok - ${label}`)
}

const tools = []
const routes = []
const ctx = {
  tools: { register: (tool) => tools.push(tool) },
  effect: (callback) => callback(),
  inject: (names, callback) => {
    // The settings service is absent here (composition-entry path); the web
    // server is present, so its route registration runs.
    if (names.includes('webServer')) {
      callback({ webServer: { register: (route) => { routes.push(route); return () => {} } } })
    }
  },
  get: () => undefined,
}

apply(ctx, { apiKeyEnv: 'MINIMAX_API_KEY' })

check(tools.length === 1, `registered ${tools.length} tool`)
check(routes.length === 1, `registered ${routes.length} route`)
const route = routes[0]
check(route.path === '/minimax-asr', `route prefix ${route.path}`)
check(route.kind === 'prefix', `route kind ${route.kind}`)
check(TRANSCRIBE_ROUTE === '/minimax-asr/transcribe', 'transcribe path is /minimax-asr/transcribe')
check(DIAGNOSTICS_ROUTE === '/minimax-asr/diagnostics', 'diagnostics path is /minimax-asr/diagnostics')

/**
 * Drive the route with one synthetic request.
 * @param options - method, headers, body, and query string.
 * @returns the captured status and parsed body.
 */
async function call(options = {}) {
  const { method = 'POST', headers = {}, body = undefined, query = '', path = TRANSCRIBE_ROUTE } = options
  const request = Readable.from(body === undefined ? [] : [body])
  request.method = method
  request.url = `${path}${query}`
  request.headers = {
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
    ...headers,
  }
  const captured = { status: 0, headers: undefined, body: '' }
  const response = {
    writeHead(status, responseHeaders) {
      captured.status = status
      captured.headers = responseHeaders
    },
    end(chunk) {
      captured.body = chunk === undefined ? '' : String(chunk)
    },
  }
  await route.handler(request, response)
  let parsed
  try {
    parsed = JSON.parse(captured.body)
  } catch {
    parsed = undefined
  }
  return { ...captured, parsed }
}

// --- refusals ---------------------------------------------------------------

const crossSite = await call({ headers: { 'sec-fetch-site': 'cross-site' }, body: audio })
check(crossSite.status === 403, `cross-site marker refused (${crossSite.status})`)

const foreignHost = await call({ headers: { host: 'evil.example.com' }, body: audio })
check(foreignHost.status === 403, `non-loopback Host refused (${foreignHost.status})`)

const foreignOrigin = await call({ headers: { origin: 'http://evil.example.com' }, body: audio })
check(foreignOrigin.status === 403, `cross-site Origin refused (${foreignOrigin.status})`)

const wrongMethod = await call({ method: 'GET', body: audio })
check(wrongMethod.status === 405, `non-POST refused (${wrongMethod.status})`)

const empty = await call({ body: Buffer.alloc(0) })
check(empty.status === 400, `empty body refused (${empty.status})`)

const oversized = await call({ headers: { 'content-length': String(999 * 1024 * 1024) } })
check(oversized.status === 413, `oversized body refused before upload (${oversized.status})`)

const badFormat = await call({ body: audio, query: '?format=mp4' })
check(badFormat.status === 502 && /unsupported response_format/u.test(badFormat.parsed?.error ?? ''), `unknown response_format refused (${badFormat.parsed?.error})`)

// --- the real thing ---------------------------------------------------------

const ok = await call({ body: audio, query: '?name=voice-input.wav' })
check(ok.status === 200, `recording transcribed (HTTP ${ok.status})`)
check(ok.parsed?.ok === true, 'answer carries ok:true')
// Recognition varies slightly run to run ("Harness" has come back as
// "Hardest" once), so assert on the stable words, not the whole sentence.
check(/Speech Recognition Test/u.test(ok.parsed?.text ?? '') && /quick brown fox/u.test(ok.parsed?.text ?? ''), `transcript: ${JSON.stringify(ok.parsed?.text)}`)
check(typeof ok.parsed?.durationSeconds === 'number' && ok.parsed.durationSeconds > 13 && ok.parsed.durationSeconds < 14, `duration reported (${ok.parsed?.durationSeconds})`)
check(ok.headers?.['cache-control'] === 'no-store', 'answer is not cacheable')

const srt = await call({ body: audio, query: '?format=srt' })
check(srt.status === 200 && /-->/u.test(srt.parsed?.text ?? ''), 'srt through the route returns subtitle text')

// --- diagnostics channel ----------------------------------------------------

const emptyLog = await call({ method: 'GET', path: DIAGNOSTICS_ROUTE })
check(emptyLog.status === 200 && Array.isArray(emptyLog.parsed?.events), 'diagnostics log is readable')

const reported = await call({
  body: Buffer.from(JSON.stringify({ event: 'mic-rendered', slot: 'conversation.input.left' })),
  headers: { 'content-type': 'application/json' },
  path: DIAGNOSTICS_ROUTE,
})
check(reported.status === 200 && reported.parsed?.ok === true, 'browser report accepted')

const logged = await call({ method: 'GET', path: DIAGNOSTICS_ROUTE })
check(logged.parsed?.events?.length === 1 && logged.parsed.events[0].event === 'mic-rendered', `log holds the report (${JSON.stringify(logged.parsed?.events?.map(e => e.event))})`)
check(typeof logged.parsed.events[0].at === 'string', 'report is timestamped')

const badReport = await call({ body: Buffer.from('{"nope":1}'), path: DIAGNOSTICS_ROUTE })
check(badReport.status === 400, `malformed report refused (${badReport.status})`)

const crossSiteDiagnostics = await call({ method: 'GET', path: DIAGNOSTICS_ROUTE, headers: { 'sec-fetch-site': 'cross-site' } })
check(crossSiteDiagnostics.status === 403, `diagnostics fence refuses cross-site reads (${crossSiteDiagnostics.status})`)

const unknownRoute = await call({ method: 'GET', path: '/minimax-asr/nope' })
check(unknownRoute.status === 404, `unknown sub-route refused (${unknownRoute.status})`)

console.log('\nvoice-input route: all checks passed')
