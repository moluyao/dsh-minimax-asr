# dsh-minimax-asr

MiniMax speech-to-text as a **global** DeepSeek Harness plugin: the model-facing
`transcribe_audio` tool plus a settings card, owned by the settings namespace
`minimax-asr`.

## What it adds

| Surface | Detail |
| --- | --- |
| Tool | `transcribe_audio(path, language?, response_format?, timestamp_level?)` |
| Endpoint | `POST <baseURL>/v1/speech_to_text` (multipart, default `model=asr-1.0`) |
| Credential | reference `MINIMAX_API_KEY` by default, resolved per request through the credentials seam |
| Settings | namespace `minimax-asr`: `apiKeyEnv`, `baseURL`, `model`, `responseFormat`, `language`, `timestampLevel`, `maxFileMB`, `timeoutMs` |
| Card | rendered in Settings → Plugins by `client/client.js` |

Formats MiniMax accepts: `wav`, `aiff`, `flac`, `m4a`/`alac`, `mp3`, `aac`,
`opus`, `ogg`. Not accepted: bare PCM, `webm`. A file may be at most 500 seconds
and 50 MB; MiniMax bills by the returned `duration`.

`response_format` is `json` (text + duration), `verbose_json` (adds
speaker-separated timestamped segments), `srt`, or `vtt`. `timestamp_level` is
`sentence` (default) or `word`; it is ignored for `json`.

## Install (global, profile level)

```sh
# 1. make the package resolvable inside the profile
dsh plugin --profile web add D:\dsh-work\工作区-1\dsh-minimax-asr

# 2. activate it in the profile's patch layer (this is the global composition layer)
#    C:\Users\mi\.dsh\profiles\web\cordis.patch.yml
- insert:
    - id: minimax-asr
      name: 'dsh-minimax-asr'
      config:
        apiKeyEnv: MINIMAX_API_KEY
        baseURL: https://api.minimaxi.com
        model: asr-1.0

# 3. a profile with `patchReload: live` (the shipped `web` profile) picks the row
#    up without a restart; otherwise restart `dsh`.
```

**One activation site only.** `dsh plugin add` also appends the package to
`dsh.profile.bundles` whenever it declares `dsh.bundle`, and a bundle layer
re-inserts `id: minimax-asr`. With the row above present that would mount the
plugin twice (two registrations of one tool name). This profile therefore keeps
`dsh-minimax-asr` as a dependency only. If a later `dsh plugin` invocation
re-adds the bundle row, delete the `insert` row from `cordis.patch.yml`.

The host half (tool + settings namespace) hot-loads with the patch layer, and the
host's client-module registry re-scans on every plugin mount, so both halves
come up live — reload the browser page to pick up the recomposed boot graph.

**A long-running instance needs one restart after a browser-half edit.** The
client bundle's bytes are read and revisioned when the module registry first
activates the package, and a page reload alone keeps serving the old bytes. The
host half has no such constraint: a settings or tool change reaches the next
call without any reload.

## Voice input (browser)

A microphone control sits in the composer tool row, beside the command button:

| Step | What happens |
| --- | --- |
| Click | `getUserMedia` opens the microphone; the control turns red and counts seconds (auto-stops at 120 s) |
| Click again | The recorder stops, the blob is decoded and re-encoded as 16 kHz mono WAV, and POSTed to `/minimax-asr/transcribe` |
| Response | The transcript is appended to whatever the draft already held — once per transcript, never twice |

Chrome records `webm/opus`, which the endpoint does **not** accept, so the
browser half decodes the recording and rebuilds it as WAV before uploading. The
upload is bounded by the same `maxFileMB` the tool uses. A microphone permission
prompt is expected the first time per origin; a refusal surfaces in the control's
tooltip, and the tracks are always released.

## Local routes

Both routes live under one fenced prefix — loopback `Host`, no cross-site marker,
matching `Origin`, the posture the shipped `/api` gateway and the installed
`dsh-better-sidebar` use (a DNS-rebinding/cross-site defense, not authentication):

