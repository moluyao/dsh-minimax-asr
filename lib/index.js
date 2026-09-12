/**
 * MiniMax speech-to-text as a global Harness plugin.
 *
 * Registers the model-facing `transcribe_audio` tool, which uploads one local
 * audio file to MiniMax's `POST /v1/speech_to_text` (multipart, `model=asr-1.0`)
 * and returns the transcript. The endpoint, model, defaults, and the credential
 * reference are owned by the `minimax-asr` settings namespace, so a user edit in
 * Settings -> Plugins reaches the next transcription without a restart.
 *
 * @module dsh-minimax-asr
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'minimax-asr'

/** The tool registry this plugin contributes to. */
export const inject = ['tools']

/** Settings namespace owning the user-editable subset of {@link Config}. */
export const MINIMAX_ASR_SETTINGS_NAMESPACE = 'minimax-asr'

/** Credential reference resolved for each request unless the section names another. */
const DEFAULT_API_KEY_ENV = 'MINIMAX_API_KEY'

/** MiniMax serves the ASR endpoint on this base; the docs' `.cn` site names the same host. */
const DEFAULT_BASE_URL = 'https://api.minimaxi.com'

/** The only model the endpoint accepts today. */
const DEFAULT_MODEL = 'asr-1.0'

/** Serialized error bodies longer than this are truncated before they reach the model. */
const MAX_ERROR_CHARS = 600

/** Audio extensions MiniMax documents as supported (`webm` is NOT one of them). */
const SUPPORTED_EXTENSIONS = new Map([
  ['.wav', 'audio/wav'],
  ['.aiff', 'audio/aiff'],
  ['.aif', 'audio/aiff'],
  ['.flac', 'audio/flac'],
  ['.m4a', 'audio/mp4'],
  ['.alac', 'audio/mp4'],
  ['.mp3', 'audio/mpeg'],
  ['.aac', 'audio/aac'],
  ['.opus', 'audio/opus'],
  ['.ogg', 'audio/ogg'],
])

/** Response formats the endpoint serves as JSON. */
const JSON_FORMATS = new Set(['json', 'verbose_json'])

/** Response formats the endpoint serves as plain text. */
const TEXT_FORMATS = new Set(['srt', 'vtt'])

/** Timestamp granularities accepted with a timestamp-bearing response format. */
const TIMESTAMP_LEVELS = new Set(['sentence', 'word'])

/**
 * Plugin configuration. Every field is optional at the composition layer: the
 * schema carries the defaults, so the settings namespace resolves a complete
 * section even when the loader entry declares nothing.
 */
export const Config = z.object({
  /** Literal API key; prefer {@link Config.apiKeyEnv} so no secret enters a config file. */
  apiKey: z.string().role('secret'),
  /** Credential reference resolved per request. */
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  /** Endpoint base; `/v1/speech_to_text` is appended. */
  baseURL: z.string().default(DEFAULT_BASE_URL),
  /** Model version sent as the `model` form field. */
  model: z.string().default(DEFAULT_MODEL),
  /** Default `response_format` when a call does not name one. */
  responseFormat: z.string().default('json'),
  /** Default `language` header (BCP-47); empty means mixed-language recognition. */
  language: z.string().default(''),
  /** Default `timestamp_level` for timestamp-bearing formats; empty means the server default. */
  timestampLevel: z.string().default(''),
  /** Refuse an input file larger than this; MiniMax rejects bodies over 50 MB. */
  maxFileMB: z.number().step(1).min(1).default(50),
  /** Per-request budget in milliseconds. */
  timeoutMs: z.number().step(1).min(1000).default(180000),
})

/**
 * Apply composition-layer defaults to a raw loader entry, for the deployment
 * that composes no settings provider and therefore resolves no section.
 * @param entry - the loader entry config, possibly partial or absent.
 * @returns a complete configuration.
 */
function normalizeConfig(entry) {
  const raw = entry ?? {}
  return {
    apiKey: raw.apiKey,
    apiKeyEnv: raw.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    baseURL: raw.baseURL ?? DEFAULT_BASE_URL,
    model: raw.model ?? DEFAULT_MODEL,
    responseFormat: raw.responseFormat ?? 'json',
    language: raw.language ?? '',
    timestampLevel: raw.timestampLevel ?? '',
    maxFileMB: raw.maxFileMB ?? 50,
    timeoutMs: raw.timeoutMs ?? 180000,
  }
}

