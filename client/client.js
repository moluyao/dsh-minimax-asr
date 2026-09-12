/**
 * dsh-minimax-asr - browser half.
 *
 * A hand-authored classic-script bundle: the host serves these exact bytes into
 * a <script src>, so this file is NOT a module (no import/export/import.meta).
 * The loader provides `require` from its flat module table; `module`/`exports`
 * come from the wrapper below.
 *
 * It renders the `minimax-asr` card in Settings -> Plugins -> Plugin
 * configuration. The card is dispatched by namespace key, so it appears only
 * while the host half registers the same namespace.
 */
window.__ModuleLoader__.load({ id: "dsh-minimax-asr", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

var React = require('react')
var store = require('@deepseek-ai/dsh-client-store')

/** Settings namespace, matching the host half. */
var NS = 'minimax-asr'

/** Credential reference whose configured state the card reports. */
var DEFAULT_CREDENTIAL_REF = 'MINIMAX_API_KEY'

/** Host route the voice input posts one recording to. */
var TRANSCRIBE_ROUTE = '/minimax-asr/transcribe'

/** Host route this half reports its own wiring to (best effort, no secrets). */
var DIAGNOSTICS_ROUTE = '/minimax-asr/diagnostics'

/**
 * Report one wiring fact to the host. A deployment that composes no web server
 * simply never sees these; a failure here must never affect the feature.
 * @param event - plain JSON facts, e.g. `{ event: 'mic-rendered' }`.
 */
function reportEvent(event) {
  try {
    if (typeof fetch !== 'function') return
    fetch(DIAGNOSTICS_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    }).catch(function () {})
  } catch (error) {
    // Diagnostics are never load-bearing.
  }
}

/**
 * Hard ceiling for a browser recording: MiniMax rejects any file longer than
 * 500 s, so no configured value may exceed it.
 */
var MAX_RECORD_SECONDS = 500

/** Auto-stop length used when the settings section names none. */
var DEFAULT_RECORD_SECONDS = 300

/** Smallest cap the settings section accepts. */
var MIN_RECORD_SECONDS = 10

/** Field descriptors: `numeric` fields are written as numbers. */
var FIELDS = [
  { key: 'baseURL', label: 'baseURL', numeric: false },
  { key: 'model', label: 'model', numeric: false },
  { key: 'apiKeyEnv', label: 'apiKeyEnv', numeric: false },
  { key: 'responseFormat', label: 'responseFormat', numeric: false },
  { key: 'language', label: 'language', numeric: false },
  { key: 'timestampLevel', label: 'timestampLevel', numeric: false },
  { key: 'maxRecordSeconds', label: 'maxRecordSeconds', numeric: true },
  { key: 'maxFileMB', label: 'maxFileMB', numeric: true },
  { key: 'timeoutMs', label: 'timeoutMs', numeric: true },
]

var NUMERIC_FIELDS = { maxRecordSeconds: true, maxFileMB: true, timeoutMs: true }

/** Render seconds as `m:ss`, the shape the recording pill shows. */
function formatClock(seconds) {
  var total = Math.max(0, Math.floor(Number(seconds) || 0))
  var minutes = Math.floor(total / 60)
  var rest = total % 60
  return minutes + ':' + (rest < 10 ? '0' : '') + rest
}

var DICTIONARIES = {
  en: {
    title: 'MiniMax ASR',
    description: 'Endpoint, model and transcription defaults for the MiniMax speech-to-text tool.',
    baseURL: 'Endpoint URL',
    model: 'Model',
    apiKeyEnv: 'API-key reference',
    responseFormat: 'Response format',
    language: 'Language hint',
    timestampLevel: 'Timestamp level',
    maxRecordSeconds: 'Max recording (seconds)',
    maxFileMB: 'Max file size (MB)',
    timeoutMs: 'Request timeout (ms)',
    credential: 'Credential',
    credentialConfigured: 'configured',
    credentialMissing: 'not configured',
    credentialUnknown: 'unknown',
    overridden: 'overridden',
    reset: 'reset',
    unsaved: 'unsaved',
    save: 'Save',
    saving: 'Saving...',
    discard: 'Discard',
    failed: 'The host refused the save; the values are unchanged.',
    readOnly: 'This deployment stores preferences for this browser only; writes are disabled.',
    unavailable: 'The host does not serve the "minimax-asr" settings namespace yet.',
    micStart: 'Dictate with MiniMax speech recognition',
    micStop: 'Stop and transcribe',
    micRecording: 'Recording',
    micTranscribing: 'Transcribing...',
    micFailed: 'Transcription failed',
    micUnsupported: 'This browser cannot record audio here (a microphone and a secure context are required).',
    micSecond: 's',
  },
  zh: {
    title: 'MiniMax 语音识别',
    description: 'MiniMax 语音转文字工具的接口地址、模型与转写默认值。',
    baseURL: '接口地址',
    model: '模型',
    apiKeyEnv: '密钥引用名',
    responseFormat: '返回格式',
    language: '语言提示',
    timestampLevel: '时间戳粒度',
    maxRecordSeconds: '录音时长上限（秒）',
    maxFileMB: '文件大小上限（MB）',
    timeoutMs: '请求超时（毫秒）',
    credential: '凭据',
    credentialConfigured: '已配置',
    credentialMissing: '未配置',
    credentialUnknown: '未知',
    overridden: '已覆盖',
    reset: '重置',
    unsaved: '未保存',
    save: '保存',
    saving: '保存中…',
    discard: '放弃',
    failed: '宿主拒绝了这次保存，配置未改变。',
    readOnly: '当前部署只把偏好存在本浏览器中，无法写回宿主。',
    unavailable: '宿主尚未提供 "minimax-asr" 设置命名空间。',
    micStart: '用 MiniMax 语音识别听写',
    micStop: '停止并转写',
    micRecording: '录音中',
    micTranscribing: '转写中…',
    micFailed: '转写失败',
    micUnsupported: '当前浏览器无法录音（需要麦克风与安全上下文）。',
    micSecond: '秒',
  },
}

/** The credential reference a snapshot currently names. */
function refOf(snapshot) {
  var declared = snapshot !== undefined && snapshot.value !== null && typeof snapshot.value === 'object'
    ? snapshot.value.apiKeyEnv
    : undefined
  return typeof declared === 'string' && declared.length > 0 ? declared : DEFAULT_CREDENTIAL_REF
}

/**
 * Read the credentials remote namespace without touching `ctx.remote`.
 *
 * `remote.credentials` is the injected service key; the `remote` parent is a
 * DIFFERENT service this plugin does not inject, and reading a service the
 * declaration omits throws ("cannot get property \"remote\" without inject").
 * `ctx.get` is the optional-service read and does not go through the inject
 * proxy, so a deployment without a credential provider degrades to "unknown"
 * instead of failing the whole plugin.
 * @param ctx - the browser plugin context.
 * @returns the credentials facet, or undefined while unavailable.
 */
function credentialsOf(ctx) {
  if (typeof ctx.get === 'function') {
    var viaGet = ctx.get('remote.credentials')
    if (viaGet !== undefined) return viaGet
  }
  try {
    return ctx['remote.credentials']
  } catch (error) {
    return undefined
  }
}

/** Whether an object owns a key. */
function owns(object, key) {
  return object !== null && typeof object === 'object'
    && Object.prototype.hasOwnProperty.call(object, key)
}

/**
 * Bridges the `minimax-asr` settings scope and the credentials domain onto the
 * card, publishing one plain snapshot the renderer binds as `useCard`.
 * @param ctx - the browser plugin context.
 */
function CardController(ctx) {
  this.ctx = ctx
  this.scope = ctx.settingsScope.bind({ namespace: NS })
  this.credential = { ref: DEFAULT_CREDENTIAL_REF, configured: false, known: false }
  this.saving = false
  this.failed = false
  var self = this
  this.store = store.createSnapshotStore(this.build())
  this.off = this.scope.subscribe(function () {
    self.syncCredential()
    self.publish()
  })
  this.readCredential()
}

/** The card's whole published state. */
CardController.prototype.build = function () {
  var snapshot = this.scope.getSnapshot()
  return {
    status: snapshot.status,
    value: snapshot.value,
    user: snapshot.user,
    revision: snapshot.revision,
    writable: snapshot.writable,
    mode: snapshot.mode,
    credentialRef: this.credential.ref,
    credentialConfigured: this.credential.configured,
    credentialKnown: this.credential.known,
    saving: this.saving,
    failed: this.failed,
  }
}

CardController.prototype.publish = function () {
  this.store.set(this.build())
}

/**
 * Re-address the credential when the section renames its reference. A stale
 * answer must never be reported for a name nobody has checked.
 */
CardController.prototype.syncCredential = function () {
  var ref = refOf(this.scope.getSnapshot())
  if (ref === this.credential.ref) return
  this.credential = { ref: ref, configured: false, known: false }
  this.readCredential()
}

/** Ask the credentials domain whether the reference has a value anywhere. */
CardController.prototype.readCredential = function () {
  var self = this
  var ref = refOf(this.scope.getSnapshot())
  var credentials = credentialsOf(this.ctx)
  if (credentials === undefined) {
    this.credential = { ref: ref, configured: false, known: false }
    this.publish()
    return
  }
  Promise.resolve(credentials.describe([ref])).then(function (response) {
    if (response === null || typeof response !== 'object' || response.ok !== true) return
    var view = response.value === undefined ? undefined : response.value[ref]
    self.credential = {
      ref: ref,
      configured: view !== undefined && view !== null && view.configured === true,
      known: true,
    }
    self.publish()
  }).catch(function () { /* a failed read is not a failed save; the badge stays unknown */ })
}

/**
 * Write the staged operations through the namespace scope, fenced by the
 * revision the draft was read at.
 * @param ops - ordered path edits; an empty list writes nothing.
 * @returns a promise settling after the write attempt.
 */
CardController.prototype.save = function (ops) {
  var self = this
  if (ops.length === 0) return Promise.resolve()
  this.saving = true
  this.failed = false
  this.publish()
  return this.scope.mutate(ops, this.scope.getSnapshot().revision).then(function () {
    self.saving = false
    self.publish()
  }, function () {
    self.saving = false
    self.failed = true
    self.publish()
  })
}

CardController.prototype.inject = function () {
  var self = this
  return {
    hooks: { card: this.store },
    save: function (ops) { return self.save(ops) },
  }
}

CardController.prototype.dispose = function () {
  this.off()
}

var cardStyle = {
  listStyle: 'none',
  border: '1px solid var(--dsw-color-border, #d0d5dd)',
  borderRadius: '8px',
  margin: '8px 0',
}
var headerStyle = {
  display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
  background: 'none', border: 0, padding: '12px', textAlign: 'left', cursor: 'pointer',
  color: 'inherit', fontSize: 'inherit',
}
var titleStyle = { display: 'block', fontWeight: 600 }
var descStyle = { display: 'block', opacity: 0.7, fontSize: '12px' }
var bodyStyle = { padding: '0 12px 12px' }
var rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '6px 0' }
var labelStyle = { display: 'flex', alignItems: 'center', gap: '6px' }
var inputStyle = { minWidth: '16rem', padding: '4px 6px' }
var badgeStyle = { fontSize: '11px', border: '1px solid currentColor', borderRadius: '999px', padding: '0 6px' }
var hintStyle = { opacity: 0.6, fontSize: '11px' }
var footerStyle = { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', paddingTop: '8px' }

/**
 * The card. Receives the composed props only: `t` from the locale namespace,
 * `useCard` from the inject face's `hooks` compartment, and `save` from the
 * same face's actions.
 * @param props - the card props.
 * @returns the card element.
 */
function MinimaxAsrCard(props) {
  var t = props.t
  var state = props.useCard(function (value) { return value })
  var draftPair = React.useState(null)
  var draft = draftPair[0]
  var setDraft = draftPair[1]
  var openPair = React.useState(false)
  var open = openPair[0]
  var setOpen = openPair[1]

  // A new host view invalidates a stale draft: its revision is the fence the
  // next write would use.
  var revision = state.revision
  React.useEffect(function () { setDraft(null) }, [revision])

  if (state.status === 'unavailable') return null

  var value = state.value !== null && typeof state.value === 'object' ? state.value : {}
  var user = state.user !== null && typeof state.user === 'object' ? state.user : {}
  var writable = state.writable === true && state.mode === 'host'

  var shown = function (field) {
    if (draft !== null && owns(draft, field)) return draft[field]
    var committed = value[field]
    return committed === undefined || committed === null ? '' : String(committed)
  }
  var edit = function (field, text) {
    var next = {}
    if (draft !== null) for (var key in draft) if (owns(draft, key)) next[key] = draft[key]
    next[field] = text
    setDraft(next)
  }

  /** The ordered edits a save would send; empty when nothing is staged. */
  var buildOps = function () {
    var ops = []
    if (draft === null) return ops
    for (var i = 0; i < FIELDS.length; i += 1) {
      var field = FIELDS[i].key
      if (!owns(draft, field)) continue
      var text = draft[field]
      var committed = value[field]
      var committedText = committed === undefined || committed === null ? '' : String(committed)
      if (text === committedText) continue
      if (String(text).trim() === '') {
        // Blank clears an override; without one there is nothing to write.
        if (owns(user, field)) ops.push({ op: 'unset', path: [field] })
        continue
      }
      if (NUMERIC_FIELDS[field] === true) {
        var numeric = Number(text)
        if (!isFinite(numeric)) continue
        ops.push({ op: 'set', path: [field], value: numeric })
        continue
      }
      ops.push({ op: 'set', path: [field], value: String(text) })
    }
    return ops
  }

  var pending = buildOps()
  var busy = state.saving === true
  var dirty = pending.length > 0

  var credentialLabel = state.credentialKnown !== true
    ? t('credentialUnknown')
    : state.credentialConfigured === true ? t('credentialConfigured') : t('credentialMissing')

  var fieldRow = function (field) {
    var overridden = owns(user, field.key)
    return React.createElement('div', { key: field.key, style: rowStyle },
      React.createElement('div', { style: labelStyle },
        React.createElement('label', { htmlFor: 'minimax-asr-' + field.key }, t(field.key)),
        overridden ? React.createElement('span', { style: badgeStyle }, t('overridden')) : null,
        overridden
          ? React.createElement('button', {
            type: 'button',
            disabled: busy || !writable,
            onClick: function () { edit(field.key, '') },
          }, t('reset'))
          : null,
      ),
      React.createElement('input', {
        id: 'minimax-asr-' + field.key,
        type: field.numeric ? 'number' : 'text',
        style: inputStyle,
        value: shown(field.key),
        disabled: busy || !writable,
        onChange: function (event) { edit(field.key, event.currentTarget.value) },
      }),
    )
  }

  var rows = []
  for (var i = 0; i < FIELDS.length; i += 1) rows.push(fieldRow(FIELDS[i]))

  rows.push(React.createElement('div', { key: 'credential', style: rowStyle },
    React.createElement('div', { style: labelStyle },
      React.createElement('span', null, t('credential')),
      React.createElement('span', { style: hintStyle }, state.credentialRef),
    ),
    React.createElement('span', { style: badgeStyle }, credentialLabel),
  ))

  rows.push(React.createElement('div', { key: 'actions', style: footerStyle },
    state.failed === true ? React.createElement('span', { role: 'status' }, t('failed')) : null,
    React.createElement('button', {
      type: 'button',
      disabled: !dirty || busy,
      onClick: function () { setDraft(null) },
    }, t('discard')),
    React.createElement('button', {
      type: 'button',
      disabled: !dirty || busy || !writable,
      onClick: function () {
        var ops = buildOps()
        if (ops.length === 0) { setDraft(null); return }
        Promise.resolve(props.save(ops)).then(function () { setDraft(null) })
      },
    }, t(busy ? 'saving' : 'save')),
  ))

  return React.createElement('li', { style: cardStyle },
    React.createElement('button', {
      type: 'button',
      'aria-expanded': open,
      style: headerStyle,
      onClick: function () { setOpen(!open) },
    },
      React.createElement('span', { style: { flex: 1 } },
        React.createElement('span', { style: titleStyle }, t('title')),
        React.createElement('span', { style: descStyle }, t('description')),
      ),
      dirty ? React.createElement('span', { style: badgeStyle }, t('unsaved')) : null,
      React.createElement('span', null, open ? '\u25be' : '\u25b8'),
    ),
    open
      ? React.createElement('div', { style: bodyStyle },
        writable ? null : React.createElement('p', { role: 'status' }, t('readOnly')),
        rows,
      )
      : null,
  )
}

// --- voice input -----------------------------------------------------------

/** Whether this browser can record at all (microphone + secure context). */
function recordingSupported() {
  return typeof navigator !== 'undefined'
    && navigator.mediaDevices !== undefined
    && typeof navigator.mediaDevices.getUserMedia === 'function'
    && typeof window !== 'undefined'
    && typeof window.MediaRecorder === 'function'
}

/**
 * Linear resample of mono float samples. `decodeAudioData` already resamples to
 * the context's rate in current Chromium, so this is a guard, not the norm.
 * @param samples - mono samples at `fromRate`.
 * @param fromRate - the samples' rate.
 * @param toRate - the target rate.
 * @returns mono samples at `toRate`.
 */
function resampleMono(samples, fromRate, toRate) {
  if (fromRate === toRate || samples.length === 0) return samples
  var ratio = fromRate / toRate
  var length = Math.max(1, Math.round(samples.length / ratio))
  var out = new Float32Array(length)
  for (var i = 0; i < length; i += 1) {
    var position = i * ratio
    var index = Math.floor(position)
    var next = Math.min(samples.length - 1, index + 1)
    var fraction = position - index
    out[i] = samples[index] * (1 - fraction) + samples[next] * fraction
  }
  return out
}

/**
 * Decode one recording into 16 kHz mono float samples — the shape MiniMax
 * accepts as a WAV, and the reason this never uploads the recorder's own
 * container (Chrome records webm/opus, which the endpoint does not accept).
 * @param arrayBuffer - the recorded blob's bytes.
 * @returns a promise for `{ samples, sampleRate }`.
 */
function decodeToMono16k(arrayBuffer) {
  var Ctor = typeof window === 'undefined' ? undefined : window.AudioContext || window.webkitAudioContext
  if (typeof Ctor !== 'function') return Promise.reject(new Error('AudioContext is unavailable'))
  var context = new Ctor({ sampleRate: 16000 })
  var decoded = new Promise(function (resolve, reject) {
    context.decodeAudioData(arrayBuffer, resolve, function () {
      reject(new Error('the recording could not be decoded'))
    })
  })
  return decoded.then(function (audioBuffer) {
    var channels = audioBuffer.numberOfChannels
    var length = audioBuffer.length
    var mono = new Float32Array(length)
    for (var channel = 0; channel < channels; channel += 1) {
      var data = audioBuffer.getChannelData(channel)
      for (var i = 0; i < length; i += 1) mono[i] += data[i] / channels
    }
    var rate = audioBuffer.sampleRate
    if (typeof context.close === 'function') context.close()
    return { samples: resampleMono(mono, rate, 16000), sampleRate: 16000 }
  })
}

/**
 * Encode mono float samples as a 16-bit PCM WAV.
 * @param samples - mono samples in [-1, 1].
 * @param sampleRate - the samples' rate.
 * @returns the WAV bytes.
 */
function encodeWav(samples, sampleRate) {
  var buffer = new ArrayBuffer(44 + samples.length * 2)
  var view = new DataView(buffer)
  var writeString = function (offset, text) {
    for (var i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  var offset = 44
  for (var i = 0; i < samples.length; i += 1, offset += 2) {
    var sample = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true)
  }
  return buffer
}

/** Append a transcript to the draft the user already typed. */
function mergeDraft(draft, addition) {
  var current = typeof draft === 'string' ? draft : ''
  var text = typeof addition === 'string' ? addition.trim() : ''
  if (text.length === 0) return current
  if (current.trim().length === 0) return text
  return /[\s\n]$/u.test(current) ? current + text : `${current} ${text}`
}

/**
 * Records through the microphone and transcribes through the host route.
 * The auto-stop length is read from the same settings namespace the card edits,
 * so raising "Max recording" in Settings reaches the very next recording.
 * @param ctx - the browser plugin context, for the settings scope.
 */
function MicController(ctx) {
  this.scope = ctx === undefined || ctx.settingsScope === undefined
    ? undefined
    : ctx.settingsScope.bind({ namespace: NS })
  this.store = store.createSnapshotStore({
    status: 'idle',
    seconds: 0,
    error: null,
    text: '',
    textSeq: 0,
    supported: recordingSupported(),
    limitSeconds: this.limitSeconds(),
  })
  this.recorder = null
  this.stream = null
  this.chunks = []
  this.timer = null
  this.startedAt = 0
  var self = this
  // A committed settings change re-publishes the cap; a recording already
  // running keeps the length it started with, which is the least surprising.
  this.offScope = this.scope === undefined
    ? undefined
    : this.scope.subscribe(function () { self.publish({ limitSeconds: self.limitSeconds() }) })
}

/**
 * The configured auto-stop length, clamped to what MiniMax accepts.
 * @returns seconds in `[MIN_RECORD_SECONDS, MAX_RECORD_SECONDS]`.
 */
MicController.prototype.limitSeconds = function () {
  var value = this.scope === undefined ? undefined : this.scope.getSnapshot().value
  var declared = value !== null && typeof value === 'object' ? Number(value.maxRecordSeconds) : Number.NaN
  if (!isFinite(declared)) return DEFAULT_RECORD_SECONDS
  return Math.min(MAX_RECORD_SECONDS, Math.max(MIN_RECORD_SECONDS, Math.round(declared)))
}

/** Publish a patch over the current snapshot. */
MicController.prototype.publish = function (patch) {
  var current = this.store.getSnapshot()
  var next = {}
  for (var key in current) if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key]
  for (var patchKey in patch) if (Object.prototype.hasOwnProperty.call(patch, patchKey)) next[patchKey] = patch[patchKey]
  this.store.set(next)
}

/** Idle or failed starts recording; recording stops and transcribes. */
MicController.prototype.toggle = function () {
  var status = this.store.getSnapshot().status
  if (status === 'recording') {
    this.stop()
    return
  }
  if (status === 'transcribing' || status === 'starting') return
  this.start()
}

/** Open the microphone and begin recording. */
MicController.prototype.start = function () {
  var self = this
  if (this.store.getSnapshot().supported !== true) return
  this.publish({ status: 'starting', error: null, seconds: 0 })
  navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  }).then(function (stream) {
    self.stream = stream
    self.chunks = []
    var options = {}
    if (typeof window.MediaRecorder.isTypeSupported === 'function'
      && window.MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      options.mimeType = 'audio/webm;codecs=opus'
    }
    var recorder = new window.MediaRecorder(stream, options)
    self.recorder = recorder
    recorder.ondataavailable = function (event) {
      if (event.data !== null && event.data !== undefined && event.data.size > 0) self.chunks.push(event.data)
    }
    recorder.onstop = function () { self.finish() }
    recorder.onerror = function () { self.fail(new Error('recording failed')) }
    recorder.start()
    self.startedAt = Date.now()
    // Read the cap once, at start: a settings change mid-recording must not
    // silently cut a recording the user is still speaking into.
    var limit = self.limitSeconds()
    self.publish({ status: 'recording', seconds: 0, error: null, limitSeconds: limit })
    self.timer = setInterval(function () {
      var seconds = Math.floor((Date.now() - self.startedAt) / 1000)
      self.publish({ seconds: seconds })
      if (seconds >= limit) self.stop()
    }, 500)
  }, function (error) {
    self.fail(error !== null && typeof error === 'object' && typeof error.message === 'string'
      ? error
      : new Error('microphone permission was refused'))
  })
}

