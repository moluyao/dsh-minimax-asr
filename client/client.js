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

/** Host announcement stream: one frame per finished turn (SSE). */
var EVENTS_ROUTE = '/minimax-asr/events'

/** Host route that synthesises one line of speech. */
var SPEAK_ROUTE = '/minimax-asr/speak'

/** Voice the host half synthesises with unless the section names another. */
var DEFAULT_VOICE = 'male-qn-jingying'

/** Announcements kept while one is still playing. Older ones are dropped. */
var MAX_SPEECH_QUEUE = 3

/** How long to wait before reopening an announcement stream the host refused. */
var STREAM_RETRY_MS = 4000

/** How long an always-on loop waits before trying to listen again. */
var LOOP_RETRY_MS = 5000

/** Ceiling for that retry's backoff, so a refused microphone keeps trying quietly. */
var LOOP_RETRY_MAX_MS = 60000

/** Host route listing the account's voices, for the card's picker. */
var VOICES_ROUTE = '/minimax-asr/voices'

// --- handsfree listening ----------------------------------------------------
// A frame has to clear the room's own noise floor AND look like speech, for long
// enough to be a sentence. The second half of that rule is what stops a keyboard
// tap or a chair creak from being transcribed — and an invented transcript from
// being sent as if the user had said it.

/** One analysis frame; the gate is evaluated per frame. */
var VAD_FRAME_MS = 100
/** Absolute level floor, below which nothing counts as speech. */
var VAD_MIN_RMS = 0.008
/** A frame this loud is speech, not merely "above the room". */
var VAD_SPEECH_RMS = 0.03
/** Consecutive speech frames before the turn is treated as speech. */
var VAD_SPEECH_FRAMES = 3
/**
 * Speech frames a window needs before it is worth transcribing (600 ms). Room
 * noise reaches the recogniser as near-silence, and near-silence comes back as
 * an invented sentence.
 */
var VAD_MIN_SPEECH_FRAMES = 6
/** A frame counts as speech above this multiple of the measured noise floor. */
var VAD_FLOOR_FACTOR = 3
/** Ceiling on the gate, so a loud room cannot deafen the loop entirely. */
var VAD_MAX_GATE = 0.03
/** Ignore this much audio at the start, while the meter settles. */
var VAD_SETTLE_MS = 300
/** Silence after speech that ends the turn, when the section names nothing. */
var VAD_SILENCE_MS = 5000
/** Longest single spoken turn, when the section names nothing. */
var VAD_MAX_TURN_MS = 300000
/**
 * Release the microphone only after this long with nothing said at all. The
 * window rolls over long before this, so a user who pauses to think keeps
 * talking into an open microphone; this is the "walked away and left it on"
 * safety net, not a conversational time limit.
 */
var VAD_IDLE_MS = 30 * 60 * 1000
/** How often the measured level is reported to the host, for tuning. */
var VAD_REPORT_MS = 1000

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
  // Rendered as a checkbox by the speech block rather than by `fieldRow`, but
  // listed here so the save path stages it like any other field.
  { key: 'speakEnabled', label: 'speakEnabled', numeric: false },
  { key: 'ttsModel', label: 'ttsModel', numeric: false },
  { key: 'ttsVoice', label: 'ttsVoice', numeric: false },
  { key: 'ttsSpeed', label: 'ttsSpeed', numeric: true },
  { key: 'speakMaxChars', label: 'speakMaxChars', numeric: true },
  // Rendered as a checkbox by the handsfree block, like `speakEnabled`.
  { key: 'voiceLoop', label: 'voiceLoop', numeric: false },
  { key: 'voiceSilenceSeconds', label: 'voiceSilenceSeconds', numeric: true },
  { key: 'voiceMaxTurnSeconds', label: 'voiceMaxTurnSeconds', numeric: true },
]

var NUMERIC_FIELDS = {
  maxRecordSeconds: true, maxFileMB: true, timeoutMs: true,
  ttsSpeed: true, speakMaxChars: true, voiceSilenceSeconds: true, voiceMaxTurnSeconds: true,
}

/** Boolean fields; a checkbox writes `true`/`false`, never a string. */
var BOOL_FIELDS = { speakEnabled: true, voiceLoop: true }

/**
 * Dictionary key for one speech state.
 * @param speech - the speech snapshot, if the half is mounted.
 * @returns the label key.
 */
function speechStatusKey(speech) {
  if (speech === undefined || speech.supported !== true) return 'speakUnsupported'
  if (speech.status === 'error') return 'speakError'
  if (speech.status === 'speaking') return 'speakSaying'
  if (speech.enabled !== true) return 'speakIdle'
  return speech.connected === true ? 'speakListening' : 'speakReady'
}

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
    speakEnabled: 'Announce finished turns through the speakers',
    ttsModel: 'Speech model',
    ttsVoice: 'Voice',
    ttsSpeed: 'Speech speed',
    speakMaxChars: 'Longest announcement (characters)',
    speakTest: 'Test the voice',
    speakTesting: 'Synthesising...',
    speakSample: 'This is how I will report a finished task.',
    speech: 'Speech',
    speakIdle: 'off',
    speakReady: 'ready',
    speakListening: 'listening',
    speakSaying: 'speaking',
    speakError: 'failed',
    speakToggleOn: 'Turn spoken announcements on',
    speakToggleOff: 'Turn spoken announcements off',
    speakUnsupported: 'This browser cannot play speech here.',
    speakBlocked: 'The browser blocked playback; click anywhere on the page and try again.',
    voiceLoop: 'Handsfree conversation: listen after every reply and send what I say',
    voiceSilenceSeconds: 'Pause that ends my sentence (seconds)',
    voiceMaxTurnSeconds: 'Send anyway after this long (seconds)',
    voiceLoopHint: 'While this is on the microphone reopens by itself once a reply has been read out, and a finished transcript is submitted without a click. Switching it off releases the microphone.',
    voiceStart: 'Start handsfree conversation',
    voiceStop: 'Stop handsfree conversation',
    voiceListening: 'listening',
    voiceThinking: 'thinking',
    voiceSpeaking: 'speaking',
    voicePaused: 'paused, click to resume',
    voiceHeardNothing: 'nothing was said, click to listen again',
    voice: 'Voice',
    voiceCustom: 'Custom voice id...',
    voiceLive: 'from the MiniMax account',
    voiceBuiltin: 'built-in list',
    voiceCustomId: 'Custom voice id',
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
    speakEnabled: '任务结束后用喇叭朗读结果',
    ttsModel: '语音模型',
    ttsVoice: '音色',
    ttsSpeed: '语速',
    speakMaxChars: '朗读字数上限',
    speakTest: '试听音色',
    speakTesting: '合成中…',
    speakSample: '任务完成之后，我会这样把结果念给你听。',
    speech: '朗读',
    speakIdle: '已关闭',
    speakReady: '就绪',
    speakListening: '监听中',
    speakSaying: '正在朗读',
    speakError: '失败',
    speakToggleOn: '开启语音播报',
    speakToggleOff: '关闭语音播报',
    speakUnsupported: '当前浏览器无法播放语音。',
    speakBlocked: '浏览器拦截了自动播放，请在页面任意处点击一次后重试。',
    voiceLoop: '实时对话：每轮回复念完后自动开麦，我说完就自动发送',
    voiceSilenceSeconds: '停顿多久算我说完（秒）',
    voiceMaxTurnSeconds: '连续说满多久就强制发送（秒）',
    voiceLoopHint: '开启后，播报结束时麦克风会自己打开，检测到你说完就自动转写并发送，全程不用点按钮；关闭会立刻释放麦克风。',
    voiceStart: '开始实时对话',
    voiceStop: '结束实时对话',
    voiceListening: '正在听你说',
    voiceThinking: '思考中',
    voiceSpeaking: '正在念回复',
    voicePaused: '已暂停，点一下继续',
    voiceHeardNothing: '没听到声音，点一下重新听',
    voice: '音色',
    voiceCustom: '自定义音色 ID…',
    voiceLive: '来自 MiniMax 账号',
    voiceBuiltin: '内置列表',
    voiceCustomId: '自定义音色 ID',
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
 * @param speech - the speech controller, so the card can show its state and
 * play a sample line.
 */
function CardController(ctx, speech) {
  this.ctx = ctx
  this.speech = speech
  this.scope = ctx.settingsScope.bind({ namespace: NS })
  this.credential = { ref: DEFAULT_CREDENTIAL_REF, configured: false, known: false }
  this.voices = { status: 'loading', source: '', list: [] }
  this.saving = false
  this.failed = false
  var self = this
  this.store = store.createSnapshotStore(this.build())
  this.off = this.scope.subscribe(function () {
    self.syncCredential()
    self.publish()
  })
  // The card shows the switch's live state (listening / speaking), so a change
  // made from the composer control re-renders it too.
  this.offSpeech = speech === undefined
    ? undefined
    : speech.store.subscribe(function () { self.publish() })
  this.readCredential()
  this.loadVoices()
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
    speech: this.speech === undefined ? undefined : this.speech.store.getSnapshot(),
    voices: this.voices,
  }
}

