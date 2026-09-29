/**
 * Languages offered for captions and translation, common ones first, one
 * list for the Player and the extension (code quality Q-3, Q8). Whisper
 * detects ~100 languages and the translator covers 100+; these are the ones
 * offered in menus.
 */
export const LANGUAGES: [code: string, name: string][] = [
  ['en', 'English'],
  ['de', 'German'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['ru', 'Russian'],
  ['ar', 'Arabic'],
  ['tr', 'Turkish'],
  ['ja', 'Japanese'],
  ['zh', 'Chinese'],
  ['ko', 'Korean'],
  ['hi', 'Hindi'],
  ['pl', 'Polish'],
  ['uk', 'Ukrainian'],
]
