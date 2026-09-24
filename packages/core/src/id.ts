/**
 * ID generation usable in any JS runtime (browser SW, content script,
 * player, Node engine).
 */
export function newId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto && typeof g.crypto.randomUUID === 'function') return g.crypto.randomUUID()
  return `sl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