/**
 * Ask the host for the account's voice catalogue. A failure is not a failure of
 * the card: the picker falls back to the free-text field.
 */
CardController.prototype.loadVoices = function () {
  var self = this
  if (typeof fetch !== 'function') {
    this.voices = { status: 'failed', source: '', list: [] }
    return
  }
  fetch(VOICES_ROUTE).then(function (response) {
    return response.json().then(function (body) { return { status: response.status, body: body } })
  }).then(function (result) {
    var body = result.body
    var list = body !== null && typeof body === 'object' && Array.isArray(body.voices) ? body.voices : []
    self.voices = result.status === 200 && list.length > 0
      ? { status: 'ready', source: typeof body.source === 'string' ? body.source : '', list: list }
      : { status: 'failed', source: '', list: [] }
    self.publish()
  }).catch(function () {
    self.voices = { status: 'failed', source: '', list: [] }
    self.publish()
  })
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
    say: function (text, options) {
      if (self.speech !== undefined) self.speech.tryVoice(text, options)
    },
    toggleSpeech: function () {
      if (self.speech !== undefined) self.speech.toggle()
    },
    // Opening the card is the natural moment to retry a catalogue the host
    // could not serve earlier — a deployment restarted after the page loaded,
    // for instance — so the picker appears without a page reload. The guard
    // reads what the card is actually showing.
    loadVoices: function () {
      var shown = self.store.getSnapshot().voices
      if (shown === null || typeof shown !== 'object' || shown.status !== 'failed') return
      self.voices = { status: 'loading', source: '', list: [] }
      self.publish()
      self.loadVoices()
    },
  }
}