/** Stop recording; the recorder's own `onstop` continues into transcription. */
MicController.prototype.stop = function () {
  if (this.timer !== null) {
    clearInterval(this.timer)
    this.timer = null
  }
  var recorder = this.recorder
  if (recorder !== null && recorder.state !== 'inactive') {
    this.publish({ status: 'transcribing', error: null })
    try {
      recorder.stop()
    } catch (error) {
      this.fail(error)
    }
    return
  }
  this.releaseStream()
}

/** Upload the finished recording and publish the transcript. */
MicController.prototype.finish = function () {
  var self = this
  var recorder = this.recorder
  var type = recorder !== null && recorder.mimeType ? recorder.mimeType : 'audio/webm'
  var blob = new Blob(this.chunks, { type: type })
  this.recorder = null
  this.chunks = []
  this.releaseStream()
  if (blob.size === 0) {
    this.fail(new Error('nothing was recorded'))
    return
  }
  this.publish({ status: 'transcribing', error: null })
  blob.arrayBuffer()
    .then(decodeToMono16k)
    .then(function (decoded) {
      return fetch(`${TRANSCRIBE_ROUTE}?name=voice-input.wav`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: encodeWav(decoded.samples, decoded.sampleRate),
      })
    })
    .then(function (response) {
      return response.json().then(function (body) { return { status: response.status, body: body } })
    })
    .then(function (result) {
      var body = result.body
      if (body === null || typeof body !== 'object' || body.ok !== true) {
        throw new Error(body !== null && typeof body === 'object' && typeof body.error === 'string'
          ? body.error
          : `HTTP ${result.status}`)
      }
      self.publish({
        status: 'idle',
        seconds: 0,
        error: null,
        text: typeof body.text === 'string' ? body.text : '',
        textSeq: self.store.getSnapshot().textSeq + 1,
      })
    })
    .catch(function (error) { self.fail(error) })
}

