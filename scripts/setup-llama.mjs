#!/usr/bin/env node
/**
 * Build the pinned llama.cpp server into ~/.sublight/bin (Spec 06 §7, ADR-0016).
 *
 *   pnpm engine:setup-llama [--cpu] [--jobs N]
 *
 * The translation worker (M04). Compiled from this exact commit; no network
 * features (model downloads go through the engine's pinned manifest only).
 * Writes ~/.sublight/bin/llama.json.
 */
import { buildPinned } from './lib/pinned-build.mjs'

buildPinned({
  name: 'llama',
  repo: 'https://github.com/ggml-org/llama.cpp',
  tag: 'b11174',
  commit: 'ed319febb148d02badf332f4ac499b390acbfece',
  target: 'llama-server',
  cmakeFlags: [
    '-DLLAMA_CURL=OFF',
    '-DLLAMA_BUILD_TESTS=OFF',
    '-DLLAMA_BUILD_EXAMPLES=OFF',
    '-DLLAMA_BUILD_SERVER=ON',
  ],
})