CardController.prototype.dispose = function () {
  this.off()
  if (this.offSpeech !== undefined) {
    this.offSpeech()
    this.offSpeech = undefined
  }
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
var headingStyle = {
  marginTop: '10px',
  paddingTop: '8px',
  borderTop: '1px solid var(--dsw-color-border, #d0d5dd)',
  fontSize: '12px',
  fontWeight: 600,
  opacity: 0.8,
}
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
      if (BOOL_FIELDS[field] === true) {
        ops.push({ op: 'set', path: [field], value: text === 'true' })
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

  // The spoken-announcement half: a switch, its live state, and a sample line,
  // kept in one block so the settings above stay about transcription.
  var speech = state.speech !== null && typeof state.speech === 'object' ? state.speech : undefined
  var speakEnabled = (function () {
    var current = shown('speakEnabled')
    // The host default is on, so a section that names nothing means "on".
    return current === '' ? true : current === 'true'
  })()

  var speechHeadingRow = function () {
    return React.createElement('div', { key: 'speech-heading', style: headingStyle }, t('speech'))
  }

  var speakToggleRow = function () {
    var overridden = owns(user, 'speakEnabled')
    return React.createElement('div', { key: 'speakEnabled', style: rowStyle },
      React.createElement('div', { style: labelStyle },
        React.createElement('label', { htmlFor: 'minimax-asr-speakEnabled' }, t('speakEnabled')),
        overridden ? React.createElement('span', { style: badgeStyle }, t('overridden')) : null,
        overridden
          ? React.createElement('button', {
            type: 'button',
            disabled: busy || !writable,
            onClick: function () { edit('speakEnabled', '') },
          }, t('reset'))
          : null,
      ),
      React.createElement('input', {
        id: 'minimax-asr-speakEnabled',
        type: 'checkbox',
        checked: speakEnabled,
        disabled: busy || !writable,
        onChange: function (event) { edit('speakEnabled', event.currentTarget.checked ? 'true' : 'false') },
      }),
    )
  }

  var speechStateRow = function () {
    return React.createElement('div', { key: 'speech-state', style: rowStyle },
      React.createElement('div', { style: labelStyle },
        React.createElement('span', null, t('speech')),
        speech !== undefined && typeof speech.voice === 'string' && speech.voice.length > 0
          ? React.createElement('span', { style: hintStyle }, speech.voice)
          : null,
        speech !== undefined && speech.status === 'error' && typeof speech.error === 'string'
          ? React.createElement('span', { style: hintStyle },
            speech.error === 'blocked' ? t('speakBlocked') : speech.error)
          : null,
      ),
      React.createElement('div', { style: labelStyle },
        React.createElement('span', { style: badgeStyle }, t(speechStatusKey(speech))),
        React.createElement('button', {
          type: 'button',
          disabled: busy || speech === undefined || speech.supported !== true,
          // Auditioning uses whatever the picker currently shows, saved or not.
          onClick: function () {
            props.say(t('speakSample'), { voice: spokenVoice(), speed: spokenSpeed() })
          },
        }, t('speakTest')),
      ),
    )
  }

  // --- the voice picker -----------------------------------------------------
  // The host serves the account's whole catalogue (303 system voices when the
  // request succeeds), grouped by language; an id that is not in it - a cloned
  // voice, or a catalogue the host could not fetch - keeps the text field.
  var voiceCatalogue = state.voices !== null && typeof state.voices === 'object' ? state.voices : {}
  var voiceList = Array.isArray(voiceCatalogue.list) ? voiceCatalogue.list : []
  var customPair = React.useState(false)
  var customWanted = customPair[0]
  var setCustomWanted = customPair[1]
  /** The voice the next synthesis would use, draft included. */
  var spokenVoice = function () { return shown('ttsVoice') || DEFAULT_VOICE }
  /** The staged rate, so an audition hears the rate it would save. */
  var spokenSpeed = function () {
    var declared = Number(shown('ttsSpeed'))
    return isFinite(declared) && declared > 0 ? declared : 1
  }

  var voiceRow = function () {
    var current = spokenVoice()
    var listed = false
    for (var index = 0; index < voiceList.length; index += 1) {
      if (voiceList[index].id === current) listed = true
    }
    var custom = customWanted || (voiceList.length > 0 && !listed)
    var overridden = owns(user, 'ttsVoice')
    var children = []
    if (voiceList.length > 0) {
      var groups = []
      var seen = {}
      for (var v = 0; v < voiceList.length; v += 1) {
        var group = typeof voiceList[v].group === 'string' && voiceList[v].group.length > 0 ? voiceList[v].group : '其它'
        if (seen[group] === undefined) {
          seen[group] = []
          groups.push(group)
        }
        seen[group].push(voiceList[v])
      }
      var options = []
      for (var g = 0; g < groups.length; g += 1) {
        var items = seen[groups[g]].map(function (voice) {
          return React.createElement('option', { key: voice.id, value: voice.id }, voice.id + ' · ' + voice.name)
        })
        options.push(React.createElement('optgroup', { key: groups[g], label: groups[g] }, items))
      }
      options.push(React.createElement('option', { key: '__custom__', value: '__custom__' }, t('voiceCustom')))
      children.push(React.createElement('select', {
        key: 'select',
        id: 'minimax-asr-ttsVoice',
        style: inputStyle,
        value: custom ? '__custom__' : current,
        disabled: busy || !writable,
        onChange: function (event) {
          var next = event.currentTarget.value
          if (next === '__custom__') {
            setCustomWanted(true)
            return
          }
          setCustomWanted(false)
          edit('ttsVoice', next)
        },
      }, options))
    }
    if (custom || voiceList.length === 0) {
      children.push(React.createElement('input', {
        key: 'custom',
        id: 'minimax-asr-ttsVoice-custom',
        type: 'text',
        style: inputStyle,
        placeholder: DEFAULT_VOICE,
        value: shown('ttsVoice'),
        disabled: busy || !writable,
        onChange: function (event) { edit('ttsVoice', event.currentTarget.value) },
      }))
    }
    return React.createElement('div', { key: 'ttsVoice', style: rowStyle },
      React.createElement('div', { style: labelStyle },
        React.createElement('label', { htmlFor: 'minimax-asr-ttsVoice' }, t('voice')),
        overridden ? React.createElement('span', { style: badgeStyle }, t('overridden')) : null,
        voiceList.length > 0
          ? React.createElement('span', { style: hintStyle },
            voiceList.length + ' · ' + t(voiceCatalogue.source === 'builtin' ? 'voiceBuiltin' : 'voiceLive'))
          : null,
        overridden
          ? React.createElement('button', {
            type: 'button',
            disabled: busy || !writable,
            onClick: function () { edit('ttsVoice', '') },
          }, t('reset'))
          : null,
      ),
      React.createElement('div', { style: labelStyle }, children),
    )
  }

  // --- the handsfree switch -------------------------------------------------
  var loopToggleRow = function () {
    var speechOn = speech !== undefined && speech.supported === true
    var on = speech !== undefined && speech.loop === true
    var overridden = owns(user, 'voiceLoop')
    var note = !speechOn
      ? t('speakUnsupported')
      : speech.loopNote === 'heard-nothing' ? t('voiceHeardNothing')
        : speech.loopNote === 'no-microphone' ? t('micUnsupported')
          : speech.loopNote === 'mic-failed' ? t('micFailed')
            : t('voiceLoopHint')
    return React.createElement('div', { key: 'voiceLoop', style: rowStyle },
      React.createElement('div', { style: labelStyle },
        React.createElement('label', { htmlFor: 'minimax-asr-voiceLoop' }, t('voiceLoop')),
        overridden ? React.createElement('span', { style: badgeStyle }, t('overridden')) : null,
        React.createElement('span', { style: hintStyle }, note),
        overridden
          ? React.createElement('button', {
            type: 'button',
            disabled: busy || !writable,
            onClick: function () { edit('voiceLoop', '') },
          }, t('reset'))
          : null,
      ),
      React.createElement('input', {
        id: 'minimax-asr-voiceLoop',
        type: 'checkbox',
        checked: (function () {
          var current = shown('voiceLoop')
          return current === '' ? false : current === 'true'
        })(),
        disabled: busy || !writable || !speechOn,
        onChange: function (event) { edit('voiceLoop', event.currentTarget.checked ? 'true' : 'false') },
      }),
    )
  }

  var rows = []
  var speechStarted = false
  for (var i = 0; i < FIELDS.length; i += 1) {
    if (FIELDS[i].key === 'speakEnabled' && !speechStarted) {
      speechStarted = true
      rows.push(speechHeadingRow())
      rows.push(speakToggleRow())
      rows.push(speechStateRow())
      continue
    }
    if (FIELDS[i].key === 'ttsVoice') {
      rows.push(voiceRow())
      continue
    }
    rows.push(fieldRow(FIELDS[i]))
  }
  rows.push(loopToggleRow())

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
      onClick: function () {
        if (!open && typeof props.loadVoices === 'function') props.loadVoices()
        setOpen(!open)
      },
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

/**
 * Attach a level analyser to a live microphone stream.
 *
 * The context is created once and reused for the lifetime of the controller.
 * That is not an optimisation: Chrome starts a fresh `AudioContext` *suspended*
 * unless a user gesture is in flight, and an analyser on a suspended context
 * reports zero for every frame. A window that opened its own context therefore
 * went deaf the moment it was opened on a timer instead of on a click, which is
 * why the handsfree loop seemed to stop listening until the user toggled it.
 * @param stream - the microphone stream.
 * @param existing - the controller's context, reused when it is still open.
 * @returns the analyser handle, or null when the browser has no Web Audio.
 */
function createLevelMeter(stream, existing) {
  var Ctor = typeof window === 'undefined' ? undefined : window.AudioContext || window.webkitAudioContext
  if (typeof Ctor !== 'function' || typeof stream === 'undefined' || stream === null) return null
  try {
    var context = existing !== undefined && existing !== null && existing.state !== 'closed' ? existing : new Ctor()
    if (context.state === 'suspended' && typeof context.resume === 'function') {
      // A context that is running is the whole point; a rejected resume leaves
      // the meter reporting zeros, which the diagnostics will show.
      context.resume().catch(function () {})
    }
    var source = context.createMediaStreamSource(stream)
    var analyser = context.createAnalyser()
    analyser.fftSize = 2048
    source.connect(analyser)
    return {
      context: context,
      analyser: analyser,
      buffer: new Float32Array(analyser.fftSize),
      /** Root-mean-square level of the newest frame. */
      level: function () {
        analyser.getFloatTimeDomainData(this.buffer)
        var sum = 0
        for (var i = 0; i < this.buffer.length; i += 1) sum += this.buffer[i] * this.buffer[i]
        return Math.sqrt(sum / this.buffer.length)
      },
      /** Detach from the stream; the shared context stays open for the next window. */
      close: function () {
        try {
          source.disconnect()
        } catch (error) {
          // Already detached.
        }
      },
    }
  } catch (error) {
    return null
  }
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
    /** True while the microphone is open because the handsfree loop asked. */
    handsfree: false,
    /** Whether anything above the gate has been heard in this recording. */
    heard: false,
    /** Newest measured level and the gate it is compared against. */
    level: 0,
    gate: 0,
  })
  this.recorder = null
  this.stream = null
  this.chunks = []
  this.timer = null
  this.startedAt = 0
  // Handsfree listening state: the level meter, its frame clock, and what the
  // gate has seen so far.
  this.meter = null
  /** The one AudioContext every window reuses; see createLevelMeter. */
  this.audioContext = null
  this.vadTimer = null
  this.vad = false
  /** True while this recording belongs to the handsfree loop. */
  this.handsfree = false
  /** Bumped to invalidate an in-flight `getUserMedia` request. */
  this.requestSeq = 0
  this.floor = null
  this.heardFrames = 0
  /** Frames in this window that were loud enough to be a voice. */
  this.speechFrames = 0
  this.quietSince = 0
  this.loudest = 0
  this.lastReport = 0
  this.abandoned = false
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

/**
 * Open the microphone and record handsfree: the level gate ends the turn, so
 * nothing is clicked. Nothing said for {@link VAD_IDLE_MS} releases the
 * microphone without uploading an empty recording.
 * @returns whether listening began.
 */
MicController.prototype.listen = function (options) {
  var status = this.store.getSnapshot().status
  var override = options !== undefined && options.force === true
  if (status === 'recording' && override !== true) return false
  if (status === 'transcribing' || status === 'starting') return false
  if (this.store.getSnapshot().supported !== true) return false
  this.vad = true
  this.handsfree = true
  this.abandoned = false
  this.floor = null
  this.heardFrames = 0
  this.speechFrames = 0
  this.quietSince = 0
  this.loudest = 0
  this.publish({ handsfree: true, heard: false, level: 0, gate: 0, silent: false })
  this.start()
  return true
}

/**
 * Give up on a handsfree recording without uploading anything: used when the
 * loop is switched off or the microphone is needed for something else.
 */
MicController.prototype.release = function () {
  if (this.vad !== true && this.store.getSnapshot().handsfree !== true) return
  this.vad = false
  this.handsfree = false
  this.abandoned = true
  // A microphone that is still opening must not survive this call.
  this.requestSeq += 1
  this.stopMeter()
  var recorder = this.recorder
  this.recorder = null
  this.chunks = []
  if (this.timer !== null) {
    clearInterval(this.timer)
    this.timer = null
  }
  if (recorder !== null && recorder.state !== 'inactive') {
    try {
      recorder.onstop = null
      recorder.stop()
    } catch (error) {
      // Already stopped.
    }
  }
  this.releaseStream()
  this.publish({ status: 'idle', seconds: 0, handsfree: false, heard: false })
}

/**
 * Try to have a listening microphone, whatever the previous attempt left
 * behind: a failed window is dropped and the microphone is opened again.
 * @returns whether a usable window is open (or already was).
 */
MicController.prototype.retry = function () {
  var status = this.store.getSnapshot().status
  if (status === 'recording' || status === 'starting' || status === 'transcribing') return true
  if (this.store.getSnapshot().supported !== true) return false
  // The failure must not block the next attempt: clear what it left behind.
  this.abandonHandsfree(false)
  return this.listen({ force: true }) === true
}

/**
 * How long a pause means the sentence is over, from the settings section.
 * A short gap sends while the user is still thinking; a long one makes the
 * exchange feel slow. The user owns that trade-off.
 * @returns milliseconds in `[1000, 60000]`.
 */
MicController.prototype.silenceMs = function () {
  var value = this.scope === undefined ? undefined : this.scope.getSnapshot().value
  var declared = value !== null && typeof value === 'object' ? Number(value.voiceSilenceSeconds) : Number.NaN
  if (!isFinite(declared)) return VAD_SILENCE_MS
  return Math.min(60000, Math.max(1000, declared * 1000))
}

/**
 * Longest single spoken turn before it is sent anyway, from the settings
 * section: the safety valve for a window that never goes quiet.
 * @returns milliseconds in `[10000, 600000]`.
 */
MicController.prototype.maxTurnMs = function () {
  var value = this.scope === undefined ? undefined : this.scope.getSnapshot().value
  var declared = value !== null && typeof value === 'object' ? Number(value.voiceMaxTurnSeconds) : Number.NaN
  if (!isFinite(declared)) return VAD_MAX_TURN_MS
  return Math.min(600000, Math.max(10000, declared * 1000))
}

/** Stop the level meter and its frame clock. */
MicController.prototype.stopMeter = function () {
  if (this.vadTimer !== null) {
    clearInterval(this.vadTimer)
    this.vadTimer = null
  }
  if (this.meter !== null) {
    this.meter.close()
    this.meter = null
  }
}

/** Drop the "nothing was heard" marker, so the loop can open the mic again. */
MicController.prototype.clearSilence = function () {
  if (this.store.getSnapshot().silent !== true) return
  this.publish({ silent: false })
}

/**
 * Start the gate that decides when a handsfree turn has ended.
 *
 * The gate has to survive a quiet built-in microphone array, so it adapts: the
 * room is measured first, and speech has to clear both that floor and an
 * absolute minimum. Above the gate, a window is only treated as speech when it
 * contains {@link VAD_MIN_SPEECH_FRAMES} frames that are actually loud — room
 * noise that merely crosses the gate must never reach the recogniser, because
 * near-silence comes back as an invented sentence. The measured numbers go to
 * the host's diagnostics route, so a mis-tuned gate is visible from outside the
 * browser.
 */
MicController.prototype.startMeter = function () {
  var self = this
  this.meter = createLevelMeter(this.stream, this.audioContext)
  if (this.meter === null) {
    // Without Web Audio the gate cannot run: fall back to the configured cap.
    reportEvent({ event: 'mic-meter-unavailable' })
    this.publish({ error: null })
    return
  }
  this.audioContext = this.meter.context
  if (this.meter.context !== undefined && this.meter.context.state !== 'running') {
    // Reported so a context that never started is visible from the host.
    reportEvent({ event: 'mic-audio-context', state: String(this.meter.context.state) })
  }
  this.vadTimer = setInterval(function () {
    var level = self.meter === null ? 0 : self.meter.level()
    var now = Date.now()
    var elapsed = now - self.startedAt
    // The floor is only ever learned from quiet frames, so a turn that begins
    // loudly cannot raise the gate above the speaker's own voice (which would
    // make the loop deaf for the rest of the window).
    var reference = self.floor === null ? VAD_MIN_RMS : self.floor
    var gate = Math.min(VAD_MAX_GATE, Math.max(VAD_MIN_RMS, reference * VAD_FLOOR_FACTOR))
    if (elapsed >= VAD_SETTLE_MS) {
      if (level >= VAD_SPEECH_RMS) {
        // Loud enough to be a voice: the only thing that counts as speech.
        self.speechFrames += 1
        self.heardFrames += 1
        self.quietSince = 0
        if (level > self.loudest) self.loudest = level
      } else {
        if (level <= gate) {
          self.floor = self.floor === null ? level : Math.min(self.floor, level)
          self.heardFrames = 0
        }
        // A pause inside a sentence: the turn ends after VAD_SILENCE_MS of it,
        // but the speech frames already counted still stand.
        if (self.speechFrames >= VAD_SPEECH_FRAMES && self.quietSince === 0) self.quietSince = now
      }
    }
    var spoken = self.speechFrames >= VAD_SPEECH_FRAMES
    self.publish({
      level: Number(level.toFixed(5)),
      gate: Number(gate.toFixed(5)),
      heard: spoken,
      seconds: Math.floor(elapsed / 1000),
    })
    if (now - self.lastReport >= VAD_REPORT_MS) {
      self.lastReport = now
      reportEvent({
        event: 'mic-level',
        level: Number(level.toFixed(5)),
        floor: self.floor === null ? null : Number(self.floor.toFixed(5)),
        gate: Number(gate.toFixed(5)),
        loudest: Number(self.loudest.toFixed(5)),
        speechFrames: self.speechFrames,
        heard: spoken,
        seconds: Math.floor(elapsed / 1000),
      })
    }
    if (spoken && self.quietSince !== 0 && now - self.quietSince >= self.silenceMs()) {
      if (self.speechFrames < VAD_MIN_SPEECH_FRAMES) {
        // A blip, not a sentence. Sending this would have the recogniser invent
        // one, and the loop would post the invention as the user's words — but
        // it is still not the end of the conversation.
        reportEvent({ event: 'mic-too-short', speechFrames: self.speechFrames })
        self.rollHandsfree()
        return
      }
      // Said something, then stopped: that is the end of the turn.
      self.stop()
      return
    }
    if (spoken && elapsed >= self.maxTurnMs()) {
      if (self.speechFrames < VAD_MIN_SPEECH_FRAMES) {
        self.rollHandsfree()
        return
      }
      self.stop()
      return
    }
    if (!spoken && elapsed >= VAD_IDLE_MS) {
      // Nothing was said; release the microphone rather than upload silence.
      reportEvent({ event: 'mic-idle-timeout', seconds: Math.round(elapsed / 1000) })
      self.abandonHandsfree(true)
      return
    }
  }, VAD_FRAME_MS)
}

/**
 * End a handsfree window without uploading it: the microphone is released and
 * `silent` tells the loop it heard nothing, so it pauses instead of retrying
 * forever. Nothing here may reach the transcription endpoint — a window with no
 * real speech in it comes back from the recogniser as an invented sentence.
 * @param silent - whether to mark the window as "nothing was said".
 */
MicController.prototype.abandonHandsfree = function (silent) {
  this.vad = false
  this.handsfree = false
  this.abandoned = true
  this.stopMeter()
  if (this.timer !== null) {
    clearInterval(this.timer)
    this.timer = null
  }
  var recorder = this.recorder
  this.recorder = null
  this.chunks = []
  if (recorder !== null && recorder.state !== 'inactive') {
    try {
      recorder.onstop = null
      recorder.stop()
    } catch (error) {
      // Already stopped.
    }
  }
  this.releaseStream()
  this.publish({ status: 'idle', seconds: 0, handsfree: false, heard: false, silent: silent === true })
}

/** Open the microphone and begin recording. */
MicController.prototype.start = function () {
  var self = this
  if (this.store.getSnapshot().supported !== true) return
  this.publish({ status: 'starting', error: null, seconds: 0 })
  // `getUserMedia` can resolve after the microphone was already released; this
  // generation counter is what makes a late answer harmless.
  this.requestSeq += 1
  var request = this.requestSeq
  navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  }).then(function (stream) {
    if (request !== self.requestSeq) {
      // The microphone was cancelled while the permission/stream was in flight.
      if (stream !== null && typeof stream.getTracks === 'function') {
        var late = stream.getTracks()
        for (var index = 0; index < late.length; index += 1) {
          try {
            late[index].stop()
          } catch (error) {
            // Already stopped.
          }
        }
      }
      return
    }
    self.stream = stream
    self.chunks = []
    self.beginWindow(stream)
  }, function (error) {
    self.vad = false
    self.stopMeter()
    self.publish({ handsfree: false })
    self.fail(error !== null && typeof error === 'object' && typeof error.message === 'string'
      ? error
      : new Error('microphone permission was refused'))
  })
}