/**
 * Resolve the API key for one request: a literal from the section wins, then
 * the credential seam, then the ambient process environment. The seam is read
 * per request, so a rotated key reaches the next call without a restart.
 * @param ctx - plugin context supplying the credential seam.
 * @param config - the currently authoritative section.
 * @returns the key, or undefined while nothing supplies one.
 */
async function resolveApiKey(ctx, config) {
  if (typeof config.apiKey === 'string' && config.apiKey.length > 0) return config.apiKey
  let ref
  try {
    ref = credentialRef(config.apiKeyEnv)
  } catch {
    throw new Error(`minimax-asr: apiKeyEnv ${JSON.stringify(config.apiKeyEnv)} is not an environment-variable name`)
  }
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const resolved = await credentials.resolve(ref)
    if (resolved !== undefined && resolved.value.length > 0) return resolved.value
  }
  const ambient = process.env[ref]
  return ambient !== undefined && ambient.length > 0 ? ambient : undefined
}

/** Truncate a serialized error body for the model-facing message. */
function clip(text) {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  return collapsed.length > MAX_ERROR_CHARS ? `${collapsed.slice(0, MAX_ERROR_CHARS)}...` : collapsed
}

/**
 * Extract the endpoint's own diagnostic from an error body — the OpenAI-style
 * `{ error: { message } }` this API returns, or the raw body when it is not.
 * @param body - the decoded response body.
 * @returns a one-line, bounded message.
 */
function describeFailure(body) {
  try {
    const payload = JSON.parse(body)
    const message = payload?.error?.message
    if (typeof message === 'string' && message.length > 0) return clip(message)
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return clip(body)
}

/** The endpoint base with the ASR path appended, tolerating a trailing slash. */
function endpointFor(baseURL) {
  return `${baseURL.replace(/\/+$/u, '')}/v1/speech_to_text`
}

/**
 * Combine the caller's cancellation with this plugin's own request budget.
 * @param signal - the tool call's signal.
 * @param timeoutMs - the configured budget.
 * @returns a signal aborting on either.
 */
function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (signal === undefined) return timeout
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal
}

/**
 * One transcript as the tool's canonical value, rendered for the model.
 * @param value - the canonical tool value.
 * @returns the model-facing text blocks.
 */
function renderTranscript(value) {
  const heading = value.durationSeconds === undefined
    ? `Transcribed ${value.path} with ${value.model} (${value.format}).`
    : `Transcribed ${value.path} with ${value.model} (${value.format}, ${value.durationSeconds}s of audio).`
  const body = value.text.trim().length > 0
    ? value.text
    : '(no speech detected in this audio)'
  const speakers = value.speakers === undefined ? '' : `\nDetected ${value.speakers} speaker(s).`
  return [{ type: 'text', text: `${heading}${speakers}\n\n${body}` }]
}

/**
 * One MiniMax transcription over already-read audio bytes, shared by the
 * model-facing tool and the browser voice-input route.
 * @param ctx - plugin context supplying the credential seam.
 * @param config - the currently authoritative section.
 * @param input - audio bytes, the filename/media type the endpoint infers the format from, and per-call options.
 * @returns the endpoint's answer as the tool's canonical value (without `path`).
 */
