# Changelog

All notable changes to this plugin. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.3] — standby listening looks like waiting, and buffers like it too

Asked from real use: the loop is always listening, so is it always recording —
and does sitting there cost anything?

It costs nothing. A window that holds no speech is never uploaded, so the
recogniser is never called and no tokens are spent; the audio stays in the
browser and is discarded. What it did cost was reassurance, and that was a real
defect.

### Changed

- **The control no longer looks like a runaway recorder.** While the loop is open
  and has heard nothing worth transcribing it stays quiet — no red pill, no
  clock ticking up for minutes — and its tooltip says what is actually happening
  (`正在等你说话（没说话就不会发送）`). Real speech switches it back to the
  recording indicator immediately.
- **Standby windows stop buffering room noise for five minutes at a time.** A
  window with nothing in it cannot be transcribed, so it is discarded every
  twenty seconds and a fresh one opens on the same stream. The memory a long
  listen costs is bounded by twenty seconds of audio instead of the recording
  cap; a window that does hold speech still runs to the cap and is sent.

### Verified on the live deployment

A real utterance, from the host's own diagnostics: the level peaked at 0.1768
against a room floor of 0.0003 — the speech bar is 0.03, so 200x above the noise
and 6x above the bar — producing 23 speech frames, then a 20-character
transcript submitted five seconds after the speaker stopped (the configured
pause). The same trace shows a standby window discarded after twenty seconds
with two stray frames and **no upload at all**.

## [0.2.2] — an always-on loop, and a pause you own

Reported from real use: after a reply the loop stopped listening after a while
and only a toggle brought it back, and the pause before sending was so short
that a sentence went out half-finished.

### Fixed

- **The loop went deaf after the first window, silently.** Every handsfree
  window built its own `AudioContext`, and Chrome starts a context created
  outside a user gesture *suspended* — an analyser on it reports zero for every
  frame. The first window worked because a click had just happened; every window
  opened afterwards by the timer was deaf: the microphone looked open, the level
  never moved, nothing was transcribed, and the only way back was another click.
  The microphone controller now creates **one** context and reuses it, resuming
  it when suspended, and reports its state to the diagnostics route so a context
  that never started is visible from outside the browser.
- **A paused loop now retries by itself.** While the switch is on and the loop is
  not listening, it tries again every five seconds, dropping whatever the
  previous attempt failed with and opening the microphone again — including after
  a microphone error. A handsfree mode that needs a click to come back is not
  handsfree.

### Added

- `voiceSilenceSeconds` (default **5**, range 1–60): how long a pause means the
  sentence is finished. The old fixed 1.2 s sent messages while the user was
  still working out what to say; 3–15 seconds is the useful range in practice.
- `voiceMaxTurnSeconds` (default **300**, range 10–600): the longest single
  spoken turn before it is sent anyway, for a window that never goes quiet. It
  was a fixed 60 s, which cut a slow speaker off mid-sentence.

Both are on the settings card, and both take effect on the next window.

### Changed

- The shipped `speakMaxChars` is 80, as the schema has said since 0.2.0; the
  bundle patch still carried the old 220, which overrode it.
- The diagnostics ring holds 300 browser reports instead of 50. The microphone
  level is reported once a second while listening, so the old size pushed every
  wiring event out within a minute — exactly when a live session is being
  diagnosed.

### Found in review

- **A full window that contained speech was discarded.** The recording cap rolled
  every handsfree window over. That is right for a window holding nothing but
  room noise, and wrong for one holding a long answer, which was thrown away
  instead of sent. A capped window now sends when it holds real speech and only
  rolls over when it does not.
- **A refused microphone would have retried every five seconds, forever.** The
  self-healing retry backs off now — 5 s doubling to a 60 s ceiling, never
  giving up.

## [0.2.1] — handsfree that survives a pause, and noise that stays noise

Two defects from real use, both in the handsfree loop.

### Fixed

- **A pause no longer ends the conversation.** The loop released the microphone
  after thirty seconds without speech, so a reply would arrive, the microphone
  would close, and anything said a moment later went nowhere. A handsfree window
  is now disposable: when it fills up — at the recording cap, or after a blip too
  short to be a sentence — it is rolled over on the still-open stream, the bytes
  are discarded, and a fresh recorder starts. The microphone indicator never
  drops, and a manual recording still stops at the cap as before. The thirty
  seconds became a thirty-minute safety net for the case where the user walked
  away and left the loop on.
- **Room noise is never transcribed.** Anything louder than the room counted as
  speech, so a creak or a keypress was uploaded, and the recogniser answered the
  near-silence with an invented sentence — which the loop then submitted as the
  user's own words (twelve times, on the machine this was found on). A window now
  has to *look like speech*: frames are measured against an absolute speech level
  rather than only against the room, and at least 600 ms of them must be speech
  before the window is worth transcribing. Anything shorter is dropped without
  reaching the endpoint. The gate's absolute floor also rose from 0.0025 to
  0.008, above the room levels that machine reports (0.0003–0.005) instead of
  below them.

### Notes

- Both cases are regression-tested: thirty seconds of room noise uploads nothing
  and produces zero speech frames, a 400 ms blip sends nothing, and a silent
  window rolls over while the microphone stays open.
- `tests/client-smoke.mjs` also stopped leaking timers — its fake
  `clearInterval` was a no-op, so VAD timers from earlier windows kept mutating
  later ones.

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

[0.2.3]: https://github.com/moluyao/dsh-minimax-asr/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/moluyao/dsh-minimax-asr/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/moluyao/dsh-minimax-asr/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/moluyao/dsh-minimax-asr/compare/533a699...v0.2.0
[0.1.0]: https://github.com/moluyao/dsh-minimax-asr/commit/533a699