/**
 * Start one recording window on an open stream: a recorder, the elapsed-time
 * clock, and — in handsfree mode — the level meter.
 *
 * A handsfree window is disposable. When it fills up it is rolled over instead
 * of stopped (see {@link MicController.rollHandsfree}), which is what lets the
 * microphone stay open for as long as the user wants to keep talking to it.
 * @param stream - the live microphone stream.
 */
MicController.prototype.beginWindow = function (stream) {
  var self = this
  var options = {}
  if (typeof window.MediaRecorder.isTypeSupported === 'function'
    && window.MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
    options.mimeType = 'audio/webm;codecs=opus'
  }
  var recorder = new window.MediaRecorder(stream, options)
  this.recorder = recorder
  this.abandoned = false
  recorder.ondataavailable = function (event) {
    if (event.data !== null && event.data !== undefined && event.data.size > 0) self.chunks.push(event.data)
  }
  recorder.onstop = function () { self.finish() }
  recorder.onerror = function () { self.fail(new Error('recording failed')) }
  recorder.start()
  this.startedAt = Date.now()
  this.speechFrames = 0
  this.heardFrames = 0
  this.quietSince = 0
  this.loudest = 0
  this.floor = null
  var limit = this.limitSeconds()
  this.publish({
    status: 'recording',
    seconds: 0,
    error: null,
    limitSeconds: limit,
    handsfree: this.vad === true,
    heard: false,
  })
  if (this.timer !== null) clearInterval(this.timer)
  this.timer = setInterval(function () {
    var seconds = Math.floor((Date.now() - self.startedAt) / 1000)
    if (self.vad !== true) self.publish({ seconds: seconds })
    if (seconds >= limit) {
      // A full window with speech in it is a long turn: send it. A full window
      // with no speech in it is just the user thinking: discard it and keep
      // listening. Discarding both would throw away a long answer, which is
      // exactly the thing the person speaking would notice.
      if (self.vad !== true) {
        self.stop()
        return
      }
      if (self.speechFrames >= VAD_MIN_SPEECH_FRAMES) self.stop()
      else self.rollHandsfree()
    }
  }, 500)
  if (this.vad === true) {
    this.stopMeter()
    this.startMeter()
  }
}

/**
 * Close the current handsfree window without uploading it, and open the next one
 * on the still-open microphone. Nothing spoken means nothing to transcribe — it
 * does not mean the exchange is over.
 */
MicController.prototype.rollHandsfree = function () {
  if (this.vad !== true) return
  reportEvent({
    event: 'handsfree-roll',
    seconds: Math.round((Date.now() - this.startedAt) / 1000),
    speechFrames: this.speechFrames,
  })
  var recorder = this.recorder
  this.recorder = null
  this.chunks = []
  this.abandoned = true
  if (recorder !== null && recorder.state !== 'inactive') {
    try {
      // Detached: this window's bytes are discarded, never transcribed.
      recorder.onstop = null
      recorder.stop()
    } catch (error) {
      // Already stopped.
    }
  }
  this.abandoned = false
  if (this.stream === null || this.vad !== true) return
  this.beginWindow(this.stream)
}

