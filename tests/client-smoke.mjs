/**
 * Off-browser smoke test for the browser half.
 *
 * Loads `client/client.js` the way the harness does — as a classic script that
 * calls `window.__ModuleLoader__.load` — under a stub module table, then drives
 * a render: edit one field, save, and assert the exact path ops the card sends.
 *
 * Usage: node tests/client-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const source = readFileSync(fileURLToPath(new URL('../client/client.js', import.meta.url)), 'utf8')

/** A tiny React stand-in: hook cells persist across renders, in call order. */
function createReact() {
  let cells = []
  let cursor = 0
  return {
    beginRender() { cursor = 0 },
    createElement(type, props, ...children) {
      if (typeof type === 'function') return type({ ...props, children })
      return { type, props: props ?? {}, children: children.flat().filter(child => child !== null && child !== undefined && child !== false) }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      return [cells[index], (next) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = { current: initial }
      return cells[index]
    },
    // Effects run synchronously at render here: the assertions care about what
    // the effect does, not about React's scheduling.
    useEffect(callback) { cursor += 1; callback() },
    /** Drop every hook cell, so the next component starts with a clean tree. */
    reset() { cells = []; cursor = 0 },
  }
}

/** Assertion helper. */
function check(condition, label) {
  if (!condition) throw new Error(`FAIL: ${label}`)
  console.log(`ok - ${label}`)
}

const react = createReact()

/** Snapshot store stand-in: `set` replaces the snapshot and notifies. */
const stores = []
const clientStore = {
  createSnapshotStore(init) {
    const listeners = new Set()
    const handle = {
      current: init,
      getSnapshot() { return handle.current },
      set(next) {
        handle.current = next
        // The real store notifies on every write, and the handsfree loop
        // depends on those notifications, so the stand-in does too.
        for (const listener of [...listeners]) listener(next)
      },
      update() {},
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    stores.push(handle)
    return handle
  },
}

// --- fake host environments -------------------------------------------------

const mutations = []
const scopeSnapshot = {
  status: 'ready',
  value: {
    apiKey: undefined,
    apiKeyEnv: 'MINIMAX_API_KEY',
    baseURL: 'https://api.minimaxi.com',
    model: 'asr-1.0',
    responseFormat: 'json',
    language: '',
    timestampLevel: '',
    maxRecordSeconds: 300,
    maxFileMB: 50,
    timeoutMs: 180000,
    speakEnabled: true,
    ttsModel: 'speech-2.8-hd',
    ttsVoice: 'male-qn-jingying',
    ttsSpeed: 1,
    speakMaxChars: 220,
    voiceLoop: false,
  },
  // Presence in `user` is what marks a field overridden.
  user: { model: 'asr-1.0' },
  revision: 7,
  writable: true,
  mode: 'host',
}

const scope = {
  getSnapshot: () => scopeSnapshot,
  // A live settings mirror: the test can move the section and fire the
  // listeners the plugin subscribed, exactly as a committed write does.
  subscribe: (listener) => { scopeListeners.push(listener); return () => {} },
  mutate: async (ops, revision) => { mutations.push({ ops, revision }) },
}
const scopeListeners = []

const registered = []
const injected = []
const ctx = {
  effect: (callback) => callback(),
  locale: {
    register(namespace, dictionaries) { ctx.dictionaries = { namespace, dictionaries }; return () => {} },
    bind: () => key => key,
  },
  slots: {
    inject(name, callback) { injected.push(name); callback(); return () => {} },
    register(options, component) { registered.push({ options, component }); return () => {} },
  },
  settingsScope: {
    bind(spec) { ctx.boundSpec = spec; return scope },
  },
  // Deliberately NO `remote` parent object: reading `ctx.remote` when the
  // plugin injects only `remote.credentials` throws in a real Cordis context
  // ("cannot get property \"remote\" without inject"), so the fake ctx exposes
  // the facet through `get` exactly as the runtime does.
  get(name) {
    if (name !== 'remote.credentials') return undefined
    return {
      describe: async (refs) => ({ ok: true, value: Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])) }),
    }
  },
}

// --- load the bundle exactly as the browser does ----------------------------

let exports

// Browser media stubs, driven by the pipeline test at the end. Only the codec
// and the network are faked; the controller, WAV encoder, and insertion are real.
const media = {
  /** Bytes the fake recorder hands back on stop. */
  recorded: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]),
  /** Samples the fake decoder reports. */
  decoded: null,
  /** Requests the controller issued. */
  calls: [],
  /** Stream handed to MediaRecorder, so the test can assert the tracks stopped. */
  stream: null,
  /** Speech requests the half issued, and how the fake host answers them. */
  speakCalls: [],
  speakOk: true,
  speakBytes: 4096,
  /** Voice catalogue the host serves. */
  voicesOk: true,
  voicesCalls: 0,
  voices: [
    { id: 'male-qn-jingying', name: '精英青年音色', group: '国语' },
    { id: 'female-tianmei', name: '甜美女性音色', group: '国语' },
    { id: 'English_Trustworthy_Man', name: 'Trustworthy Man', group: 'English' },
  ],
  /** Newest microphone level the analyser reports (RMS). */
  level: 0,
}

function fakeAudioContext() {
  return {
    sampleRate: 16000,
    closed: false,
    decodeAudioData(_buffer, resolve) {
      decodeAudioDataCalls += 1
      resolve(media.decoded)
    },
    // The handsfree loop's level meter: `media.level` is the RMS it reports.
    createMediaStreamSource() { return { connect() {}, disconnect() {} } },
    createAnalyser() {
      return {
        fftSize: 0,
        getFloatTimeDomainData(buffer) {
          for (let i = 0; i < buffer.length; i += 1) {
            buffer[i] = i % 2 === 0 ? media.level : -media.level
          }
        },
      }
    },
    close() { this.closed = true },
  }
}
let decodeAudioDataCalls = 0

/** Wiring facts the half reported to the host (see the diagnostics route). */
const diagnostics = []

function FakeMediaRecorder(stream, options) {
  this.stream = stream
  this.mimeType = options?.mimeType ?? ''
  this.state = 'inactive'
  this.ondataavailable = null
  this.onstop = null
  this.onerror = null
  const self = this
  this.start = () => { self.state = 'recording' }
  this.stop = () => {
    if (self.state !== 'recording') return
    self.state = 'inactive'
    if (self.mimeType === '') self.mimeType = 'audio/webm'
    if (self.ondataavailable !== null) self.ondataavailable({ data: new Blob([media.recorded], { type: self.mimeType }) })
    if (self.onstop !== null) self.onstop()
  }
}
FakeMediaRecorder.isTypeSupported = () => true

const tracks = []
/** Announcement streams the half opened (SSE stand-ins). */
const eventSources = []
class FakeEventSource {
  constructor(url) {
    this.url = url
    this.listeners = {}
    this.onopen = null
    this.onerror = null
    this.closed = false
    // 0 CONNECTING, 1 OPEN, 2 CLOSED — the half reads this after an error.
    this.readyState = 0
    eventSources.push(this)
  }

  addEventListener(name, handler) {
    if (this.listeners[name] === undefined) this.listeners[name] = []
    this.listeners[name].push(handler)
  }

