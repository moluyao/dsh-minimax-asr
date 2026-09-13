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
import { apply, TRANSCRIBE_ROUTE, DIAGNOSTICS_ROUTE, EVENTS_ROUTE, SPEAK_ROUTE, VOICES_ROUTE } from '../lib/index.js'

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
const listeners = new Map()
const ctx = {
  tools: { register: (tool) => tools.push(tool) },
  effect: (callback) => callback(),
  // Session events are how an announcement reaches the browser; the stub keeps
  // the listeners so a test can drive one.
  on: (name, listener) => { listeners.set(name, listener) },
  logger: { warn: () => {} },
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

check(tools.length === 2, `registered ${tools.length} tools`)
const announceTool = tools.find(candidate => candidate.name === 'announce_speech')
check(announceTool !== undefined, `announce_speech is registered (${tools.map(candidate => candidate.name).join(', ')})`)
check(routes.length === 1, `registered ${routes.length} route`)
check(listeners.has('session/event'), 'subscribed to session events (the announcement hook)')
const route = routes[0]
check(route.path === '/minimax-asr', `route prefix ${route.path}`)
check(route.kind === 'prefix', `route kind ${route.kind}`)
check(TRANSCRIBE_ROUTE === '/minimax-asr/transcribe', 'transcribe path is /minimax-asr/transcribe')
check(DIAGNOSTICS_ROUTE === '/minimax-asr/diagnostics', 'diagnostics path is /minimax-asr/diagnostics')
check(EVENTS_ROUTE === '/minimax-asr/events', 'announcement path is /minimax-asr/events')
check(SPEAK_ROUTE === '/minimax-asr/speak', 'speech path is /minimax-asr/speak')
check(VOICES_ROUTE === '/minimax-asr/voices', 'voice catalogue path is /minimax-asr/voices')

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
  const captured = { status: 0, headers: undefined, body: '', chunks: [], binary: undefined, closeHandlers: [] }
  const response = {
    // The announcement stream registers its cleanup on 'close'; the test fires
    // it by hand so the heartbeat interval does not keep node alive.
    on(name, handler) {
      if (name === 'close') captured.closeHandlers.push(handler)
      return response
    },
    writeHead(status, responseHeaders) {
      captured.status = status
      captured.headers = responseHeaders
    },
    // SSE frames arrive through write(); the announcement test reads them here.
    write(chunk) {
      captured.chunks.push(String(chunk))
      captured.body += String(chunk)
    },
    end(chunk) {
      if (Buffer.isBuffer(chunk)) {
        captured.binary = chunk
        captured.body = `<${chunk.length} bytes>`
        return
      }
      captured.body += chunk === undefined ? '' : String(chunk)
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

// --- announcements: a completed turn becomes one SSE frame -------------------

const sse = await call({ method: 'GET', path: EVENTS_ROUTE })
check(sse.status === 200, `event stream opens (${sse.status})`)
check(String(sse.headers?.['content-type']).startsWith('text/event-stream'), `stream content-type ${sse.headers?.['content-type']}`)

const onSessionEvent = listeners.get('session/event')
const session = {
  id: 'session-test',
  events: [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'text', text: '构建完成。' },
            { type: 'text', text: '**测试**全部通过，`13` 项检查绿灯。' },
          ],
        },
      },
    },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ],
}

onSessionEvent(session, session.events[2])
const frame = sse.chunks.join('')
check(frame.includes('event: announce'), 'a completed turn pushes an announce frame')
check(frame.includes('session-test'), 'the frame names the session it came from')
// Without a named line the fallback is the reply's OPENING SENTENCE, never the
// whole reply read out loud.
const fallback = JSON.parse(/data: (\{.*\})/u.exec(sse.chunks.join(''))[1])
check(fallback.source === 'reply-head', `the fallback is marked as such (${fallback.source})`)
check(fallback.text === '构建完成。', `the fallback is one sentence (${JSON.stringify(fallback.text)})`)
check(!fallback.text.includes('测试'), 'the fallback stops at the first sentence')
check(!/我就不念了|后面还有/u.test(sse.chunks.join('')), 'nothing apologises for its own length')

// A turn that names its own spoken line gets exactly that, and only that.
const named = await announceTool.execute(
  { text: '**三条**音色分组修好了。要不要我接着做下一件事？' },
  { signal: undefined, agent: { session: { header: { id: 'session-test' } } } },
)
check(named.spoken === true && named.characters > 0, `the turn named a spoken line (${named.characters} characters)`)
check(named.text === '三条音色分组修好了。要不要我接着做下一件事？', `markdown is stripped from it (${JSON.stringify(named.text)})`)