/** Stop recording; the recorder's own `onstop` continues into transcription. */
MicController.prototype.stop = function () {
  this.vad = false
  this.stopMeter()
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
  var handsfree = this.handsfree === true
  this.recorder = null
  this.chunks = []
  this.handsfree = false
  this.releaseStream()
  // A handsfree window that heard nothing must never reach the endpoint: the
  // user pausing to think is not an empty message, and the cap firing on a
  // silent window is the same situation.
  if (this.abandoned === true || (handsfree === true && this.store.getSnapshot().heard !== true)) {
    this.abandoned = false
    this.publish({
      status: 'idle',
      seconds: 0,
      handsfree: false,
      heard: false,
      silent: handsfree,
    })
    return
  }
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
        handsfree: false,
        heard: false,
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
  this.vad = false
  this.handsfree = false
  this.requestSeq += 1
  this.stopMeter()
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
    handsfree: false,
    heard: false,
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
  this.vad = false
  this.abandoned = true
  this.stopMeter()
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

MicController.prototype.inject = function (speech) {
  var self = this
  return {
    hooks: {
      mic: this.store,
      // The handsfree loop owns the transcript while it is on: this control
      // must not also paste it into the draft.
      speech: speech === undefined ? undefined : speech.store,
    },
    toggle: function () { self.toggle() },
  }
}

// --- speech: the host talks back -------------------------------------------

/** Whether this browser can play synthesised speech at all. */
function speechSupported() {
  return typeof window !== 'undefined'
    && typeof window.EventSource === 'function'
    && typeof window.Audio === 'function'
    && typeof URL !== 'undefined'
    && typeof URL.createObjectURL === 'function'
}

/**
 * Plays the host's announcements through the speakers, and — in loop mode —
 * runs the whole handsfree conversation with the microphone controller.
 *
 * The host pushes one frame per finished turn on the announcement stream; this
 * half turns each frame into audio and plays it, so a turn that ends while the
 * user is looking elsewhere still arrives. Playback is queued rather than
 * overlapped, and turning the feature off stops whatever is playing.
 * @param ctx - the browser plugin context, for the settings scope.
 * @param mic - the microphone controller the loop drives.
 */
function SpeechController(ctx, mic) {
  this.scope = ctx === undefined || ctx.settingsScope === undefined
    ? undefined
    : ctx.settingsScope.bind({ namespace: NS })
  this.mic = mic
  this.stream = null
  this.audio = null
  this.objectURL = null
  this.queue = []
  this.playing = false
  // Settles an in-flight playback when it is interrupted, so a paused element
  // (which fires no `ended`) cannot leave the controller thinking it is busy.
  this.abort = null
  // Set by the toggle so the control reacts before the host round-trip lands.
  this.override = null
  this.loopOverride = null
  // Re-entrancy guards for the handsfree machine; both stores notify on write.
  this.syncing = false
  this.arming = false
  /** Pending self-heal of an always-on loop; see scheduleRetry. */
  this.retryListening = null
  /** Consecutive failed retries, for the backoff. */
  this.retryCount = 0
  // Pending reopen of a refused announcement stream; see open().
  this.retry = null
  // The mounted session's composer, handed over by the composer control.
  this.input = null
  // Transcripts that arrived before this controller existed are not ours.
  this.lastSubmittedSeq = mic === undefined ? 0 : mic.store.getSnapshot().textSeq
  this.store = store.createSnapshotStore({
    enabled: this.enabled(),
    status: 'idle',
    error: null,
    heard: 0,
    spoken: 0,
    dropped: 0,
    pending: 0,
    connected: false,
    supported: speechSupported(),
    voice: this.voice(),
    lastText: '',
    /** Handsfree conversation mode. */
    loop: false,
    /** off | listening | thinking | speaking | paused */
    stage: 'off',
    /** The last transcript the loop submitted, for the control's tooltip. */
    lastHeard: '',
    /** Why the loop paused, if it did. */
    loopNote: null,
    /** How many exchanges this page has completed. */
    exchanges: 0,
  })
  var self = this
  this.offScope = this.scope === undefined
    ? undefined
    : this.scope.subscribe(function () { self.onSectionChange() })
  this.offMic = mic === undefined
    ? undefined
    : mic.store.subscribe(function () { self.onMicChange() })
  if (this.enabled()) this.open()
}

/** Whether announcements should be spoken right now. */
SpeechController.prototype.enabled = function () {
  if (this.override !== null) return this.override
  if (this.scope === undefined) return true
  var value = this.scope.getSnapshot().value
  if (value === null || typeof value !== 'object') return true
  return value.speakEnabled !== false
}

/**
 * Whether handsfree conversation mode is on. The loop needs a voice, so it
 * implies announcements whether or not that switch is separately on.
 */
SpeechController.prototype.loopEnabled = function () {
  if (this.loopOverride !== null) return this.loopOverride
  if (this.scope === undefined) return false
  var value = this.scope.getSnapshot().value
  if (value === null || typeof value !== 'object') return false
  return value.voiceLoop === true
}

/** Whether announcements are spoken, counting a running loop as consent. */
SpeechController.prototype.speaks = function () {
  return this.enabled() === true || this.loopEnabled() === true
}

/** The configured voice, for the tooltip. */
SpeechController.prototype.voice = function () {
  var value = this.scope === undefined ? undefined : this.scope.getSnapshot().value
  var declared = value !== null && typeof value === 'object' ? value.ttsVoice : undefined
  return typeof declared === 'string' && declared.length > 0 ? declared : DEFAULT_VOICE
}

/**
 * A committed section change re-reads the switches. An override the host has
 * since agreed with is dropped, so the host stays authoritative.
 */
SpeechController.prototype.onSectionChange = function () {
  var value = this.scope.getSnapshot().value
  var committedEnabled = value !== null && typeof value === 'object' ? value.speakEnabled : undefined
  if (this.override !== null && committedEnabled === this.override) this.override = null
  var committedLoop = value !== null && typeof value === 'object' ? value.voiceLoop : undefined
  if (this.loopOverride !== null && committedLoop === this.loopOverride) this.loopOverride = null

  var enabled = this.speaks()
  this.publish({ enabled: enabled, voice: this.voice() })
  if (enabled) this.open()
  else this.stop()
  this.syncLoop()
}

/** Publish a patch over the current snapshot. */
SpeechController.prototype.publish = function (patch) {
  var current = this.store.getSnapshot()
  var next = {}
  for (var key in current) if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key]
  for (var patchKey in patch) if (Object.prototype.hasOwnProperty.call(patch, patchKey)) next[patchKey] = patch[patchKey]
  this.store.set(next)
}

/**
 * The composer control hands over the mounted session's input actions, which is
 * the only way this half can submit a spoken message. Registered on mount and
 * dropped on unmount, so a handed-over session never outlives its control.
 * @param actions - `{ setDraft, submit, sessionId }`, or null to detach.
 */
SpeechController.prototype.attachInput = function (actions) {
  this.input = actions
  this.syncLoop()
}

/** The transcript the microphone just produced, if the loop owns it. */
SpeechController.prototype.onMicChange = function () {
  var mic = this.mic === undefined ? undefined : this.mic.store.getSnapshot()
  if (mic === undefined) return
  if (mic.textSeq > this.lastSubmittedSeq) {
    this.lastSubmittedSeq = mic.textSeq
    var text = typeof mic.text === 'string' ? mic.text.trim() : ''
    if (text.length > 0) {
      this.publish({ lastHeard: text, exchanges: this.store.getSnapshot().exchanges + 1 })
      if (this.loopEnabled() === true) this.submitTranscript(text)
    }
  }
  this.syncLoop()
}

/**
 * Submit one spoken message: the loop replaces the draft rather than merging,
 * so an auto-sent message never carries along text the user typed earlier.
 * @param text - the transcript.
 */
SpeechController.prototype.submitTranscript = function (text) {
  var actions = this.input
  this.publish({ stage: 'thinking', loopNote: null })
  if (actions === null || typeof actions.setDraft !== 'function' || typeof actions.submit !== 'function') {
    this.publish({ loopNote: 'no-session', stage: 'paused' })
    reportEvent({ event: 'voice-submit-failed', error: 'no session composer is mounted' })
    return
  }
  actions.setDraft(text)
  reportEvent({ event: 'voice-submitted', chars: text.length, sessionId: actions.sessionId })
  // One macrotask later, so the editor binding has certainly taken the write.
  window.setTimeout(function () {
    try {
      actions.submit()
    } catch (error) {
      reportEvent({ event: 'voice-submit-failed', error: String(error && error.message) })
    }
  }, 0)
}

/** Turn the loop on or off, persisting the switch when the host is writable. */
SpeechController.prototype.toggleLoop = function () {
  var self = this
  if (this.store.getSnapshot().supported !== true) return
  var next = this.loopEnabled() !== true
  this.loopOverride = next
  // A fresh start must not inherit the previous pause. Switching *off* leaves
  // the old state on purpose: that is what tells the loop to release the
  // microphone on its way out.
  this.publish(next ? { loop: true, loopNote: null, stage: 'listening' } : { loopNote: null })
  this.syncLoop()
  if (this.scope === undefined) return
  var snapshot = this.scope.getSnapshot()
  if (snapshot.writable !== true || snapshot.mode !== 'host') return
  var ops = [{ op: 'set', path: ['voiceLoop'], value: next }]
  // The loop cannot hear anything it does not speak, so switching it on turns
  // announcements on in the same write.
  if (next === true && this.enabled() !== true) ops.push({ op: 'set', path: ['speakEnabled'], value: true })
  snapshot = this.scope.getSnapshot()
  this.scope.mutate(ops, snapshot.revision).catch(function () {
    self.loopOverride = null
    self.publish({ loop: self.loopEnabled(), loopNote: 'save-failed' })
    self.syncLoop()
  })
}

