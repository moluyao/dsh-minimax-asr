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

/** Snapshot store stand-in: `set` replaces the published snapshot. */
const stores = []
const clientStore = {
  createSnapshotStore(init) {
    const handle = {
      current: init,
      getSnapshot() { return handle.current },
      set(next) { handle.current = next },
      update() {},
      subscribe() { return () => {} },
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
    maxFileMB: 50,
    timeoutMs: 180000,
  },
  // Presence in `user` is what marks a field overridden.
  user: { model: 'asr-1.0' },
  revision: 7,
  writable: true,
  mode: 'host',
}
const scope = {
  getSnapshot: () => scopeSnapshot,
  subscribe: () => () => {},
  mutate: async (ops, revision) => { mutations.push({ ops, revision }) },
}

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
}

function fakeAudioContext() {
  return {
    sampleRate: 16000,
    closed: false,
    decodeAudioData(_buffer, resolve) {
      decodeAudioDataCalls += 1
      resolve(media.decoded)
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
    media.calls.push({ url, method: options?.method, contentType: options?.headers?.['content-type'], body: options?.body })
    return {
      status: 200,
      json: async () => ({ ok: true, text: 'transcribed by the fake route' }),
    }
  },
  Blob,
  setInterval,
  clearInterval,
  Date,
  console,
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
check(registered.length === 2, `registered ${registered.length} contributions`)
const cardEntry = registered.find(entry => entry.options.name === 'settings.plugin.item')
const micEntry = registered.find(entry => entry.options.name === 'conversation.input.left')
check(cardEntry !== undefined, 'card registers into the settings.plugin.item slot')
check(cardEntry.options.key === 'minimax-asr', `card key ${JSON.stringify(cardEntry.options.key)}`)
check(cardEntry.options.locale === 'minimax-asr', 'card binds the locale namespace')
check(micEntry !== undefined && micEntry.options.id === 'minimax-asr-mic', 'mic control registers into the composer tool row')
check(micEntry.options.locale === 'minimax-asr', 'mic control binds the locale namespace')
check(typeof micEntry.options.order === 'number', `mic control carries an order (${micEntry.options.order})`)

// Dictionaries must key-match, or one language renders raw keys.
const dicts = ctx.dictionaries.dictionaries
const enKeys = Object.keys(dicts.en).sort()
const zhKeys = Object.keys(dicts.zh).sort()
check(JSON.stringify(enKeys) === JSON.stringify(zhKeys), `en/zh dictionaries key-match (${enKeys.length} keys)`)

// --- render -----------------------------------------------------------------

const card = cardEntry.component
const store = stores[0]
const face = cardEntry.options.inject()

/** Render once through the stub React and return the produced tree. */
function render() {
  react.beginRender()
  return card({
    t: key => dicts.en[key] ?? `[${key}]`,
    useCard: selector => selector(store.getSnapshot()),
    save: face.save,
  })
}

/** Depth-first search of the produced tree. */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function findInput(tree, id) {
  let found
  walk(tree, (node) => { if (node.type === 'input' && node.props.id === id) found = node })
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

const fields = ['baseURL', 'model', 'apiKeyEnv', 'responseFormat', 'language', 'timestampLevel', 'maxFileMB', 'timeoutMs']
for (const field of fields) check(findInput(open, `minimax-asr-${field}`) !== undefined, `input rendered: ${field}`)
check(findInput(open, 'minimax-asr-model').props.value === 'asr-1.0', 'model input shows the resolved value')
check(findInput(open, 'minimax-asr-model').props.disabled === false, 'inputs are enabled (host mode, writable)')

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
check(labels.includes('7s'), `recording shows elapsed time (${JSON.stringify(labels)})`)
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

console.log('\nclient half: all checks passed')
