#!/usr/bin/env node
/**
 * Build the pinned whisper.cpp server into ~/.sublight/bin (Spec 06 §6, ADR-0016).
 *
 *   pnpm engine:setup-whisper [--cpu] [--jobs N]
 *
 * whisper.cpp publishes no Linux server binary, so the engine's ASR worker is
 * compiled from this exact commit. Writes ~/.sublight/bin/whisper.json.
 */
import { buildPinned } from './lib/pinned-build.mjs'

buildPinned({
  name: 'whisper',
  repo: 'https://github.com/ggml-org/whisper.cpp',
  tag: 'v1.9.4',
  commit: '927cfce34f31707e17f2bff35c349632fb9e2c3a',
  target: 'whisper-server',
  cmakeFlags: [
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_SERVER=ON',
    '-DWHISPER_BUILD_EXAMPLES=ON',
  ],
})