/**
 * Drive the handsfree loop from whatever the two halves are doing.
 *
 * The microphone stays closed while a reply is being spoken (it would record
 * the speakers) and while the agent is thinking; it reopens by itself once the
 * reply has finished, which is what makes the exchange handsfree.
 */
SpeechController.prototype.syncLoop = function () {
  // Every step below publishes, and every publish notifies the two stores this
  // loop watches: without this guard the machine re-enters itself forever.
  if (this.syncing === true) return
  this.syncing = true
  try {
    this.syncLoopOnce()
  } finally {
    this.syncing = false
  }
}

/** One pass of the handsfree state machine. */
SpeechController.prototype.syncLoopOnce = function () {
  var snapshot = this.store.getSnapshot()
  var on = this.loopEnabled() === true && snapshot.supported === true
  if (!on) {
    if (snapshot.loop === true || snapshot.stage !== 'off') {
      if (this.mic !== undefined) this.mic.release()
      this.publish({ loop: false, stage: 'off' })
    }
    return
  }
  if (snapshot.loop !== true) this.publish({ loop: true })

  var micStatus = this.mic === undefined ? 'idle' : this.mic.store.getSnapshot().status
  var stage = snapshot.stage
  if (snapshot.status === 'speaking') {
    if (stage !== 'speaking') this.publish({ stage: 'speaking' })
    return
  }
  if (micStatus === 'starting' || micStatus === 'recording' || micStatus === 'transcribing') {
    if (stage !== 'listening') this.publish({ stage: 'listening' })
    return
  }
  if (micStatus === 'error') {
    if (stage !== 'paused') this.publish({ stage: 'paused', loopNote: 'mic-failed' })
    this.scheduleRetry()
    return
  }
  if (micStatus === 'idle' && this.mic !== undefined) {
    var mic = this.mic.store.getSnapshot()
    if (mic.silent === true) {
      // Nothing was said for the whole window. The flag is consumed, so it
      // pauses this pass and a later click can start listening again.
      this.publish({ stage: 'paused', loopNote: 'heard-nothing' })
      this.mic.clearSilence()
      this.scheduleRetry()
      return
    }
  }
  // A submitted message is waiting for the agent: the microphone stays shut,
  // or it would record the reply through the speakers.
  if (stage === 'thinking') return
  if (stage === 'paused') {
    // An always-on loop does not stay paused: it tries again by itself.
    this.scheduleRetry()
    return
  }
  // Idle on both sides: the user's turn to talk.
  this.arm()
}

/**
 * Keep an always-on loop on: if it is switched on but not listening, try again
 * shortly instead of waiting for the user to toggle the control.
 *
 * A handsfree mode that needs a click to come back is not handsfree. Whatever
 * stopped it — a microphone error, a window that could not be opened, a paused
 * stage — the loop retries by itself for as long as the switch is on.
 */
SpeechController.prototype.scheduleRetry = function () {
  var self = this
  if (this.retryListening !== null) return
  // Back off: a microphone that keeps refusing must not become a five-second
  // retry storm, but it must never stop trying either.
  this.retryCount += 1
  var delay = Math.min(LOOP_RETRY_MS * Math.pow(2, this.retryCount - 1), LOOP_RETRY_MAX_MS)
  this.retryListening = window.setTimeout(function () {
    self.retryListening = null
    if (self.loopEnabled() !== true) return
    var snapshot = self.store.getSnapshot()
    if (snapshot.status === 'speaking') return
    if (self.mic === undefined) return
    var micStatus = self.mic.store.getSnapshot().status
    if (micStatus === 'starting' || micStatus === 'recording' || micStatus === 'transcribing') return
    // Waiting for the agent is not a failure: the reply will re-arm the loop.
    if (snapshot.stage === 'thinking') return
    // Open the microphone again rather than re-running the state machine: an
    // error state would otherwise pause it straight back.
    if (self.mic.retry() === true) {
      self.retryCount = 0
      self.publish({ stage: 'listening', loopNote: null })
      reportEvent({ event: 'voice-loop-retry', mic: micStatus })
      return
    }
    self.scheduleRetry()
  }, delay)
}

/** Open the microphone for the user's turn, unless it is already open. */
SpeechController.prototype.arm = function () {
  var snapshot = this.store.getSnapshot()
  if (snapshot.loop !== true || snapshot.supported !== true) return
  if (this.arming === true) return
  if (this.mic === undefined) {
    this.publish({ stage: 'paused', loopNote: 'no-microphone' })
    return
  }
  if (this.mic.store.getSnapshot().supported !== true) {
    this.publish({ stage: 'paused', loopNote: 'no-microphone' })
    return
  }
  this.arming = true
  var opened = false
  try {
    opened = this.mic.listen() === true
  } finally {
    this.arming = false
  }
  if (opened) {
    this.publish({ stage: 'listening', loopNote: null })
    reportEvent({ event: 'voice-loop-listening', exchanges: snapshot.exchanges })
  }
}

/** Open the announcement stream. EventSource retries a dropped connection itself. */
SpeechController.prototype.open = function () {
  if (this.stream !== null || this.store.getSnapshot().supported !== true) return
  var self = this
  var stream
  try {
    stream = new window.EventSource(EVENTS_ROUTE)
  } catch (error) {
    this.fail(error)
    return
  }
  this.stream = stream
  stream.addEventListener('announce', function (message) { self.receive(message) })
  stream.onopen = function () {
    self.publish({ connected: true })
    reportEvent({ event: 'speech-listening' })
  }
  stream.onerror = function () {
    self.publish({ connected: false })
    // A dropped connection is retried by the browser itself. A refused stream
    // is not: per spec a non-200 answer makes EventSource fail the connection
    // for good. A page that mounted before the host served this route (or in
    // the seconds around a restart) would otherwise stay mute until someone
    // reloaded it by hand, so reopen it here.
    if (stream.readyState !== 2) return
    self.closeStream()
    reportEvent({ event: 'speech-stream-closed' })
    if (self.retry !== null) return
    self.retry = window.setTimeout(function () {
      self.retry = null
      if (self.enabled()) self.open()
    }, STREAM_RETRY_MS)
  }
}

/** Close the announcement stream, if one is open. */
SpeechController.prototype.closeStream = function () {
  var stream = this.stream
  this.stream = null
  if (stream === null) return
  try {
    stream.close()
  } catch (error) {
    // Already closed.
  }
}

/** One frame from the host: remember it, then speak it if the switch is on. */
SpeechController.prototype.receive = function (message) {
  var payload
  try {
    payload = JSON.parse(message.data)
  } catch (error) {
    return
  }
  if (payload === null || typeof payload !== 'object' || payload.type !== 'announce') return
  var text = typeof payload.text === 'string' ? payload.text.trim() : ''
  this.publish({ heard: this.store.getSnapshot().heard + 1 })
  reportEvent({
    event: 'announce-received',
    sessionId: payload.sessionId,
    turn: payload.turn,
    reason: payload.reason,
    chars: text.length,
    enabled: this.speaks(),
  })
  if (text.length === 0) {
    // A turn that ended without words (cancelled, failed, or empty): there is
    // nothing to say, but the handsfree loop's wait is over.
    this.syncLoop()
    return
  }
  if (this.speaks() !== true) {
    this.syncLoop()
    return
  }
  this.publish({ stage: this.loopEnabled() === true ? 'speaking' : this.store.getSnapshot().stage })
  this.enqueue(text)
}

/** Queue one announcement for playback, dropping the oldest when full. */
SpeechController.prototype.enqueue = function (text) {
  var dropped = 0
  while (this.queue.length >= MAX_SPEECH_QUEUE) {
    this.queue.shift()
    dropped += 1
  }
  this.queue.push(text)
  this.publish({
    pending: this.queue.length + (this.playing ? 1 : 0),
    dropped: this.store.getSnapshot().dropped + dropped,
  })
  if (this.playing !== true) this.next()
}

/** Speak the next queued announcement, if any. */
SpeechController.prototype.next = function () {
  var text = this.queue.shift()
  if (text === undefined) {
    // Draining the queue must not overwrite a failure report: the control has
    // to keep saying that the last attempt failed until something works.
    this.publish(this.store.getSnapshot().status === 'error' ? { pending: 0 } : { status: 'idle', pending: 0 })
    return
  }
  this.publish({ status: 'speaking', error: null, lastText: text, pending: this.queue.length })
  this.speak(text)
}

/**
 * Synthesise and play one line.
 * @param text - what to say.
 * @param options - optional per-call `{ voice, speed }`, for auditioning one
 * voice from the card without saving it first.
 */