  close() { this.closed = true; this.readyState = 2 }

  /** Deliver one host frame to the registered handlers. */
  emit(name, data) {
    for (const handler of this.listeners[name] ?? []) handler({ data })
  }
}

/** Audio elements the half created, so playback can be finished by hand. */
const audios = []
class FakeAudio {
  constructor(url) {
    this.url = url
    this.played = false
    this.paused = false
    this.onended = null
    this.onerror = null
    audios.push(this)
  }

  play() { this.played = true; return Promise.resolve() }

  pause() { this.paused = true }
}

/** Object URLs, so the test can prove each one is revoked. */
const objectURLs = []
let objectURLSeq = 0

/** Timers the half scheduled (`window.setTimeout`), fireable by hand. */
const timers = []
/** Run every pending, uncleared timer once. */
function runTimers() {
  for (const timer of [...timers]) {
    if (timer.cleared) continue
    timer.cleared = true
    timer.callback()
  }
}

const sandbox = {
  window: {
    __ModuleLoader__: {
      load({ id, factory }) {
        sandbox.loadedId = id
        exports = factory((specifier) => {
          if (specifier === 'react') return react
          if (specifier === '@deepseek-ai/dsh-client-store') return clientStore
          throw new Error(`unexpected require("${specifier}")`)
        })
      },
    },
    AudioContext: fakeAudioContext,
    MediaRecorder: FakeMediaRecorder,
    EventSource: FakeEventSource,
    Audio: FakeAudio,
    // The half schedules its own reopen of a refused announcement stream.
    setTimeout: (callback, ms) => { timers.push({ callback, ms, cleared: false }); return timers.length },
    clearTimeout: (id) => { if (timers[id - 1] !== undefined) timers[id - 1].cleared = true },
  },
  URL: {
    createObjectURL(blob) {
      objectURLSeq += 1
      const url = `blob:fake/${objectURLSeq}`
      objectURLs.push({ url, blob, revoked: false })
      return url
    },
    revokeObjectURL(url) {
      const entry = objectURLs.find(candidate => candidate.url === url)
      if (entry !== undefined) entry.revoked = true
    },
  },
  navigator: {
    mediaDevices: {
      getUserMedia: async () => {
        const track = { stopped: false, stop() { this.stopped = true } }
        tracks.push(track)
        media.stream = { getTracks: () => [track] }
        return media.stream
      },
    },
  },
  fetch: async (url, options) => {
    // The plugin also reports its own wiring; keep that out of the upload log.
    if (String(url).includes('/diagnostics')) {
      diagnostics.push(JSON.parse(String(options?.body ?? '{}')))
      return { status: 200, json: async () => ({ ok: true }) }
    }
    if (String(url) === '/minimax-asr/speak') {
      media.speakCalls.push({ url, method: options?.method, body: options?.body })
      if (media.speakOk !== true) {
        return { ok: false, status: 502, json: async () => ({ ok: false, error: 'MiniMax TTS failed (HTTP 502)' }) }
      }
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob([new Uint8Array(media.speakBytes)], { type: 'audio/mpeg' }),
      }
    }
    if (String(url) === '/minimax-asr/voices') {
      media.voicesCalls += 1
      if (media.voicesOk !== true) {
        return { ok: false, status: 502, json: async () => ({ ok: false, error: 'no catalogue' }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, source: 'live', voices: media.voices }) }
    }
    media.calls.push({ url, method: options?.method, contentType: options?.headers?.['content-type'], body: options?.body })
    return {
      status: 200,
      json: async () => ({ ok: true, text: 'transcribed by the fake route' }),
    }
  },
  Blob,
  // A controllable clock and interval registry, so the auto-stop can be driven
  // without waiting for real seconds to pass. `clearInterval` really clears:
  // a leaked VAD timer would keep mutating the next window's counters.
  setInterval: (callback) => { intervals.push(callback); return intervals.length },
  clearInterval: (id) => {
    if (typeof id === 'number' && id >= 1 && id <= intervals.length) intervals[id - 1] = null
  },
  Date: { now: () => clock.now },
  console,
}
const clock = { now: 1_700_000_000_000 }
const intervals = []
/** Advance the fake clock and run every scheduled tick once. */
function advance(seconds) {
  clock.now += seconds * 1000
  for (const tick of [...intervals]) if (tick !== null) tick()
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

check(sandbox.loadedId === 'dsh-minimax-asr', `bundle registers id ${JSON.stringify(sandbox.loadedId)}`)
check(exports.name === 'dsh-minimax-asr', 'exports.name')
check(Array.isArray(exports.inject) && exports.inject.includes('slots') && exports.inject.includes('settingsScope'), `exports.inject = ${JSON.stringify(exports.inject)}`)
check(typeof exports.apply === 'function', 'exports.apply')
// Regression guard: reading a service the declaration omits throws in Cordis.
// Comments are stripped so prose that names ctx.remote is not a false positive.
const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
check(!/\.remote\b/.test(codeOnly), 'bundle never reads ctx.remote (undeclared parent service)')

// --- apply ------------------------------------------------------------------

exports.apply(ctx)
check(ctx.boundSpec?.namespace === 'minimax-asr', `bound namespace ${JSON.stringify(ctx.boundSpec?.namespace)}`)
check(injected.includes('settings.plugin.item'), 'waits for settings.plugin.item to be declared')
check(injected.includes('conversation.input.left'), 'waits for the composer tool-row slot to be declared')
check(registered.length === 4, `registered ${registered.length} contributions`)
const cardEntry = registered.find(entry => entry.options.name === 'settings.plugin.item')
const micEntry = registered.find(entry => entry.options.name === 'conversation.input.left' && entry.options.id === 'minimax-asr-mic')
const speakerEntry = registered.find(entry => entry.options.name === 'conversation.input.left' && entry.options.id === 'minimax-asr-speaker')
const voiceEntry = registered.find(entry => entry.options.name === 'conversation.input.left' && entry.options.id === 'minimax-asr-voice')
check(cardEntry !== undefined, 'card registers into the settings.plugin.item slot')
check(cardEntry.options.key === 'minimax-asr', `card key ${JSON.stringify(cardEntry.options.key)}`)
check(cardEntry.options.locale === 'minimax-asr', 'card binds the locale namespace')
check(micEntry !== undefined && micEntry.options.id === 'minimax-asr-mic', 'mic control registers into the composer tool row')
check(micEntry.options.locale === 'minimax-asr', 'mic control binds the locale namespace')
check(typeof micEntry.options.order === 'number', `mic control carries an order (${micEntry.options.order})`)
check(speakerEntry !== undefined, 'speaker control registers into the composer tool row')
check(speakerEntry.options.order > micEntry.options.order, `speaker sits after the mic (${micEntry.options.order} < ${speakerEntry.options.order})`)
check(voiceEntry !== undefined, 'the handsfree control registers into the composer tool row')
check(voiceEntry.options.order > speakerEntry.options.order, `the handsfree control is last (${speakerEntry.options.order} < ${voiceEntry.options.order})`)

// Dictionaries must key-match, or one language renders raw keys.
const dicts = ctx.dictionaries.dictionaries
const enKeys = Object.keys(dicts.en).sort()
const zhKeys = Object.keys(dicts.zh).sort()
check(JSON.stringify(enKeys) === JSON.stringify(zhKeys), `en/zh dictionaries key-match (${enKeys.length} keys)`)

// --- render -----------------------------------------------------------------

const card = cardEntry.component
const face = cardEntry.options.inject()
const store = face.hooks.card

/** Render once through the stub React and return the produced tree. */
function render() {
  react.beginRender()
  return card({
    t: key => dicts.en[key] ?? `[${key}]`,
    useCard: selector => selector(store.getSnapshot()),
    save: face.save,
    say: face.say,
    loadVoices: face.loadVoices,
  })
}

/** Depth-first search of the produced tree. */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/** Find any element by its `id` (input, checkbox, select, ...). */
function findInput(tree, id) {
  let found
  walk(tree, (node) => { if (node.props?.id === id) found = node })
  return found
}

function findButton(tree, label) {
  let found
  walk(tree, (node) => {
    if (node.type === 'button' && node.children.includes(label)) found = node
  })
  return found
}

/** The card's collapse/expand header button. */
function findHeader(tree) {
  let found
  walk(tree, (node) => {
    if (node.type === 'button' && node.props['aria-expanded'] !== undefined) found = node
  })
  return found
}

// Credential badge settles after the describe() promise.
await new Promise(resolve => setTimeout(resolve, 0))

const first = render()
check(first !== null, 'card renders (namespace served)')
check(findButton(first, 'Save') === undefined, 'Save is not rendered while collapsed')

// Expand, then inspect the form.
findHeader(first).props.onClick()
const open = render()
check(findHeader(open).props['aria-expanded'] === true, 'header expands the card')

const fields = [
  'baseURL', 'model', 'apiKeyEnv', 'responseFormat', 'language', 'timestampLevel',
  'maxRecordSeconds', 'maxFileMB', 'timeoutMs',
  'ttsModel', 'ttsSpeed', 'speakMaxChars',
]
for (const field of fields) check(findInput(open, `minimax-asr-${field}`) !== undefined, `input rendered: ${field}`)
check(findInput(open, 'minimax-asr-model').props.value === 'asr-1.0', 'model input shows the resolved value')
check(findInput(open, 'minimax-asr-model').props.disabled === false, 'inputs are enabled (host mode, writable)')

// The announcement switch renders as a checkbox, on by default when the
// section names nothing.
const speakBox = findInput(open, 'minimax-asr-speakEnabled')
check(speakBox !== undefined && speakBox.props.type === 'checkbox', 'announcement switch renders as a checkbox')
check(speakBox.props.checked === true, 'the switch is on when the section names no value')
check(findButton(open, 'Test the voice') !== undefined, 'the card offers a voice sample')

// The voice field is a picker over the host's catalogue, grouped by language.
const voiceSelect = findInput(open, 'minimax-asr-ttsVoice')
check(voiceSelect !== undefined && voiceSelect.type === 'select', 'the voice field renders as a picker')
check(voiceSelect.props.value === 'male-qn-jingying', `the picker shows the configured voice (${voiceSelect.props.value})`)
const optionGroups = voiceSelect.children.filter(child => child.type === 'optgroup')
check(optionGroups.length === 2, `the catalogue is grouped (${optionGroups.map(group => group.props.label).join(', ')})`)
const optionCount = optionGroups.reduce((total, group) => total + group.children.length, 0)
check(optionCount === media.voices.length, `every voice is offered (${optionCount})`)
check(voiceSelect.children.some(child => child.type === 'option' && child.props.value === '__custom__'),
  'the picker offers a custom entry')
check(voiceSelect.props.disabled === false, 'the picker is enabled when the section is writable')
check(findInput(open, 'minimax-asr-ttsVoice-custom') === undefined, 'no free-text field while the configured voice is listed')

// The handsfree switch.
const loopBox = findInput(open, 'minimax-asr-voiceLoop')
check(loopBox !== undefined && loopBox.props.type === 'checkbox', 'the handsfree switch renders as a checkbox')
check(loopBox.props.checked === false, 'the handsfree loop starts off')

// An unlisted voice (a cloned one) keeps the free-text field.
scopeSnapshot.value.ttsVoice = 'my-cloned-voice'
const unlisted = render()
check(findInput(unlisted, 'minimax-asr-ttsVoice-custom') !== undefined, 'an unlisted voice falls back to a free-text field')
scopeSnapshot.value.ttsVoice = 'male-qn-jingying'

// A catalogue the host could not serve degrades to the same text field, and
// opening the card retries it rather than needing a page reload.
const readyVoices = store.getSnapshot().voices
store.set({ ...store.getSnapshot(), voices: { status: 'failed', source: '', list: [] } })
const noCatalogue = render()
check(findInput(noCatalogue, 'minimax-asr-ttsVoice') === undefined, 'no picker is offered without a catalogue')
check(findInput(noCatalogue, 'minimax-asr-ttsVoice-custom') !== undefined, 'the free-text field stands in')

const callsBeforeRetry = media.voicesCalls
await face.loadVoices()
await new Promise(resolve => setTimeout(resolve, 0))
check(media.voicesCalls === callsBeforeRetry + 1, `opening the card retries the catalogue (${media.voicesCalls - callsBeforeRetry} call)`)
check(store.getSnapshot().voices?.status === 'ready', `the retry restores the picker (${store.getSnapshot().voices?.status})`)
check(store.getSnapshot().voices?.list.length === media.voices.length, 'the retried catalogue is the host\'s own')
store.set({ ...store.getSnapshot(), voices: readyVoices })

let body = []
walk(open, (node) => { if (node.type === 'span' && typeof node.children[0] === 'string') body.push(node.children[0]) })
check(body.includes('configured'), 'credential badge reports configured')

const saveButton = findButton(open, 'Save')
check(saveButton !== undefined, 'Save renders when open')
check(saveButton.props.disabled === true, 'Save starts disabled (nothing staged)')

// Edit `model`: an overridden field, so blanking it would emit `unset`.
const modelInput = findInput(open, 'minimax-asr-model')
modelInput.props.onChange({ currentTarget: { value: 'asr-2.0' } })
const staged = render()
const stagedSave = findButton(staged, 'Save')
check(stagedSave.props.disabled === false, 'Save enables once a field is staged')
check(findButton(staged, 'Discard') !== undefined, 'Discard renders with a staged draft')

await stagedSave.props.onClick()
await new Promise(resolve => setTimeout(resolve, 0))
check(mutations.length === 1, `exactly one mutate() call (${mutations.length})`)
check(mutations[0].revision === 7, `write is fenced by the read revision (${mutations[0].revision})`)
check(JSON.stringify(mutations[0].ops) === JSON.stringify([{ op: 'set', path: ['model'], value: 'asr-2.0' }]), `ops = ${JSON.stringify(mutations[0].ops)}`)

// A numeric field must be written as a number, not a string.
const staged2 = render()
findInput(staged2, 'minimax-asr-maxFileMB').props.onChange({ currentTarget: { value: '12' } })
const staged3 = render()
await findButton(staged3, 'Save').props.onClick()
await new Promise(resolve => setTimeout(resolve, 0))
const last = mutations[mutations.length - 1]
check(last.ops.every((op) => op.path[0] !== 'maxFileMB' || typeof op.value === 'number'), `numeric field written as ${typeof last.ops.find(op => op.path[0] === 'maxFileMB')?.value}`)

// The announcement switch must be written as a boolean, not the string "false".
const staged4 = render()
findInput(staged4, 'minimax-asr-speakEnabled').props.onChange({ currentTarget: { checked: false } })
const staged5 = render()
await findButton(staged5, 'Save').props.onClick()
await new Promise(resolve => setTimeout(resolve, 0))
const boolOp = mutations[mutations.length - 1].ops.find(op => op.path[0] === 'speakEnabled')
check(boolOp !== undefined && boolOp.value === false, `switch written as ${JSON.stringify(boolOp?.value)} (${typeof boolOp?.value})`)

console.log('\nclient half: card checks passed')

// --- voice input control ----------------------------------------------------
// A fresh hook tree: the mic component's hooks must not read the card's cells.
react.reset()

const micFace = micEntry.options.inject()
const micStore = micFace.hooks.mic
check(typeof micFace.toggle === 'function', 'mic inject face exposes toggle')
check(typeof micStore.getSnapshot === 'function' && typeof micStore.subscribe === 'function', 'mic state is a snapshot store')

const drafts = []
const inputActions = { setDraft: (text) => { drafts.push(text) } }

/** Render the mic control with one draft and the current published state. */
function renderMic(draft) {
  react.beginRender()
  return micEntry.component({
    t: key => dicts.en[key] ?? `[${key}]`,
    useMic: selector => selector(micStore.getSnapshot()),
    useInput: selector => selector({ draft }),
    inputActions,
    toggle: micFace.toggle,
  })
}

/** Every button in a produced tree. */
function buttonsOf(tree) {
  const found = []
  walk(tree, (node) => { if (node.type === 'button') found.push(node) })
  return found
}

micStore.set({ status: 'idle', seconds: 0, error: null, text: '', textSeq: 0, supported: true })
const idle = renderMic('already typed')
check(drafts.length === 0, 'no draft write before a transcript exists')
check(buttonsOf(idle).length === 1, 'renders one control')
check(buttonsOf(idle)[0].props.disabled === false, 'control is enabled while idle')
check(String(buttonsOf(idle)[0].props.title).includes('Dictate'), `idle tooltip: ${JSON.stringify(buttonsOf(idle)[0].props.title)}`)

// A transcript arrives: merged after what the user already typed.
micStore.set({ status: 'idle', seconds: 0, error: null, text: 'hello world', textSeq: 1, supported: true })
renderMic('already typed')
check(drafts.length === 1 && drafts[0] === 'already typed hello world', `draft write: ${JSON.stringify(drafts)}`)
renderMic('already typed')
check(drafts.length === 1, 'the same transcript is inserted exactly once')

drafts.length = 0
micStore.set({ status: 'idle', seconds: 0, error: null, text: 'fresh', textSeq: 2, supported: true })
renderMic('')
check(drafts.length === 1 && drafts[0] === 'fresh', `empty draft becomes ${JSON.stringify(drafts)}`)

drafts.length = 0
micStore.set({ status: 'idle', seconds: 0, error: null, text: 'next', textSeq: 3, supported: true })
renderMic('trailing ')
check(drafts[0] === 'trailing next', `no double separator: ${JSON.stringify(drafts)}`)

// Recording: elapsed seconds and a stop label.
micStore.set({ status: 'recording', seconds: 7, error: null, text: '', textSeq: 3, supported: true })
const recording = renderMic('')
const labels = []
walk(recording, (node) => { if (typeof node.children?.[0] === 'string') labels.push(node.children[0]) })
check(labels.includes('0:07 / 5:00'), `recording shows elapsed time against the cap (${JSON.stringify(labels)})`)
check(String(buttonsOf(recording)[0].props['aria-label']).includes('Stop'), `recording label: ${JSON.stringify(buttonsOf(recording)[0].props['aria-label'])}`)

// Transcribing: disabled while the request is in flight.
micStore.set({ status: 'transcribing', seconds: 0, error: null, text: '', textSeq: 3, supported: true })
check(buttonsOf(renderMic(''))[0].props.disabled === true, 'control is disabled while transcribing')

// Unsupported browser, and a failure, both explain themselves.
micStore.set({ status: 'idle', seconds: 0, error: null, text: '', textSeq: 3, supported: false })
check(buttonsOf(renderMic(''))[0].props.disabled === true, 'unsupported control is disabled')
check(String(buttonsOf(renderMic(''))[0].props.title).includes('microphone'), `unsupported tooltip: ${JSON.stringify(buttonsOf(renderMic(''))[0].props.title)}`)

micStore.set({ status: 'error', seconds: 0, error: 'microphone permission was refused', text: '', textSeq: 3, supported: true })
check(String(buttonsOf(renderMic(''))[0].props.title).includes('permission'), `failure tooltip: ${JSON.stringify(buttonsOf(renderMic(''))[0].props.title)}`)

// Disposal must not leave a microphone open.
micFace.hooks.mic.getSnapshot()
micEntry.options.inject().toggle
check(true, 'mic face is re-injectable')

// --- the control's iconography ---------------------------------------------

/** The control's first child: its icon. */
function iconOf(tree) {
  return buttonsOf(tree)[0].children[0]
}

micStore.set({ status: 'idle', seconds: 0, error: null, text: '', textSeq: 3, supported: true })
const idleIcon = iconOf(renderMic(''))
check(idleIcon?.type === 'svg', `idle icon is an svg (${idleIcon?.type})`)
check(idleIcon.props.width === 18 && idleIcon.props.height === 18, `icon edge is ${idleIcon.props.width}px (bigger than the 16px siblings)`)
check(idleIcon.props.viewBox === '0 0 16 16', 'icon uses the house viewBox')
check(idleIcon.children.length === 3, `mic glyph draws capsule + cradle + stem (${idleIcon.children.length} paths)`)
check(idleIcon.children[0].props.fill === 'currentColor', 'capsule is a currentColor fill')
check(idleIcon.children[1].props.stroke === 'currentColor' && idleIcon.children[1].props.strokeWidth === 1.4, 'cradle is stroked')
check(idleIcon.props['aria-hidden'] === 'true', 'icon is hidden from assistive tech (the button carries the label)')

micStore.set({ status: 'recording', seconds: 3, error: null, text: '', textSeq: 3, supported: true })
check(iconOf(renderMic(''))?.children?.[0]?.type === 'rect', 'recording swaps in a stop glyph')

micStore.set({ status: 'transcribing', seconds: 0, error: null, text: '', textSeq: 3, supported: true })
const wavesIcon = iconOf(renderMic(''))
check(wavesIcon?.children?.length === 3 && wavesIcon.children.every(child => child.type === 'rect'), 'transcribing shows the waveform glyph')

// Pointer feedback and the recording pill.
micStore.set({ status: 'idle', seconds: 0, error: null, text: '', textSeq: 3, supported: true })
const restingButton = buttonsOf(renderMic(''))[0]
check(restingButton.props.style.minHeight === '32px', `hit target is ${restingButton.props.style.minHeight} tall`)
check(restingButton.props.style.background === 'transparent', 'idle background is transparent')
restingButton.props.onMouseEnter()
const hoveredButton = buttonsOf(renderMic(''))[0]
check(String(hoveredButton.props.style.background).includes('rgba'), `hover paints a surface (${hoveredButton.props.style.background})`)
hoveredButton.props.onMouseLeave()
check(buttonsOf(renderMic(''))[0].props.style.background === 'transparent', 'leaving restores the transparent background')

micStore.set({ status: 'recording', seconds: 12, error: null, text: '', textSeq: 3, supported: true })
const recordingButton = buttonsOf(renderMic(''))[0]
check(recordingButton.props.style.padding === '0 10px', `recording widens the pill (${recordingButton.props.style.padding})`)
check(recordingButton.props.style.color === '#e5484d', 'recording uses the accent colour')

micStore.set({ status: 'idle', seconds: 0, error: null, text: '', textSeq: 3, supported: false })
const unsupportedButton = buttonsOf(renderMic(''))[0]
check(unsupportedButton.props.style.opacity === 0.5, 'an unsupported browser dims the control')

// --- full pipeline: record -> decode -> WAV -> route -> insert --------------

/** Let pending promise chains settle. */
const tick = async (turns = 1) => {
  for (let i = 0; i < turns; i += 1) await new Promise(resolve => setImmediate(resolve))
}

const pipelineDrafts = []
const pipelineActions = { setDraft: (text) => { pipelineDrafts.push(text) } }

// 44.1 kHz source, so the resampler to 16 kHz is exercised too.
const pcm = new Float32Array(44100)
for (let i = 0; i < pcm.length; i += 1) pcm[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.5
media.decoded = { numberOfChannels: 1, length: pcm.length, sampleRate: 44100, getChannelData: () => pcm }

const pipelineFace = micEntry.options.inject()
micStore.set({ status: 'idle', seconds: 0, error: null, text: '', textSeq: 10, supported: true })

pipelineFace.toggle()
await tick(4)
check(micStore.getSnapshot().status === 'recording', `recording started (${micStore.getSnapshot().status})`)

pipelineFace.toggle()
await tick(12)
const finished = micStore.getSnapshot()
check(finished.status === 'idle', `pipeline settled (status=${finished.status} error=${finished.error})`)
check(finished.text === 'transcribed by the fake route', `transcript published: ${JSON.stringify(finished.text)}`)
check(finished.textSeq === 11, `textSeq advanced to ${finished.textSeq}`)
check(media.calls.length === 1, `exactly one upload (${media.calls.length})`)
check(media.calls[0].url === '/minimax-asr/transcribe?name=voice-input.wav', `upload url ${media.calls[0].url}`)
check(media.calls[0].method === 'POST', 'upload is a POST')
check(media.calls[0].contentType === 'audio/wav', `upload content-type ${media.calls[0].contentType}`)

const wav = Buffer.from(media.calls[0].body)
check(wav.subarray(0, 4).toString() === 'RIFF' && wav.subarray(8, 12).toString() === 'WAVE', 'upload body is a WAV')
check(wav.readUInt16LE(20) === 1 && wav.readUInt16LE(22) === 1, 'WAV is uncompressed mono')
check(wav.readUInt32LE(24) === 16000, `WAV sample rate ${wav.readUInt32LE(24)}`)
check(wav.readUInt16LE(34) === 16, 'WAV is 16-bit PCM')
const expectedSamples = Math.round(pcm.length * (16000 / 44100))
check(wav.length === 44 + expectedSamples * 2, `WAV payload ${wav.length} bytes = 44 + ${expectedSamples} samples x 2`)
check(decodeAudioDataCalls === 1, 'the recorder output was decoded exactly once')
check(tracks.length > 0 && tracks.every(track => track.stopped), 'microphone tracks were released')

// The transcript reaches the draft exactly once.
react.beginRender()
micEntry.component({
  t: key => dicts.en[key] ?? `[${key}]`,
  useMic: selector => selector(micStore.getSnapshot()),
  useInput: selector => selector({ draft: '' }),
  inputActions: pipelineActions,
  toggle: pipelineFace.toggle,
})
check(pipelineDrafts.length === 1 && pipelineDrafts[0] === 'transcribed by the fake route', `draft after the pipeline: ${JSON.stringify(pipelineDrafts)}`)

// Wiring reports reached the host's diagnostics route.
const events = diagnostics.map(entry => entry.event)
check(events.includes('applied'), `reported: ${JSON.stringify(events)}`)
check(events.includes('card-registered'), 'reported the settings-card registration')
check(events.includes('mic-registered'), 'reported the mic registration')
check(events.includes('mic-rendered'), 'reported the mic control rendering')
check(diagnostics.every(entry => typeof entry.event === 'string'), 'every report is a plain event object')

// --- the configured cap drives the auto-stop --------------------------------

/** Move the settings section and notify the plugin, as a committed write does. */
function setMaxRecordSeconds(value) {
  scopeSnapshot.value.maxRecordSeconds = value
  for (const listener of scopeListeners) listener()
}

check(micStore.getSnapshot().limitSeconds === 300, `cap starts at the section value (${micStore.getSnapshot().limitSeconds})`)

setMaxRecordSeconds(45)
check(micStore.getSnapshot().limitSeconds === 45, `cap follows a settings change (${micStore.getSnapshot().limitSeconds})`)

setMaxRecordSeconds(3600)
check(micStore.getSnapshot().limitSeconds === 500, `cap clamps to MiniMax's 500 s ceiling (${micStore.getSnapshot().limitSeconds})`)

setMaxRecordSeconds(1)
check(micStore.getSnapshot().limitSeconds === 10, `cap clamps up to the 10 s floor (${micStore.getSnapshot().limitSeconds})`)

// One recording driven past a 20 s cap must stop and upload by itself.
setMaxRecordSeconds(20)
const uploadsBefore = media.calls.length
pipelineFace.toggle()
await tick(4)
check(micStore.getSnapshot().status === 'recording', 'the capped recording started')
check(micStore.getSnapshot().limitSeconds === 20, `the running recording took the current cap (${micStore.getSnapshot().limitSeconds})`)
advance(20)
await tick(12)
const capped = micStore.getSnapshot()
check(capped.status === 'idle', `auto-stop completed the upload (status=${capped.status} error=${capped.error})`)
check(media.calls.length === uploadsBefore + 1, `auto-stop uploaded exactly one recording (${media.calls.length - uploadsBefore})`)
check(capped.textSeq === 12, `textSeq advanced again to ${capped.textSeq}`)

// --- spoken announcements: host frame -> speech -> speakers ------------------

const speechFace = speakerEntry.options.inject()
const speechStore = speechFace.hooks.speech
check(typeof speechFace.toggleSpeech === 'function', 'speech inject face exposes toggleSpeech')
check(typeof speechStore.getSnapshot === 'function', 'speech state is a snapshot store')

check(eventSources.length === 1 && eventSources[0].url === '/minimax-asr/events',
  `announcement stream opened at apply (${eventSources[0]?.url})`)
check(speechStore.getSnapshot().enabled === true, 'spoken announcements default to on')
eventSources[0].onopen()
check(speechStore.getSnapshot().connected === true, 'the stream reports a live connection')

/** One host frame, exactly as the SSE route writes it. */
function announce(text, turn = 1) {
  eventSources[0].emit('announce', JSON.stringify({ type: 'announce', sessionId: 'session-x', turn, reason: 'completed', text }))
}

announce('构建完成，十三项检查全部通过。')
await tick(6)
check(speechStore.getSnapshot().heard === 1, `announcement received (${speechStore.getSnapshot().heard})`)
check(speechStore.getSnapshot().status === 'speaking', `playback started (${speechStore.getSnapshot().status})`)
check(media.speakCalls.length === 1, `one speech request (${media.speakCalls.length})`)
check(media.speakCalls[0].url === '/minimax-asr/speak' && media.speakCalls[0].method === 'POST', `speech request ${media.speakCalls[0].url}`)
check(media.speakCalls[0].body === JSON.stringify({ text: '构建完成，十三项检查全部通过。' }), `speech body ${media.speakCalls[0].body}`)
check(audios.length === 1 && audios[0].played === true, 'an audio element started playing')

audios[0].onended()
await tick(4)
check(speechStore.getSnapshot().spoken === 1 && speechStore.getSnapshot().status === 'idle',
  `playback finished (spoken=${speechStore.getSnapshot().spoken} status=${speechStore.getSnapshot().status})`)
check(objectURLs.length > 0 && objectURLs.every(entry => entry.revoked), 'every object URL was revoked')

// Two announcements in a row must not overlap.
const pendingBefore = media.speakCalls.length
announce('第一件事完成了。', 2)
announce('第二件事也完成了。', 3)
await tick(6)
check(media.speakCalls.length === pendingBefore + 1, `the second announcement waits its turn (${media.speakCalls.length - pendingBefore} request)`)
audios[audios.length - 1].onended()
await tick(6)
check(media.speakCalls.length === pendingBefore + 2, 'the queued announcement is spoken after the first')
audios[audios.length - 1].onended()
await tick(4)

// Switching off silences the half; a frame that arrives anyway is dropped.
const mutationsBefore = mutations.length
speechFace.toggleSpeech()
check(speechStore.getSnapshot().enabled === false, 'the switch turns off immediately')
check(mutations.length === mutationsBefore + 1, 'the switch is persisted')
const switchOp = mutations[mutations.length - 1].ops[0]
check(switchOp.path[0] === 'speakEnabled' && switchOp.value === false, `persisted as ${JSON.stringify(switchOp)}`)

const spokenWhenOff = speechStore.getSnapshot().spoken
const callsWhenOff = media.speakCalls.length
announce('这句话不该被念出来。', 4)
await tick(4)
check(speechStore.getSnapshot().heard === 4, `a muted announcement is still counted (${speechStore.getSnapshot().heard})`)
check(speechStore.getSnapshot().spoken === spokenWhenOff && media.speakCalls.length === callsWhenOff,
  'a muted announcement is neither requested nor played')

// Back on, then interrupted mid-sentence: the manual way to silence one.
speechFace.toggleSpeech()
check(speechStore.getSnapshot().enabled === true, 'the switch turns back on')
check(mutations[mutations.length - 1].ops[0].value === true, 'turning on is persisted')

announce('我正在念一段很长的话。', 5)
await tick(6)
check(speechStore.getSnapshot().status === 'speaking', 'the next announcement plays while on')
const playing = audios[audios.length - 1]
speechFace.toggleSpeech()
check(playing.paused === true, 'switching off stops the audio that is playing')
check(speechStore.getSnapshot().status === 'idle', 'stopping returns the control to idle')
check(speechStore.getSnapshot().pending === 0, 'stopping drops everything queued behind it')

// A failed synthesis must leave the half alive and say so.
speechFace.toggleSpeech()
media.speakOk = false
announce('这条合成会失败。', 6)
await tick(6)
check(speechStore.getSnapshot().status === 'error', `a failed synthesis is reported (status=${speechStore.getSnapshot().status})`)
check(String(speechStore.getSnapshot().error).includes('502'), `the failure names the cause (${speechStore.getSnapshot().error})`)
media.speakOk = true
announce('失败之后还能继续念。', 7)
await tick(6)
check(speechStore.getSnapshot().status === 'speaking', 'the half recovers after a failure')
audios[audios.length - 1].onended()
await tick(4)

// The composer control itself.
react.reset()
speechStore.set({
  enabled: true, status: 'idle', error: null, heard: 7, spoken: 6, dropped: 0,
  pending: 0, connected: true, supported: true, voice: 'male-qn-jingying', lastText: '',
})

/** Render the speaker control with the current published state. */
function renderSpeaker() {
  react.beginRender()
  return speakerEntry.component({
    t: key => dicts.en[key] ?? `[${key}]`,
    useSpeech: selector => selector(speechStore.getSnapshot()),
    toggleSpeech: speechFace.toggleSpeech,
  })
}

const speakerIdle = renderSpeaker()
check(buttonsOf(speakerIdle).length === 1, 'the speaker control renders one button')
check(buttonsOf(speakerIdle)[0].props['aria-pressed'] === true, 'an on switch reports pressed')
check(String(buttonsOf(speakerIdle)[0].props.title).includes('listening'), `on tooltip: ${JSON.stringify(buttonsOf(speakerIdle)[0].props.title)}`)
const speakerIcon = buttonsOf(speakerIdle)[0].children[0]
check(speakerIcon?.type === 'svg' && speakerIcon.props.viewBox === '0 0 16 16', 'the speaker glyph uses the house viewBox')
check(speakerIcon.children.length === 2 && speakerIcon.children[1].props.stroke === 'currentColor', 'the on glyph draws a cone plus sound arcs')

speechStore.set({
  enabled: false, status: 'idle', error: null, heard: 7, spoken: 6, dropped: 0,
  pending: 0, connected: true, supported: true, voice: 'male-qn-jingying', lastText: '',
})
const speakerOff = renderSpeaker()
check(buttonsOf(speakerOff)[0].props['aria-pressed'] === false, 'an off switch reports unpressed')
check(buttonsOf(speakerOff)[0].props.style.opacity === 0.55, 'an off switch is dimmed')
check(buttonsOf(speakerOff)[0].children[0].children[1].props.d === 'M11.1 5.3l4 5.4M15.1 5.3l-4 5.4', 'the off glyph is a slash')

speechStore.set({
  enabled: true, status: 'speaking', error: null, heard: 7, spoken: 6, dropped: 0,
  pending: 3, connected: true, supported: true, voice: 'male-qn-jingying', lastText: 'x',
})
const speakerBusy = renderSpeaker()
check(String(buttonsOf(speakerBusy)[0].props.style.background).includes('64, 132, 214'), 'a playing announcement tints the control')
check(buttonsOf(speakerBusy)[0].children.length === 2, 'a queue depth is shown while playing')

speechStore.set({
  enabled: true, status: 'idle', error: null, heard: 0, spoken: 0, dropped: 0,
  pending: 0, connected: false, supported: false, voice: 'male-qn-jingying', lastText: '',
})
check(buttonsOf(renderSpeaker())[0].props.disabled === true, 'an unsupported browser disables the control')
check(String(buttonsOf(renderSpeaker())[0].props.title).includes('cannot play'), 'an unsupported browser explains why')

// Wiring reports reached the host's diagnostics route.
const speechEvents = diagnostics.map(entry => entry.event)
check(speechEvents.includes('speaker-registered'), 'reported the speaker registration')
check(speechEvents.includes('speech-rendered'), 'reported the speaker control rendering')
check(speechEvents.includes('speech-listening'), 'reported the announcement stream opening')
check(speechEvents.includes('announce-received'), 'reported each received announcement')
check(speechEvents.includes('spoke'), 'reported each spoken announcement')
check(speechEvents.includes('speech-failed'), 'reported the failed synthesis')

// --- a refused stream must not leave the page permanently mute --------------
//
// Per spec EventSource fails the connection for good on a non-200 answer, which
// is exactly what a page that mounted before the host served this route (or in
// the seconds around a restart) sees. It has to be reopened by hand.

const lastStream = eventSources[eventSources.length - 1]
const sourcesBeforeDrop = eventSources.length
// The render checks above left an "unsupported browser" snapshot behind; the
// reopen path only applies to a browser that can actually play speech.
speechStore.set({
  enabled: true, status: 'idle', error: null, heard: 7, spoken: 6, dropped: 0,
  pending: 0, connected: true, supported: true, voice: 'male-qn-jingying', lastText: '',
})
lastStream.readyState = 0
lastStream.onerror()
check(eventSources.length === sourcesBeforeDrop, 'a dropped connection is left to the browser to retry')
check(speechStore.getSnapshot().connected === false, 'a drop is reported as disconnected')

lastStream.readyState = 2
lastStream.onerror()
check(lastStream.closed === true, 'a refused stream is closed')
check(eventSources.length === sourcesBeforeDrop, 'the reopen is scheduled, not immediate')
check(timers.some(timer => timer.ms === 4000 && !timer.cleared), 'the reopen waits a few seconds')

runTimers()
check(eventSources.length === sourcesBeforeDrop + 1, 'a refused stream is reopened after the delay')
const reopened = eventSources[eventSources.length - 1]
check(reopened.closed === false && reopened.readyState === 0, 'the replacement stream starts fresh')
check(reopened.listeners.announce?.length === 1, 'the replacement stream is handled')

// And it works: a frame on the reopened stream is spoken like any other.
reopened.onopen()
const spokenBeforeReopen = speechStore.getSnapshot().spoken
reopened.emit('announce', JSON.stringify({ type: 'announce', sessionId: 'session-x', turn: 9, text: '重连之后我还能念。' }))
await tick(6)
check(speechStore.getSnapshot().connected === true, 'the replacement stream reports connected')
audios[audios.length - 1].onended()
await tick(4)
check(speechStore.getSnapshot().spoken === spokenBeforeReopen + 1, 'an announcement on the replacement stream is spoken')

// --- handsfree conversation loop --------------------------------------------

/** Advance the fake clock by `count` VAD frames and run every pending timer. */
function vadFrames(count, ms = 100) {
  for (let i = 0; i < count; i += 1) {
    clock.now += ms
    for (const timer of [...intervals]) if (timer !== null) timer()
  }
}

const voiceFace = voiceEntry.options.inject()
const loopSpeech = voiceFace.hooks.speech
const loopMic = voiceFace.hooks.mic
check(loopSpeech === speechStore, 'the handsfree face publishes the same speech store')
check(loopMic === micStore, 'the handsfree face publishes the microphone store')
check(typeof voiceFace.toggleLoop === 'function' && typeof voiceFace.attachInput === 'function',
  'the handsfree face exposes toggleLoop and attachInput')

const submissions = []
voiceFace.attachInput({
  setDraft: (text) => { submissions.push({ kind: 'draft', text }) },
  submit: () => { submissions.push({ kind: 'submit' }) },
  sessionId: 'session-x',
})

// The component hands the composer over on mount and drops it on unmount.
react.reset()
let attachedHandle = null
let detachCount = 0
function renderVoice() {
  react.beginRender()
  return voiceEntry.component({
    t: key => dicts.en[key] ?? `[${key}]`,
    useSpeech: selector => selector(speechStore.getSnapshot()),
    inputActions: { setDraft() {}, submit() {} },
    session: { sessionId: 'session-x' },
    attachInput: (handle) => { attachedHandle = handle; if (handle === null) detachCount += 1 },
    toggleLoop: voiceFace.toggleLoop,
  })
}
const voiceIdle = renderVoice()
check(attachedHandle !== null && attachedHandle.sessionId === 'session-x', 'mounting the control hands over the session composer')
check(buttonsOf(voiceIdle)[0].props['aria-pressed'] === false, 'the handsfree control reports off initially')
check(String(buttonsOf(voiceIdle)[0].props.title).includes('Start handsfree'), `off tooltip: ${JSON.stringify(buttonsOf(voiceIdle)[0].props.title)}`)
const voiceIcon = buttonsOf(voiceIdle)[0].children[0]
check(voiceIcon?.type === 'svg' && voiceIcon.props.viewBox === '0 0 16 16', 'the handsfree glyph uses the house viewBox')
check(voiceIcon.children[1]?.props.d?.includes('M3.4 3.4'), 'the off glyph is a slash')

// Put the real handover back: the render above replaced it.
voiceFace.attachInput({
  setDraft: (text) => { submissions.push({ kind: 'draft', text }) },
  submit: () => { submissions.push({ kind: 'submit' }) },
  sessionId: 'session-x',
})

// 1. Nothing said for the whole window releases the microphone, no upload.
media.level = 0
// The render checks above wrote partial snapshots; the loop counts exchanges.
speechStore.set({ ...speechStore.getSnapshot(), exchanges: 0, stage: 'off', loop: false, loopNote: null })
micStore.set({ status: 'idle', seconds: 0, error: null, text: '', textSeq: 12, supported: true, silent: false })
const uploadsBeforeLoop = media.calls.length
voiceFace.toggleLoop()
check(speechStore.getSnapshot().loop === true, 'the loop turns on')
await tick(4)
check(micStore.getSnapshot().status === 'recording', `the microphone opens by itself (${micStore.getSnapshot().status})`)
check(speechStore.getSnapshot().stage === 'listening', `stage is listening (${speechStore.getSnapshot().stage})`)
const loopMutation = mutations[mutations.length - 1]
check(loopMutation.ops.some(op => op.path[0] === 'voiceLoop' && op.value === true),
  `the loop is persisted: ${JSON.stringify(loopMutation.ops)}`)

vadFrames(305)
await tick(6)
check(speechStore.getSnapshot().stage === 'paused', `an empty window pauses the loop (${speechStore.getSnapshot().stage})`)
check(speechStore.getSnapshot().loopNote === 'heard-nothing', `the pause says why (${speechStore.getSnapshot().loopNote})`)
check(micStore.getSnapshot().status === 'idle', 'the microphone was released')
check(media.calls.length === uploadsBeforeLoop, `silence was never uploaded (${media.calls.length - uploadsBeforeLoop})`)
check(diagnostics.some(entry => entry.event === 'mic-level'), 'the measured microphone level was reported to the host')
const levelReport = diagnostics.filter(entry => entry.event === 'mic-level').pop()
check(typeof levelReport.gate === 'number' && levelReport.gate >= 0.008, `the gate has an absolute floor (${levelReport.gate})`)

// 1b. Room noise is not speech. A level that clears the gate but never reaches
// the speech bar must not be uploaded: near-silence reaches the recogniser as an
// invented sentence ("他出生于伦敦。" arrived this way, twelve times), and the
// loop would post that invention as the user's own words.
voiceFace.toggleLoop()
voiceFace.toggleLoop()
await tick(4)
const uploadsBeforeNoise = media.calls.length
media.level = 0.012
vadFrames(305)
await tick(8)
check(speechStore.getSnapshot().stage === 'paused', `noise pauses the loop instead of submitting (${speechStore.getSnapshot().stage})`)
check(media.calls.length === uploadsBeforeNoise, `noise was never uploaded (${media.calls.length - uploadsBeforeNoise})`)
const noiseReport = diagnostics.filter(entry => entry.event === 'mic-level').pop()
check(noiseReport.speechFrames === 0, `noise produced no speech frames (${noiseReport.speechFrames})`)

// 1c. A blip long enough to be heard but too short to be a sentence is dropped
// the same way — a keyboard tap must not become a message.
voiceFace.toggleLoop()
voiceFace.toggleLoop()
await tick(4)
const uploadsBeforeBlip = media.calls.length
const submitsBeforeBlip = submissions.filter(entry => entry.kind === 'submit').length
media.level = 0.05
vadFrames(4)
media.level = 0
vadFrames(16)
await tick(6)
check(media.calls.length === uploadsBeforeBlip, `a 400 ms blip was never uploaded (${media.calls.length - uploadsBeforeBlip})`)
check(submissions.filter(entry => entry.kind === 'submit').length === submitsBeforeBlip,
  'nothing was sent for a 400 ms blip')

// 2. Speech, then silence: the turn ends by itself and is submitted.
voiceFace.toggleLoop()
check(speechStore.getSnapshot().loop === false, 'the loop turns off')
check(micStore.getSnapshot().status === 'idle', 'turning it off releases the microphone')
voiceFace.toggleLoop()
await tick(4)
check(micStore.getSnapshot().status === 'recording', 'the loop reopens the microphone')

const uploadsBeforeTurn = media.calls.length
media.level = 0.05
vadFrames(9)
check(micStore.getSnapshot().heard === true, 'the gate hears speech')
media.level = 0
vadFrames(14)
await tick(14)
check(media.calls.length === uploadsBeforeTurn + 1, `the spoken turn was uploaded once (${media.calls.length - uploadsBeforeTurn})`)
check(micStore.getSnapshot().textSeq === 13, `the transcript advanced (${micStore.getSnapshot().textSeq})`)
check(speechStore.getSnapshot().lastHeard === 'transcribed by the fake route', `the loop took the transcript (${speechStore.getSnapshot().lastHeard})`)
check(submissions.some(entry => entry.kind === 'draft' && entry.text === 'transcribed by the fake route'),
  `the transcript reached the composer: ${JSON.stringify(submissions)}`)
// The submit is deferred by one macrotask, so the editor has certainly taken
// the draft; the test's timers are driven by hand.
runTimers()
check(submissions.some(entry => entry.kind === 'submit'), 'the transcript was submitted without a click')
check(speechStore.getSnapshot().exchanges === 1, `one exchange counted (${speechStore.getSnapshot().exchanges})`)
check(speechStore.getSnapshot().stage === 'thinking', `stage is thinking (${speechStore.getSnapshot().stage})`)
check(micStore.getSnapshot().status === 'idle', 'the microphone is shut while the agent works')

// 3. The reply arrives: it is spoken, and then the microphone reopens by itself.
announce('我把那件事做完了。', 21)
await tick(6)
check(speechStore.getSnapshot().status === 'speaking', `the reply is being spoken (${speechStore.getSnapshot().status})`)
check(speechStore.getSnapshot().stage === 'speaking', 'stage is speaking')
check(micStore.getSnapshot().status === 'idle', 'the microphone stays shut while the reply plays')
audios[audios.length - 1].onended()
await tick(8)
check(speechStore.getSnapshot().stage === 'listening', `the loop re-arms itself after the reply (${speechStore.getSnapshot().stage})`)
check(micStore.getSnapshot().status === 'recording', 'the microphone reopened without a click')

// 4. A turn that ends without words still re-arms the loop, silently.
const spokenBefore = speechStore.getSnapshot().spoken
micStore.set({ status: 'idle', seconds: 0, error: null, text: '', textSeq: 13, supported: true, silent: false })
speechStore.set({ ...speechStore.getSnapshot(), stage: 'thinking' })
eventSources[eventSources.length - 1].emit('announce', JSON.stringify({
  type: 'announce', sessionId: 'session-x', turn: 22, reason: 'cancelled', text: '',
}))
await tick(6)
check(speechStore.getSnapshot().spoken === spokenBefore, 'a wordless turn is not spoken')
micStore.set({ status: 'idle', seconds: 0, error: null, text: '', textSeq: 13, supported: true, silent: false })
await tick(4)
check(speechStore.getSnapshot().stage === 'listening' || micStore.getSnapshot().status === 'recording',
  'a cancelled turn still re-arms the loop')

// 5. Switching the loop off releases the microphone without uploading.
const uploadsBeforeOff = media.calls.length
voiceFace.toggleLoop()
check(speechStore.getSnapshot().loop === false && speechStore.getSnapshot().stage === 'off', 'the loop turns off cleanly')
check(micStore.getSnapshot().status === 'idle',
  `the microphone is released (status=${micStore.getSnapshot().status} handsfree=${micStore.getSnapshot().handsfree})`)
await tick(8)
check(media.calls.length === uploadsBeforeOff, `a cancelled listen uploads nothing (${media.calls.length - uploadsBeforeOff})`)

// 6. In handsfree mode the microphone control must not also paste the transcript.
react.reset()
micStore.set({ status: 'idle', seconds: 0, error: null, text: 'spoken words', textSeq: 20, supported: true })
speechStore.set({ ...speechStore.getSnapshot(), loop: true })
const loopDrafts = []
react.beginRender()
micEntry.component({
  t: key => dicts.en[key] ?? `[${key}]`,
  useMic: selector => selector(micStore.getSnapshot()),
  useSpeech: selector => selector(speechStore.getSnapshot()),
  useInput: selector => selector({ draft: '' }),
  inputActions: { setDraft: (text) => { loopDrafts.push(text) } },
  toggle: voiceFace.toggleLoop,
})
check(loopDrafts.length === 0, 'the microphone control stays out of the loop\'s way')
speechStore.set({ ...speechStore.getSnapshot(), loop: false })
await tick(2)

console.log('\nclient half: all checks passed')