/** Release the microphone tracks; the recording indicator must never outlive them. */
MicController.prototype.releaseStream = function () {
  var stream = this.stream
  this.stream = null
  if (stream === null || typeof stream.getTracks !== 'function') return
  var tracks = stream.getTracks()
  for (var i = 0; i < tracks.length; i += 1) {
    try {
      tracks[i].stop()
    } catch (error) {
      // A track that refuses to stop is already unusable.
    }
  }
}

/** Publish a failure and drop every recording resource. */
MicController.prototype.fail = function (error) {
  if (this.timer !== null) {
    clearInterval(this.timer)
    this.timer = null
  }
  this.recorder = null
  this.chunks = []
  this.releaseStream()
  this.publish({
    status: 'error',
    seconds: 0,
    error: error !== null && typeof error === 'object' && typeof error.message === 'string'
      ? error.message
      : String(error),
  })
}

/** Stop everything; called when the plugin unloads. */
MicController.prototype.dispose = function () {
  if (this.offScope !== undefined) {
    this.offScope()
    this.offScope = undefined
  }
  if (this.timer !== null) {
    clearInterval(this.timer)
    this.timer = null
  }
  var recorder = this.recorder
  this.recorder = null
  this.chunks = []
  if (recorder !== null && recorder.state !== 'inactive') {
    try {
      recorder.stop()
    } catch (error) {
      // Already stopped.
    }
  }
  this.releaseStream()
}

