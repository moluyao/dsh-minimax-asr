# Changelog

All notable changes to this plugin. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — spoken announcements, handsfree conversation, 303 voices

Everything below is verified by the off-harness test suites
(`tests/smoke.mjs`, `tests/route-smoke.mjs`, `tests/client-smoke.mjs`,
`tests/installed-check.mjs`) and against the live MiniMax API.

### Added

- **Spoken announcements.** The host subscribes to `session/event` and pushes one
  `announce` frame per finished turn over `GET /minimax-asr/events` (SSE); the
  browser synthesises it through `speech-2.8-hd` (`POST /minimax-asr/speak`) and
  plays it. Announcements queue instead of overlapping, and the composer's speaker
  control mutes them — switching it off stops whatever is playing.
- **`announce_speech` tool.** A turn names the sentence the user will *hear*,
  separately from the reply they *read*: one or two spoken sentences, distilled
  rather than truncated. A turn that names no line has only its opening sentence
  spoken; `silent: true` suppresses the announcement for that turn; an
  essay-length line (over 600 characters) is refused with an explanation.
- **Handsfree conversation.** The composer's third control runs the whole loop:
  the microphone reopens by itself once a reply has been read out, the level gate
  ends the turn when the user stops talking, and the transcript is submitted
  without a click. 30 s of silence releases the microphone instead of holding it
  open, and a window with no speech in it is never uploaded.
- **Voice picker.** The card lists the account's own catalogue
  (`POST /v1/get_voice` — 303 system voices), grouped by language (18 headings),
  cached for 10 minutes, with a built-in fallback list and a free-text path for
  cloned voices. **Test the voice** auditions the current selection before saving,
  through optional `voice`/`speed` overrides on `/minimax-asr/speak`.
- **`GET /minimax-asr/voices`** — the catalogue as `{id, name, group}`.
- **Diagnostics** on `GET /minimax-asr/diagnostics`: the announcement-listener
  count plus the browser half's wiring and its measured microphone levels
  (`mic-level`: level, noise floor, gate, loudest) once a second.
- `voiceLoop` setting, and `speakEnabled`, `ttsModel`, `ttsVoice`, `ttsSpeed`,
  `speakMaxChars` alongside the existing transcription settings.

### Changed

- **A spoken line is never the reply.** The old behaviour read the reply out loud
  and appended "there is more, I will skip it" when it ran long. That apology is
  gone from the code: the fallback is now the reply's opening sentence, and an
  over-long line is cut at a sentence boundary with no explanation added.
- `speakMaxChars` default lowered from 220 to 80 — an announcement is measured in
  seconds of audio, not in paragraphs.
- A cancelled or failed turn now publishes a frame with no text, so the handsfree
  loop re-arms instead of waiting forever for a reply that was cancelled.

### Fixed

Three defects that the new tests caught, all of them reachable in a real browser:

- A failed synthesis was immediately masked by the "queue drained" idle write, so
  the control never showed that anything had gone wrong.
- An interrupted playback never settled (`audio.pause()` fires no `ended`), which
  wedged the controller so no later announcement was ever spoken.
- Switching the conversation loop off while the microphone was still opening left
  it recording, because a late `getUserMedia` answer was still honoured.

### Notes

- The voice catalogue is grouped by the voice **id**, not its display name: every
  `voice_name` is Chinese, so grouping by name put all 303 voices under one
  heading.
- Client-half changes need one `dsh` restart, because the browser bundle's bytes
  are revisioned when the module registry first activates the package. A refused
  announcement stream is now reopened by the client itself, so a restart no longer
  needs a manual page reload.

## [0.1.0] — MiniMax speech-to-text as a global DSH plugin

### Added

- `transcribe_audio(path, language?, response_format?, timestamp_level?)` over
  `POST <baseURL>/v1/speech_to_text` (model `asr-1.0`): `json`, `verbose_json`
  with word-level segments and speaker separation, `srt`, and `vtt`.
- `POST /minimax-asr/transcribe` — the browser posts one recording and gets the
  transcript, behind a loopback/same-origin fence.
- Voice input in the composer tool row: record → decode → 16 kHz mono WAV →
  transcribe → append to the draft, with a configurable auto-stop length
  (`maxRecordSeconds`, 10–500 s).
- The `minimax-asr` settings namespace and its card, including the credential
  reference (`MINIMAX_API_KEY` by default) resolved per request through the
  credentials seam.
- `tests/smoke.mjs` and `tests/client-smoke.mjs`, and the single-activation-site
  invariant in `tests/installed-check.mjs`.

[0.2.0]: https://github.com/moluyao/dsh-minimax-asr/compare/533a699...v0.2.0
[0.1.0]: https://github.com/moluyao/dsh-minimax-asr/commit/533a699