async function requestTranscription(ctx, config, input) {
  const apiKey = await resolveApiKey(ctx, config)
  if (apiKey === undefined) {
    throw new Error(
      `No MiniMax API key: store one under the ${config.apiKeyEnv} credential reference `
      + '(Settings -> Plugins -> MiniMax ASR) or export it in the environment',
    )
  }

  const form = new FormData()
  form.set('model', config.model)
  form.set('response_format', input.format)
  if (input.level !== '') form.set('timestamp_level', input.level)
  form.set('stream', 'false')
  form.set('file', new Blob([input.data], { type: input.mediaType }), input.filename)

  const headers = { Authorization: `Bearer ${apiKey}` }
  if (input.language !== '') headers.language = input.language

  const response = await fetch(endpointFor(config.baseURL), {
    method: 'POST',
    headers,
    body: form,
    signal: requestSignal(input.signal, config.timeoutMs),
  })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`MiniMax ASR failed (HTTP ${response.status}): ${describeFailure(body)}`)
  }

  if (TEXT_FORMATS.has(input.format)) {
    return { text: body, format: input.format, model: config.model }
  }

  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    throw new Error(`MiniMax ASR returned a body that is not JSON: ${clip(body)}`)
  }
  // The endpoint answers errors with the real HTTP status, but a proxy in
  // front of it may not: refuse an error body that arrived as 200.
  if (payload?.error !== undefined) {
    throw new Error(`MiniMax ASR failed: ${describeFailure(payload === undefined ? body : JSON.stringify(payload))}`)
  }

  const value = {
    text: typeof payload?.text === 'string' ? payload.text : '',
    format: input.format,
    model: config.model,
  }
  if (typeof payload?.duration === 'number') value.durationSeconds = payload.duration
  if (typeof payload?.n_speakers === 'number') value.speakers = payload.n_speakers
  if (typeof payload?.trace_id === 'string') value.traceId = payload.trace_id
  if (Array.isArray(payload?.segments)) {
    value.segments = payload.segments.map(segment => ({
      start: Number(segment?.start ?? 0),
      end: Number(segment?.end ?? 0),
      text: String(segment?.text ?? ''),
      ...typeof segment?.speaker === 'string' ? { speaker: segment.speaker } : {},
    }))
  }
  return value
}

/** Local route the browser voice input posts one recording to. */
export const TRANSCRIBE_ROUTE = '/minimax-asr/transcribe'

/** Local route the browser half reports its own wiring to. */
export const DIAGNOSTICS_ROUTE = '/minimax-asr/diagnostics'

/** Every route this plugin owns shares one fenced prefix. */
const ROUTE_PREFIX = '/minimax-asr'

/** Bounded, in-memory log of what the browser half reported, newest last. */
const clientEvents = []

/** How many browser reports are retained. */
const MAX_CLIENT_EVENTS = 50

/**
 * Record one browser-half report. In memory only, bounded, and carrying no
 * secret: it exists so a deployment can answer "did the browser half load, and
 * which slots did it register into?" without a browser console.
 * @param event - the reported facts.
 */
function recordClientEvent(event) {
  clientEvents.push({ at: new Date().toISOString(), ...event })
  if (clientEvents.length > MAX_CLIENT_EVENTS) clientEvents.splice(0, clientEvents.length - MAX_CLIENT_EVENTS)
}

/** Whether a Host-header hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/**
 * Browser-trust fence for the voice-input route: a loopback Host with no
 * cross-site marker and a matching Origin. This is a DNS-rebinding and
 * cross-site defense — the same posture the shipped `/api` gateway and the
 * installed `dsh-better-sidebar` plugin use — not authentication: the route
 * spends the configured MiniMax key and touches nothing else.
 * @param req - the node HTTP request.
 * @returns whether the request may reach the route.
 */
