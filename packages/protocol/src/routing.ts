/**
 * Which translator serves a request (Spec 07 §2.0, ADR-0018):
 * - English target with audio and no glossary/register ask → Whisper `translate`
 *   on the resident ASR model (no extra download);
 * - everything else → the LLM translate job (installed on demand).
 */
export type TranslationPath = 'whisper-translate' | 'llm'

export interface TranslationRequest {
  /** BCP-47 target, e.g. "en", "en-GB", "de". */
  targetLang: string
  /** Is the media's audio available to the engine (file, relay, capture)? */
  hasAudio: boolean
  /** Glossary or register control requested — only the LLM honors them. */
  wantsGlossaryOrStyle?: boolean
}

export function isEnglish(lang: string): boolean {
  return /^en(?:-|$)/i.test(lang.trim())
}

export function chooseTranslationPath(req: TranslationRequest): TranslationPath {
  return isEnglish(req.targetLang) && req.hasAudio && !req.wantsGlossaryOrStyle
    ? 'whisper-translate'
    : 'llm'
}