SpeechController.prototype.speak = function (text, options) {
  var self = this
  var body = { text: text }
  if (options !== undefined && typeof options.voice === 'string' && options.voice.length > 0) {
    body.voice = options.voice
  }
  if (options !== undefined && typeof options.speed === 'number') body.speed = options.speed
  this.playing = true
  fetch(SPEAK_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (response) {
    if (response.ok) return response.blob()
    return response.json().then(function (body) {
      throw new Error(body !== null && typeof body === 'object' && typeof body.error === 'string'
        ? body.error
        : 'HTTP ' + response.status)
    }, function () {
      throw new Error('HTTP ' + response.status)
    })
  }).then(function (blob) {
    if (blob.size === 0) throw new Error('the host returned no audio')
    return self.play(blob)
  }).then(function (bytes) {
    self.playing = false
    self.publish({ status: 'idle', error: null, spoken: self.store.getSnapshot().spoken + 1 })
    reportEvent({ event: 'spoke', bytes: bytes, chars: text.length })
    self.next()
    // The reply is over: in loop mode the user's turn starts now.
    self.syncLoop()
  }, function (error) {
    self.playing = false
    // An interrupted announcement is not a failure: the switch that stopped it
    // already published the idle state the user is looking at.
    if (error !== null && typeof error === 'object' && error.name === 'AbortError') {
      self.next()
      self.syncLoop()
      return
    }
    self.fail(error)
    self.next()
    self.syncLoop()
  })
}

/**
 * Play one audio blob, resolving once it has finished.
 * @param blob - the synthesised audio.
 * @returns a promise of the byte count.
 */
SpeechController.prototype.play = function (blob) {
  var self = this
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(blob)
    var audio = new window.Audio(url)
    var settled = false
    var abortable = function () {
      var stopped = new Error('announcement interrupted')
      stopped.name = 'AbortError'
      settle(stopped)
    }
    var settle = function (error) {
      if (settled) return
      settled = true
      audio.onended = null
      audio.onerror = null
      if (self.abort === abortable) self.abort = null
      if (self.audio === audio) {
        self.audio = null
        self.objectURL = null
      }
      try {
        URL.revokeObjectURL(url)
      } catch (ignored) {
        // Already revoked.
      }
      if (error === null) resolve(blob.size)
      else reject(error)
    }
    self.audio = audio
    self.objectURL = url
    self.abort = abortable
    audio.onended = function () { settle(null) }
    audio.onerror = function () { settle(new Error('playback failed')) }
    var started
    try {
      started = audio.play()
    } catch (error) {
      settle(error)
      return
    }
    if (started !== undefined && typeof started.then === 'function') {
      started.then(function () {}, function (error) { settle(error) })
    }
  })
}

/** Stop playback and drop everything queued behind it. */
SpeechController.prototype.stop = function () {
  this.queue = []
  var audio = this.audio
  if (audio !== null) {
    try {
      audio.pause()
    } catch (error) {
      // A paused element is already silent.
    }
  }
  var abort = this.abort
  this.abort = null
  if (abort !== null) abort()
  this.publish({ status: 'idle', pending: 0 })
}

/** Flip the switch. Writable deployments persist it; others keep it in-page. */
SpeechController.prototype.toggle = function () {
  var self = this
  if (this.store.getSnapshot().supported !== true) return
  var next = this.enabled() !== true
  this.override = next
  this.publish({ enabled: next, error: null })
  if (next) this.open()
  else this.stop()
  if (this.scope === undefined) return
  var snapshot = this.scope.getSnapshot()
  if (snapshot.writable !== true || snapshot.mode !== 'host') return
  this.scope.mutate([{ op: 'set', path: ['speakEnabled'], value: next }], snapshot.revision)
    .catch(function (error) {
      self.override = null
      self.publish({ enabled: self.enabled(), error: 'could not save the switch' })
      if (self.enabled() !== true) self.stop()
    })
}

/** Speak one line now, for the card's test button. Appends to the queue. */
SpeechController.prototype.tryVoice = function (text, options) {
  if (this.store.getSnapshot().supported !== true) return
  if (typeof text !== 'string' || text.trim().length === 0) return
  var line = text.trim()
  if (options !== undefined && (typeof options.voice === 'string' || typeof options.speed === 'number')) {
    // An auditioned line must not be confused with an announcement: it carries
    // its own voice through to the endpoint.
    if (this.playing === true) this.queue.push(line)
    else {
      this.publish({ status: 'speaking', error: null, lastText: line, pending: this.queue.length })
      this.playing = true
      this.speak(line, options)
    }
    return
  }
  this.enqueue(line)
}

/** Publish a failure without dropping the switch. */
SpeechController.prototype.fail = function (error) {
  var message = error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error)
  var blocked = error !== null && typeof error === 'object' && error.name === 'NotAllowedError'
  this.publish({ status: 'error', error: blocked ? 'blocked' : message })
  reportEvent({ event: 'speech-failed', error: message, blocked: blocked })
}

/** Close the stream and stop the audio. */
SpeechController.prototype.dispose = function () {
  if (this.offScope !== undefined) {
    this.offScope()
    this.offScope = undefined
  }
  if (this.offMic !== undefined) {
    this.offMic()
    this.offMic = undefined
  }
  if (this.retry !== null) {
    window.clearTimeout(this.retry)
    this.retry = null
  }
  this.input = null
  this.closeStream()
  this.stop()
  this.audio = null
  this.objectURL = null
  this.abort = null
}

SpeechController.prototype.inject = function () {
  var self = this
  return {
    hooks: { speech: this.store },
    toggleSpeech: function () { self.toggle() },
    say: function (text, options) { self.tryVoice(text, options) },
  }
}

/** The handsfree loop's inject face: adds the switch and the session handover. */
SpeechController.prototype.loopInject = function () {
  var self = this
  return {
    hooks: { speech: this.store, mic: this.mic === undefined ? undefined : this.mic.store },
    toggleLoop: function () { self.toggleLoop() },
    attachInput: function (actions) { self.attachInput(actions) },
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
  var loop = props.useSpeech === undefined
    ? undefined
    : props.useSpeech(function (value) { return value === undefined || value === null ? undefined : value.loop })
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
    // In handsfree mode the speech controller submits the transcript itself;
    // pasting it here as well would double it.
    if (loop === true) return
    if (actions === undefined || typeof actions.setDraft !== 'function') return
    var merged = mergeDraft(draft, state.text)
    if (merged !== draft) actions.setDraft(merged)
  }, [state.textSeq, state.text, draft, actions, loop])

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

/**
 * Speaker glyph, in the same 16x16 house style as the microphone. The `on`
 * form carries two sound arcs; the `off` form a slash, so the switch reads at
 * a glance without a text label.
 * @param on - whether announcements are spoken.
 * @param size - square edge in px.
 * @returns the icon element.
 */
function SpeakerGlyph(on, size) {
  return React.createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    'aria-hidden': 'true',
    focusable: 'false',
  },
    // Cone and box.
    React.createElement('path', {
      fill: 'currentColor',
      d: 'M3.1 6.2h1.9L8.2 3.4c.5-.4 1.2-.1 1.2.5v8.2c0 .6-.7.9-1.2.5L5 9.8H3.1c-.4 0-.7-.3-.7-.7V6.9c0-.4.3-.7.7-.7z',
    }),
    on
      ? React.createElement('path', {
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        fill: 'none',
        d: 'M11.3 6.1c.9 1.1.9 2.7 0 3.8M13.1 4.3c1.8 2.1 1.8 5.3 0 7.4',
      })
      : React.createElement('path', {
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        fill: 'none',
        d: 'M11.1 5.3l4 5.4M15.1 5.3l-4 5.4',
      }),
  )
}

/**
 * The announcement control's box: quiet while announcements are off, tinted
 * while one is playing.
 * @param state - enabled / speaking / failed / hovered / supported.
 * @returns the button style.
 */
function speakerStyle(state) {
  var failed = state.failed === true
  var muted = state.enabled !== true
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '5px',
    minWidth: '32px',
    minHeight: '32px',
    padding: '0 6px',
    border: `1px solid ${failed ? '#e5484d' : 'var(--dsw-color-border, #d0d5dd)'}`,
    background: failed
      ? 'rgba(229, 72, 77, 0.10)'
      : state.speaking === true
        ? 'rgba(64, 132, 214, 0.16)'
        : state.hovered === true ? 'var(--dsw-color-surface-hover, rgba(127, 127, 127, 0.12))' : 'transparent',
    color: failed ? '#e5484d' : 'inherit',
    borderRadius: '8px',
    fontSize: '12px',
    lineHeight: 1,
    opacity: muted && state.supported === true ? 0.55 : 1,
    cursor: state.supported === true ? 'pointer' : 'default',
  }
}

/**
 * Composer control for spoken announcements: click to switch the host's
 * announcements on or off. Turning them off silences whatever is playing, which
 * is also the manual way to interrupt one.
 * @param props - composed slot props.
 * @returns the control element.
 */