function isTrustedRouteRequest(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/** Write one JSON answer and end the response. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Collect a request body, refusing one that exceeds `limit`.
 * @param req - the node HTTP request.
 * @param limit - maximum body bytes.
 * @returns the body bytes.
 */
function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`recording exceeds the ${Math.round(limit / 1024 / 1024)} MB limit`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** A browser-supplied filename reduced to one safe basename, or the default. */
function safeRecordingName(candidate) {
  const fallback = 'voice-input.wav'
  if (typeof candidate !== 'string' || candidate.length === 0) return fallback
  const base = candidate.replace(/[\\/]+/gu, '/').split('/').pop() ?? fallback
  const cleaned = base.replace(/[^A-Za-z0-9._-]/gu, '')
  return cleaned.length === 0 || !/^[A-Za-z0-9._-]+$/u.test(cleaned) ? fallback : cleaned
}

/** Response format for one route call: the query value, else the section default. */
function readRouteFormat(value, fallback) {
  const candidate = typeof value === 'string' && value.length > 0 ? value : fallback
  if (!JSON_FORMATS.has(candidate) && !TEXT_FORMATS.has(candidate)) {
    throw new Error(`unsupported response_format ${JSON.stringify(candidate)}`)
  }
  return candidate
}

/** Timestamp granularity for one route call: the query value, else the section default. */
function readRouteLevel(value, fallback) {
  const candidate = typeof value === 'string' && value.length > 0 ? value : fallback
  if (candidate !== '' && !TIMESTAMP_LEVELS.has(candidate)) {
    throw new Error(`unsupported timestamp_level ${JSON.stringify(candidate)}`)
  }
  return candidate
}

/**
 * Serve one request on the plugin's route prefix.
 * @param ctx - plugin context.
 * @param configSource - thunk returning the currently authoritative section.
 * @param req - the node HTTP request.
 * @param res - the node HTTP response.
 */
async function handlePluginRoute(ctx, configSource, req, res) {
  let url
  try {
    url = new URL(req.url ?? ROUTE_PREFIX, 'http://dsh.invalid')
  } catch {
    sendJson(res, 400, { ok: false, error: 'malformed request URL' })
    return
  }
  if (url.pathname === DIAGNOSTICS_ROUTE) {
    if (!isTrustedRouteRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'loopback same-origin requests only' })
      return
    }
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, events: [...clientEvents] })
      return
    }
    if (req.method === 'POST') {
      let body
      try {
        body = await readRequestBody(req, 16 * 1024)
      } catch (error) {
        sendJson(res, 413, { ok: false, error: error.message })
        return
      }
      try {
        const reported = JSON.parse(body.toString('utf8'))
        if (reported === null || typeof reported !== 'object' || typeof reported.event !== 'string') {
          sendJson(res, 400, { ok: false, error: 'expected an object with an "event" string' })
          return
        }
        recordClientEvent(reported)
        sendJson(res, 200, { ok: true })
      } catch {
        sendJson(res, 400, { ok: false, error: 'body is not JSON' })
      }
      return
    }
    sendJson(res, 405, { ok: false, error: 'use GET or POST' })
    return
  }
  if (url.pathname === TRANSCRIBE_ROUTE) {
    await handleTranscribeRoute(ctx, configSource, req, res)
    return
  }
  sendJson(res, 404, { ok: false, error: `unknown ${ROUTE_PREFIX} route` })
}

/**
 * Serve one browser voice-input recording: validate the fence and the body,
 * then transcribe through the same path the tool uses.
 * @param ctx - plugin context.
 * @param configSource - thunk returning the currently authoritative section.
 * @param req - the node HTTP request.
 * @param res - the node HTTP response.
 */