| Route | Purpose |
| --- | --- |
| `POST /minimax-asr/transcribe` | one recording in (an `audio/wav` body, optional `?format=`, `?level=`, `?language=`, `?name=`), transcript out |
| `GET /minimax-asr/diagnostics` | the browser half's wiring report: `applied`, `card-registered`, `mic-registered`, `mic-rendered` (bounded, in memory, no secrets) |
| `POST /minimax-asr/diagnostics` | how the browser half files those reports |

`GET /minimax-asr/diagnostics` is the fastest way to answer "is the browser half
loaded, and did its controls mount?" on a live deployment.

## Verifying without the harness

```sh
MINIMAX_API_KEY=... node tests/smoke.mjs <audio-file> [response_format] [timestamp_level]
MINIMAX_API_KEY=... node tests/route-smoke.mjs [audio-file]
node tests/client-smoke.mjs
node tests/installed-check.mjs [profile-dir]
```

`tests/smoke.mjs` loads `lib/index.js`, runs `apply` against a stub context, and
executes the registered tool against the live endpoint. `tests/route-smoke.mjs`
drives the registered route with synthetic node requests: every fence and size
refusal, the diagnostics channel, and one real transcription. `tests/client-smoke.mjs`
loads `client/client.js` the way the browser does (a classic script calling
`window.__ModuleLoader__.load`) under a stub React/module table, asserts the card's
render and the exact path ops it writes, and runs the whole microphone pipeline
with only the codec and the network faked — asserting the uploaded WAV's header,
rate, and sample count. `tests/installed-check.mjs` resolves the *installed*
package from the profile and asserts everything the host's client-package scanner
needs (`dsh.client.platform`, `./client` bytes, the bundle id, every declared
inject, the host half's export shape) plus the single-activation-row invariant.

## Verified

- Real transcriptions through `asr-1.0`: `json`, `verbose_json` with word-level
  segments and speakers, and `srt` — through the tool *and* through the local route.
- A fresh child agent inside the running Harness saw `transcribe_audio` in its
  registry and transcribed a file with it.
- The settings card rendered in a real browser on a throwaway profile composed
  from the same bundles: 8 fields resolved from the namespace, the credential
  badge read `已配置`, an edit raised "未保存", and **Save** wrote
  `minimax-asr: / language: zh` into the profile's `settings.yaml`. That run is
  also what caught a real defect — the card read `ctx.remote` while declaring only
  `remote.credentials`, which Cordis rejects ("cannot get property \"remote\"
  without inject").
- The voice control rendered in a real session's composer tool row
  (`aria-label="用 MiniMax 语音识别听写"`, `supported: true`), confirmed both in the
  DOM and by the deployment's own `GET /minimax-asr/diagnostics` report —
  `applied`, `card-registered`, `mic-registered`, `mic-rendered`. It appears once
  a session is bound to a workspace; a workspace-less hero composer does not mount
  that zone.
- The microphone pipeline (record → decode → 16 kHz mono WAV → route → draft) runs
  green in `tests/client-smoke.mjs` with only the codec and the network faked.

Not verified end to end in a browser: an actual spoken recording. Chrome reports
`microphone: prompt` for a fresh origin, and granting that is the user's gesture.

## Notes

The key itself never enters configuration. It is resolved per request through
the credentials seam (reference `MINIMAX_API_KEY` by default), so a value
already stored in `~/.dsh/.credentials.yaml` — or exported in the environment —
is reused with no extra setup:

```sh
MINIMAX_API_KEY=sk-...        # environment, or the credentials store / Settings UI
```

`~/.dsh/.credentials.yaml` resolves the reference as well, so a key already
stored for the MiniMax chat provider is reused with no extra setup.

## Notes

- The plugin runs in the Harness host process and reads the audio file itself, so
  the agent's file sandbox does not gate that read. Point it at a file the host
  can already read.
- A plugin cannot appear in the model/provider picker: MiniMax ASR has no
  chat-completions interface, so it is a tool, not a conversation model.