MicController.prototype.inject = function () {
  var self = this
  return {
    hooks: { mic: this.store },
    toggle: function () { self.toggle() },
  }
}

/** Composer tool-row control: click to record, click again to transcribe. */
/**
 * Microphone glyph, drawn in the ic_ds_* house style: a 16x16 viewBox with
 * `currentColor`, so it inherits the control's colour and hover state.
 * @param size - square edge in px.
 * @returns the icon element.
 */
function MicGlyph(size) {
  return React.createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    'aria-hidden': 'true',
    focusable: 'false',
  },
    // Capsule.
    React.createElement('path', {
      fill: 'currentColor',
      d: 'M8 1.4c-1.2 0-2.1 1-2.1 2.1v4c0 1.2.9 2.1 2.1 2.1s2.1-.9 2.1-2.1v-4c0-1.1-.9-2.1-2.1-2.1z',
    }),
    // Cradle around the capsule.
    React.createElement('path', {
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      fill: 'none',
      d: 'M4.3 7.3v1.4c0 2 1.7 3.7 3.7 3.7s3.7-1.7 3.7-3.7V7.3',
    }),
    // Stem and base.
    React.createElement('path', {
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      fill: 'none',
      d: 'M8 12.5v1.2M5.6 13.8h4.8',
    }),
  )
}