async function handleTranscribeRoute(ctx, configSource, req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'use POST' })
    return
  }
  if (!isTrustedRouteRequest(req)) {
    sendJson(res, 403, { ok: false, error: 'loopback same-origin requests only' })
    return
  }

  const config = configSource()
  const limit = config.maxFileMB * 1024 * 1024
  const declared = Number(req.headers['content-length'] ?? Number.NaN)
  if (Number.isFinite(declared) && declared > limit) {
    sendJson(res, 413, { ok: false, error: `recording exceeds the ${config.maxFileMB} MB limit` })
    return
  }

  let data
  try {
    data = await readRequestBody(req, limit)
  } catch (error) {
    sendJson(res, 413, { ok: false, error: error.message })
    return
  }
  if (data.length === 0) {
    sendJson(res, 400, { ok: false, error: 'empty recording' })
    return
  }

  let url
  try {
    url = new URL(req.url ?? TRANSCRIBE_ROUTE, 'http://dsh.invalid')
  } catch {
    sendJson(res, 400, { ok: false, error: 'malformed request URL' })
    return
  }

  try {
    const filename = safeRecordingName(url.searchParams.get('name'))
    const extension = extname(filename).toLowerCase()
    const value = await requestTranscription(ctx, config, {
      data,
      filename,
      mediaType: SUPPORTED_EXTENSIONS.get(extension) ?? 'audio/wav',
      format: readRouteFormat(url.searchParams.get('format'), config.responseFormat),
      level: readRouteLevel(url.searchParams.get('level'), config.timestampLevel),
      language: (url.searchParams.get('language') ?? config.language ?? '').trim(),
      signal: undefined,
    })
    sendJson(res, 200, { ok: true, ...value })
  } catch (error) {
    sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Register the `transcribe_audio` tool, this plugin's settings namespace, and
 * the local voice-input route.
 * @param ctx - the plugin context.
 * @param entry - the loader entry configuration.
 */
export function apply(ctx, entry) {
  // Without a settings provider the entry itself is the whole configuration.
  let source = () => normalizeConfig(entry)
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, MINIMAX_ASR_SETTINGS_NAMESPACE, Config, entry ?? {}, {
      setSource: (current) => {
        source = current
      },
      // Every read below projects the section per call, so a committed change
      // needs no re-registration.
      onChange: () => {},
    })
  })

  // The browser voice input posts one recording here, and the browser half
  // reports its own wiring next door; a deployment without a web server simply
  // has no route (the tool above is unaffected).
  ctx.inject(['webServer'], (webCtx) => {
    ctx.effect(
      () => webCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => handlePluginRoute(ctx, () => source(), req, res),
      }),
      'dsh-minimax-asr: local routes',
    )
  })

  ctx.tools.register(defineTool({
    name: 'transcribe_audio',
    description:
      'Transcribe a local audio file to text with MiniMax speech recognition (model asr-1.0). '
      + 'Returns the transcript, the audio duration, and — for timestamp-bearing response formats — '
      + 'per-segment speakers and times. Accepted formats: wav, aiff, flac, m4a/alac, mp3, aac, opus, ogg '
      + '(no bare PCM, no webm). Limits: at most 500 seconds and 50 MB per file.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Path to a local audio file. Relative paths resolve against the process working directory.',
      },
      language: {
        type: 'string',
        description:
          'Optional BCP-47 hint for the main language of the audio (zh, yue, en, ja, ko, th, vi, id, ms, fil, ar, tr, fr, de, es, it, pt, pl, ru, uk). '
          + 'Omit or leave empty for mixed-language recognition.',
      },
      response_format: {
        type: 'string',
        enum: ['json', 'verbose_json', 'srt', 'vtt'],
        description:
          'json returns text and duration; verbose_json adds speaker-separated timestamped segments; '
          + 'srt and vtt return subtitle text instead.',
      },
      timestamp_level: {
        type: 'string',
        enum: ['sentence', 'word'],
        description:
          'Timestamp granularity for verbose_json/srt/vtt: sentence (default) keeps sentence segments, '
          + 'word returns word-level (character-level for Chinese) units. Ignored for json.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          text: { type: 'string', required: true },
          format: { type: 'string', required: true },
          model: { type: 'string', required: true },
          durationSeconds: { type: 'number' },
          speakers: { type: 'integer' },
          traceId: { type: 'string' },
          segments: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                start: { type: 'number', required: true },
                end: { type: 'number', required: true },
                speaker: { type: 'string' },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => renderTranscript(value),
    },
    // Uploading one file mutates no parent-agent state.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const config = source()
      const path = args.path.trim()
      if (path.length === 0) throw new Error('path must be a non-empty string')

      const format = args.response_format ?? config.responseFormat
      if (!JSON_FORMATS.has(format) && !TEXT_FORMATS.has(format)) {
        throw new Error(`minimax-asr: unsupported response_format ${JSON.stringify(format)}`)
      }
      const level = args.timestamp_level ?? config.timestampLevel
      if (level !== '' && !TIMESTAMP_LEVELS.has(level)) {
        throw new Error(`minimax-asr: unsupported timestamp_level ${JSON.stringify(level)}`)
      }
      const language = (args.language ?? config.language ?? '').trim()

      let info
      try {
        info = await stat(path)
      } catch (error) {
        throw new Error(`Cannot read ${path}: ${error.code ?? error.message}`)
      }
      if (!info.isFile()) throw new Error(`${path} is not a regular file`)

      const extension = extname(path).toLowerCase()
      const mediaType = SUPPORTED_EXTENSIONS.get(extension)
      if (mediaType === undefined) {
        throw new Error(
          `Unsupported audio extension ${extension === '' ? '(none)' : extension} — MiniMax accepts `
          + `${[...SUPPORTED_EXTENSIONS.keys()].join(', ')}; convert the file first (mono 16 kHz mp3 is a safe target)`,
        )
      }

      const limit = config.maxFileMB * 1024 * 1024
      if (info.size > limit) {
        throw new Error(
          `${basename(path)} is ${(info.size / 1024 / 1024).toFixed(1)} MB, above the configured `
          + `${config.maxFileMB} MB limit (MiniMax rejects request bodies over 50 MB)`,
        )
      }

      const data = await readFile(path)
      const value = await requestTranscription(ctx, config, {
        data,
        filename: basename(path),
        mediaType,
        format,
        level,
        language,
        signal: exec.signal,
      })
      return { path, ...value }
    },
  }))
}