const namedBefore = sse.chunks.length
onSessionEvent(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
check(sse.chunks.length > namedBefore, 'the named line is announced')
const namedFrame = JSON.parse(/data: (\{.*\})/u.exec(sse.chunks.slice(namedBefore).join(''))[1])
check(namedFrame.source === 'spoken-line', `the frame says where the line came from (${namedFrame.source})`)
check(namedFrame.text === named.text, `the named line is spoken verbatim (${JSON.stringify(namedFrame.text)})`)
check(!namedFrame.text.includes('构建完成'), 'the reply text does not leak into a named announcement')

// A line over budget is cut at a sentence, with no apology appended.
const long = await announceTool.execute(
  { text: '第一句是结论。第二句是细节说明，这一句本来也不该被念到麦克风里面去，因为它只是给我的眼睛看的补充材料。' },
  { signal: undefined, agent: { session: { header: { id: 'session-test' } } } },
)
const overBefore = sse.chunks.length
onSessionEvent(session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
const overFrame = JSON.parse(/data: (\{.*\})/u.exec(sse.chunks.slice(overBefore).join(''))[1])
check(overFrame.text.length <= 80, `an over-long line is cut to the budget (${overFrame.text.length} chars)`)
check(!/我就不念了|后面还有/u.test(overFrame.text), `the cut is silent (${JSON.stringify(overFrame.text)})`)
check(overFrame.text.startsWith('第一句是结论'), 'the cut keeps the beginning')

// A refused line: an announcement is one or two sentences, not a whole report.
let refused = false
try {
  await announceTool.execute({ text: '很长。'.repeat(400) }, { signal: undefined, agent: { session: { header: { id: 'session-test' } } } })
} catch (error) {
  refused = /distil it further/u.test(error.message)
}
check(refused, 'an essay-length announcement is refused with an explanation')

// `silent: true` suppresses the announcement for that turn only.
const silent = await announceTool.execute({ silent: true }, { signal: undefined, agent: { session: { header: { id: 'session-test' } } } })
check(silent.spoken === false, 'a turn can ask to stay silent')
const silentBefore = sse.chunks.length
onSessionEvent(session, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
const silentFrame = JSON.parse(/data: (\{.*\})/u.exec(sse.chunks.slice(silentBefore).join(''))[1])
check(silentFrame.text === '' && silentFrame.source === 'silent', `silence is honoured (${JSON.stringify(silentFrame)})`)

const framesBefore = sse.chunks.length
onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'cancelled' } } })
check(sse.chunks.length > framesBefore, 'a cancelled turn still pushes a frame')
// `chunks` is live across calls (a shared array); the captured `body` string is
// a snapshot from when the stream was opened.
const cancelled = sse.chunks.slice(framesBefore).join('')
// No words to speak, but the browser's handsfree loop learns that the wait is
// over instead of hanging on a reply that will never arrive.
check(cancelled.includes('"reason":"cancelled"'), `the frame names the reason (${JSON.stringify(cancelled.replace(/\s+/gu, ' ').slice(0, 120))})`)
check(cancelled.includes('"text":""'), 'a wordless turn carries no text to speak')

const refusedStream = await call({ method: 'GET', path: EVENTS_ROUTE, headers: { 'sec-fetch-site': 'cross-site' } })
check(refusedStream.status === 403, `the stream refuses cross-site reads (${refusedStream.status})`)

// Hang up: the listener must disappear, leaving nothing that keeps node alive.
for (const handler of sse.closeHandlers) handler()
const afterHangup = await call({ method: 'GET', path: DIAGNOSTICS_ROUTE })
check(afterHangup.parsed?.listeners === 0, `hanging up drops the announcement listener (${afterHangup.parsed?.listeners} left)`)

// --- speech: real MiniMax TTS through the route ------------------------------

const spoken = await call({ body: Buffer.from(JSON.stringify({ text: '主人，任务已经完成。' })), path: SPEAK_ROUTE })
check(spoken.status === 200, `speech synthesised (HTTP ${spoken.status} ${spoken.body.slice(0, 100)})`)
check(String(spoken.headers?.['content-type']).startsWith('audio/'), `speech content-type ${spoken.headers?.['content-type']}`)
check((spoken.binary?.length ?? 0) > 5000, `speech audio bytes ${spoken.binary?.length}`)
check(String(spoken.headers?.['x-tts-voice'] ?? '') === 'male-qn-jingying', `default voice ${spoken.headers?.['x-tts-voice']}`)