/** Stop glyph for the recording state. */
function StopGlyph(size) {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false',
  }, React.createElement('rect', { x: 4.2, y: 4.2, width: 7.6, height: 7.6, rx: 1.8, fill: 'currentColor' }))
}

/** Waveform glyph for the in-flight transcription state. */
function WavesGlyph(size) {
  const bar = (key, x, y, height) => React.createElement('rect', {
    key, x, y, width: 1.6, height, rx: 0.8, fill: 'currentColor',
  })
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false',
  },
    bar('a', 3.4, 6.6, 2.8),
    bar('b', 7.2, 4.6, 6.8),
    bar('c', 11, 6, 4),
  )
}

/**
 * The control's box: an icon-only square when idle, a labelled pill while
 * recording so the elapsed time stays legible, with pointer feedback.
 * @param state - recording / busy / failed / hovered / disabled.
 * @returns the button style.
 */
function micStyle(state) {
  const accent = state.recording === true || state.failed === true
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '5px',
    minWidth: '32px',
    minHeight: '32px',
    padding: state.recording === true ? '0 10px' : '0 6px',
    border: `1px solid ${accent ? '#e5484d' : 'var(--dsw-color-border, #d0d5dd)'}`,
    background: accent
      ? 'rgba(229, 72, 77, 0.10)'
      : state.hovered === true ? 'var(--dsw-color-surface-hover, rgba(127, 127, 127, 0.12))' : 'transparent',
    color: accent ? '#e5484d' : 'inherit',
    borderRadius: '8px',
    fontSize: '12px',
    lineHeight: 1,
    cursor: state.disabled === true ? 'default' : 'pointer',
    opacity: state.disabled === true && state.busy !== true ? 0.5 : 1,
  }
}

