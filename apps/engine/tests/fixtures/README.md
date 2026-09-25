# Engine test fixtures

- `jfk.wav`: 11 s, 16 kHz mono, from John F. Kennedy's 1961 inaugural address
  (public domain), as shipped in `samples/` of whisper.cpp (MIT). Used by
  `asr.integration.test.ts`.

Reference speech onsets for it (ffmpeg `silencedetect=noise=-30dB:d=0.12`),
used to check word timing: speech resumes at 0.33 s ("And"), 3.29 s ("ask"),
4.91 s ("what") and 8.19 s (second "ask").