const emptyText = await call({ body: Buffer.from('{}'), path: SPEAK_ROUTE })
check(emptyText.status === 400, `an empty speech request is refused (${emptyText.status})`)

const crossSiteSpeak = await call({
  body: Buffer.from(JSON.stringify({ text: 'hi' })),
  path: SPEAK_ROUTE,
  headers: { 'sec-fetch-site': 'cross-site' },
})
check(crossSiteSpeak.status === 403, `the speech route refuses cross-site calls (${crossSiteSpeak.status})`)

// A per-call voice lets the card audition a voice before saving it.
const otherVoice = await call({
  body: Buffer.from(JSON.stringify({ text: '试试这个音色。', voice: 'female-tianmei', speed: 1.2 })),
  path: SPEAK_ROUTE,
})
check(otherVoice.status === 200, `an auditioned voice synthesises (HTTP ${otherVoice.status} ${otherVoice.body.slice(0, 80)})`)
check(String(otherVoice.headers?.['x-tts-voice'] ?? '') === 'female-tianmei', `the audition uses the requested voice (${otherVoice.headers?.['x-tts-voice']})`)
check((otherVoice.binary?.length ?? 0) > 5000, `auditioned audio bytes ${otherVoice.binary?.length}`)

// --- the voice catalogue -----------------------------------------------------

const catalogue = await call({ method: 'GET', path: VOICES_ROUTE })
check(catalogue.status === 200, `the voice catalogue is served (${catalogue.status} ${catalogue.body.slice(0, 120)})`)
check(Array.isArray(catalogue.parsed?.voices) && catalogue.parsed.voices.length > 50,
  `the catalogue is the account's own (${catalogue.parsed?.voices?.length} voices, source=${catalogue.parsed?.source})`)
const defaultRow = (catalogue.parsed?.voices ?? []).find(voice => voice.id === 'male-qn-jingying')
check(defaultRow !== undefined && typeof defaultRow.name === 'string' && defaultRow.name.length > 0,
  `every voice carries a readable name (${JSON.stringify(defaultRow)})`)
check((catalogue.parsed?.voices ?? []).every(voice => typeof voice.group === 'string' && voice.group.length > 0),
  'every voice is grouped for the picker')
// The heading has to come from the *id*: the display name is Chinese for every
// voice, so grouping by name would put all 303 under one label.
const groups = [...new Set((catalogue.parsed?.voices ?? []).map(voice => voice.group))]
check(groups.length > 5, `the catalogue is grouped by language (${groups.length}: ${groups.slice(0, 8).join(', ')}…)`)
const groupOfVoice = (id) => (catalogue.parsed?.voices ?? []).find(voice => voice.id === id)?.group
check(groupOfVoice('male-qn-jingying') === '国语', `a classic male voice is Mandarin (${groupOfVoice('male-qn-jingying')})`)
check(groupOfVoice('English_Trustworthy_Man') === '英语', `an English voice is its own group (${groupOfVoice('English_Trustworthy_Man')})`)
check(groupOfVoice('Cantonese_ProfessionalHost（M)') === '粤语', `a Cantonese voice is its own group (${groupOfVoice('Cantonese_ProfessionalHost（M)')})`)
check(groupOfVoice('Chinese (Mandarin)_News_Anchor') === '国语', `a Mandarin-prefixed voice is Mandarin (${groupOfVoice('Chinese (Mandarin)_News_Anchor')})`)
check(groupOfVoice('clever_boy') === '其它', `an unprefixed voice is not mistaken for a language (${groupOfVoice('clever_boy')})`)

const crossSiteVoices = await call({ method: 'GET', path: VOICES_ROUTE, headers: { 'sec-fetch-site': 'cross-site' } })
check(crossSiteVoices.status === 403, `the catalogue refuses cross-site reads (${crossSiteVoices.status})`)

const wrongMethodVoices = await call({ method: 'POST', path: VOICES_ROUTE, body: Buffer.from('{}') })
check(wrongMethodVoices.status === 405, `the catalogue is read-only (${wrongMethodVoices.status})`)

console.log('\nvoice-input route: all checks passed')