/**
 * The composer control. It receives the session standard props (`useInput`,
 * `inputActions`) plus this registration's inject face, and inserts each new
 * transcript into the draft exactly once.
 * @param props - composed slot props.
 * @returns the control element.
 */
function MicButton(props) {
  var t = props.t
  var state = props.useMic(function (value) { return value })
  var draft = props.useInput === undefined
    ? ''
    : props.useInput(function (input) { return input === undefined || input === null ? '' : input.draft })
  var actions = props.inputActions
  var lastSeq = React.useRef(0)
  var reported = React.useRef(false)

  React.useEffect(function () {
    if (reported.current) return
    reported.current = true
    reportEvent({ event: 'mic-rendered', slot: 'conversation.input.left', supported: state.supported === true })
  }, [])

  React.useEffect(function () {
    if (state.textSeq === 0 || state.textSeq === lastSeq.current) return
    lastSeq.current = state.textSeq
    if (actions === undefined || typeof actions.setDraft !== 'function') return
    var merged = mergeDraft(draft, state.text)
    if (merged !== draft) actions.setDraft(merged)
  }, [state.textSeq, state.text, draft, actions])

  var supported = state.supported === true
  var recording = state.status === 'recording'
  var busy = state.status === 'transcribing' || state.status === 'starting'
  var failed = state.status === 'error'
  var limit = state.limitSeconds === undefined ? DEFAULT_RECORD_SECONDS : state.limitSeconds
  var label = !supported
    ? t('micUnsupported')
    : recording
      // The cap belongs in the tooltip: the pill itself stays narrow.
      ? `${t('micStop')} · ${formatClock(limit)}`
      : busy
        ? t('micTranscribing')
        : failed
          ? `${t('micFailed')}: ${state.error}`
          : `${t('micStart')} · ${formatClock(limit)}`

  var hoverPair = React.useState(false)
  var hovered = hoverPair[0]
  var setHovered = hoverPair[1]
  var disabled = !supported || busy
  // 18px rather than the siblings' 16: this control has no text label, and the
  // glyph has to read at a glance.
  var icon = recording ? StopGlyph(18) : busy ? WavesGlyph(18) : MicGlyph(18)

  return React.createElement('button', {
    type: 'button',
    title: label,
    'aria-label': supported ? (recording ? t('micStop') : t('micStart')) : t('micUnsupported'),
    disabled: disabled,
    style: micStyle({ recording: recording, failed: failed, hovered: hovered, disabled: disabled, busy: busy }),
    onMouseEnter: function () { setHovered(true) },
    onMouseLeave: function () { setHovered(false) },
    onFocus: function () { setHovered(true) },
    onBlur: function () { setHovered(false) },
    onClick: function () { props.toggle() },
  },
    icon,
    recording
      ? React.createElement('span',
        { style: { fontVariantNumeric: 'tabular-nums' } },
        `${formatClock(state.seconds)} / ${formatClock(limit)}`)
      : null,
  )
}