function SpeakerButton(props) {
  var t = props.t
  var state = props.useSpeech(function (value) { return value })
  var reported = React.useRef(false)

  React.useEffect(function () {
    if (reported.current) return
    reported.current = true
    reportEvent({
      event: 'speech-rendered',
      slot: 'conversation.input.left',
      supported: state.supported === true,
      enabled: state.enabled === true,
    })
  }, [])

  var supported = state.supported === true
  var on = state.enabled === true
  var speaking = state.status === 'speaking'
  var failed = state.status === 'error'
  var label = !supported
    ? t('speakUnsupported')
    : failed
      ? `${t('speakError')}: ${state.error === 'blocked' ? t('speakBlocked') : state.error}`
      : on
        ? `${t('speakToggleOff')} · ${t(speaking ? 'speakSaying' : 'speakListening')}`
        : t('speakToggleOn')

  var hoverPair = React.useState(false)
  var hovered = hoverPair[0]
  var setHovered = hoverPair[1]

  return React.createElement('button', {
    type: 'button',
    title: label,
    'aria-label': label,
    'aria-pressed': on,
    disabled: !supported,
    style: speakerStyle({ enabled: on, speaking: speaking, failed: failed, hovered: hovered, supported: supported }),
    onMouseEnter: function () { setHovered(true) },
    onMouseLeave: function () { setHovered(false) },
    onFocus: function () { setHovered(true) },
    onBlur: function () { setHovered(false) },
    onClick: function () { props.toggleSpeech() },
  },
    SpeakerGlyph(on, 18),
    speaking === true && state.pending > 1
      ? React.createElement('span', { style: { fontVariantNumeric: 'tabular-nums' } }, String(state.pending))
      : null,
  )
}

/**
 * Speech-bubble glyph for the handsfree control: a bubble with sound bars, or
 * the same bubble struck through when the loop is off.
 * @param on - whether the conversation loop is running.
 * @param size - square edge in px.
 * @returns the icon element.
 */
function VoiceGlyph(on, size) {
  var bars = on
    ? [React.createElement('rect', { key: 'a', x: 5.1, y: 6.6, width: 1.3, height: 3.2, rx: 0.65, fill: 'currentColor' }),
      React.createElement('rect', { key: 'b', x: 7.4, y: 5.2, width: 1.3, height: 6, rx: 0.65, fill: 'currentColor' }),
      React.createElement('rect', { key: 'c', x: 9.7, y: 6.6, width: 1.3, height: 3.2, rx: 0.65, fill: 'currentColor' })]
    : [React.createElement('path', {
      key: 'slash',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      fill: 'none',
      d: 'M3.4 3.4l9.2 9.2',
    })]
  return React.createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    'aria-hidden': 'true',
    focusable: 'false',
  },
    React.createElement('path', {
      stroke: 'currentColor',
      strokeWidth: 1.3,
      strokeLinejoin: 'round',
      fill: 'none',
      // A rounded bubble with a tail: the house style is outline-only icons.
      d: 'M2.4 4.6c0-.9.7-1.6 1.6-1.6h8c.9 0 1.6.7 1.6 1.6v5c0 .9-.7 1.6-1.6 1.6H7.1L4 13.4v-2.2h-.1c-.8 0-1.5-.7-1.5-1.6z',
    }),
    bars,
  )
}

/**
 * The handsfree control's box: quiet when off, tinted while the loop is
 * listening, and accent-tinted while a reply is being spoken.
 * @param state - loop / stage / failed / hovered / supported.
 * @returns the button style.
 */
function voiceStyle(state) {
  var failed = state.failed === true
  var on = state.loop === true
  var listening = state.stage === 'listening'
  var thinking = state.stage === 'thinking'
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '5px',
    minWidth: '32px',
    minHeight: '32px',
    padding: '0 6px',
    border: `1px solid ${failed ? '#e5484d' : on ? '#e5484d' : 'var(--dsw-color-border, #d0d5dd)'}`,
    background: failed
      ? 'rgba(229, 72, 77, 0.10)'
      : listening
        ? 'rgba(229, 72, 77, 0.12)'
        : thinking
          ? 'rgba(64, 132, 214, 0.16)'
          : on
            ? 'rgba(64, 132, 214, 0.10)'
            : state.hovered === true ? 'var(--dsw-color-surface-hover, rgba(127, 127, 127, 0.12))' : 'transparent',
    color: failed || listening ? '#e5484d' : 'inherit',
    borderRadius: '8px',
    fontSize: '12px',
    lineHeight: 1,
    cursor: state.supported === true ? 'pointer' : 'default',
    opacity: state.supported === true ? 1 : 0.5,
  }
}

/**
 * The handsfree conversation control: one click starts the exchange, one click
 * ends it. While it runs it also hands this session's composer to the speech
 * controller, which is what lets a spoken transcript be submitted without the
 * user touching the keyboard.
 * @param props - composed slot props.
 * @returns the control element.
 */
function VoiceButton(props) {
  var t = props.t
  var state = props.useSpeech(function (value) { return value })
  var inputActions = props.inputActions
  var sessionId = props.session !== undefined && props.session !== null ? props.session.sessionId : undefined
  var reported = React.useRef(false)

  React.useEffect(function () {
    if (reported.current) return
    reported.current = true
    reportEvent({
      event: 'voice-control-rendered',
      slot: 'conversation.input.left',
      supported: state.supported === true,
      sessionId: sessionId,
    })
  }, [])

  // The session handover. A stable action face means this runs once per session.
  React.useEffect(function () {
    if (typeof props.attachInput !== 'function') return undefined
    if (inputActions === undefined) {
      props.attachInput(null)
      return undefined
    }
    props.attachInput({
      setDraft: function (text) { inputActions.setDraft(text) },
      submit: function () { inputActions.submit() },
      sessionId: sessionId,
    })
    return function () { props.attachInput(null) }
  }, [inputActions, sessionId])

  var loop = state.loop === true
  var stage = state.stage === undefined ? 'off' : state.stage
  var label = state.supported !== true
    ? t('speakUnsupported')
    : !loop
      ? t('voiceStart')
      : stage === 'listening'
        ? `${t('voiceStop')} · ${t('voiceListening')}`
        : stage === 'thinking'
          ? `${t('voiceStop')} · ${t('voiceThinking')}`
          : stage === 'speaking'
            ? `${t('voiceStop')} · ${t('voiceSpeaking')}`
            : `${t('voiceStart')} · ${t(state.loopNote === 'heard-nothing' ? 'voiceHeardNothing' : 'voicePaused')}`

  var hoverPair = React.useState(false)
  var hovered = hoverPair[0]
  var setHovered = hoverPair[1]

  return React.createElement('button', {
    type: 'button',
    title: label,
    'aria-label': label,
    'aria-pressed': loop,
    disabled: state.supported !== true,
    style: voiceStyle({
      loop: loop, stage: stage, failed: state.status === 'error', hovered: hovered, supported: state.supported === true,
    }),
    onMouseEnter: function () { setHovered(true) },
    onMouseLeave: function () { setHovered(false) },
    onFocus: function () { setHovered(true) },
    onBlur: function () { setHovered(false) },
    onClick: function () { props.toggleLoop() },
  },
    VoiceGlyph(loop, 18),
    state.exchanges > 0
      ? React.createElement('span', { style: { fontVariantNumeric: 'tabular-nums' } }, String(state.exchanges))
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

  // The microphone is built first: the speech controller drives it in handsfree
  // loop mode, and the card shows both their states.
  var mic = new MicController(ctx)
  ctx.effect(function () { return function () { mic.dispose() } }, 'dsh-minimax-asr: microphone controller')

  // Spoken announcements: the host pushes finished turns, this half plays them.
  var speech = new SpeechController(ctx, mic)
  ctx.effect(function () { return function () { speech.dispose() } }, 'dsh-minimax-asr: speech controller')

  var controller = new CardController(ctx, speech)
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
  ctx.slots.inject('conversation.input.left', function () {
    reportEvent({ event: 'mic-registered', slot: 'conversation.input.left' })
    return ctx.slots.register({
      name: 'conversation.input.left',
      id: 'minimax-asr-mic',
      order: 50,
      locale: NS,
      inject: function () { return mic.inject(speech) },
    }, MicButton)
  })

  // The announcement switch sits next to the microphone, at the end of the row.
  ctx.slots.inject('conversation.input.left', function () {
    reportEvent({ event: 'speaker-registered', slot: 'conversation.input.left' })
    return ctx.slots.register({
      name: 'conversation.input.left',
      id: 'minimax-asr-speaker',
      order: 51,
      locale: NS,
      inject: function () { return speech.inject() },
    }, SpeakerButton)
  })

  // The handsfree conversation switch, last in the row. It is the entry that
  // hands the session's composer over to the loop.
  ctx.slots.inject('conversation.input.left', function () {
    reportEvent({ event: 'voice-registered', slot: 'conversation.input.left' })
    return ctx.slots.register({
      name: 'conversation.input.left',
      id: 'minimax-asr-voice',
      order: 52,
      locale: NS,
      inject: function () { return speech.loopInject() },
    }, VoiceButton)
  })
}

exports.name = 'dsh-minimax-asr'
exports.inject = inject
exports.apply = apply
return module.exports; } });