/** Required services (cordis fiber inject). */
var inject = ['slots', 'locale', 'remote.credentials', 'settingsScope']

/**
 * Mount the settings card and the composer voice-input control.
 * @param ctx - the browser plugin context.
 */
function apply(ctx) {
  ctx.effect(function () { return ctx.locale.register(NS, DICTIONARIES) }, 'dsh-minimax-asr: dictionaries')
  reportEvent({ event: 'applied', half: 'client' })

  var controller = new CardController(ctx)
  ctx.effect(function () { return function () { controller.dispose() } }, 'dsh-minimax-asr: card controller')

  // The slot is declared at runtime by the configurable tab of
  // @deepseek-ai/dsh-client-ui-settings-plugins, so a bare register would
  // throw; the card joins as soon as the owning tab declares it.
  ctx.slots.inject('settings.plugin.item', function () {
    reportEvent({ event: 'card-registered', slot: 'settings.plugin.item' })
    return ctx.slots.register({
      name: 'settings.plugin.item',
      key: NS,
      locale: NS,
      inject: function () { return controller.inject() },
    }, MinimaxAsrCard)
  })

  // Voice input: a compact control in the composer tool row. The slot is
  // session-scoped, so the component also receives `useInput`/`inputActions`
  // and can write the transcript into that session's draft.
  var mic = new MicController(ctx)
  ctx.effect(function () { return function () { mic.dispose() } }, 'dsh-minimax-asr: microphone controller')
  ctx.slots.inject('conversation.input.left', function () {
    reportEvent({ event: 'mic-registered', slot: 'conversation.input.left' })
    return ctx.slots.register({
      name: 'conversation.input.left',
      id: 'minimax-asr-mic',
      order: 50,
      locale: NS,
      inject: function () { return mic.inject() },
    }, MicButton)
  })
}

exports.name = 'dsh-minimax-asr'
exports.inject = inject
exports.apply = apply
return module.exports; } });
