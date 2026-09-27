import { useEffect, useRef, useState } from 'react'
import { browser } from 'wxt/browser'
import { PAIRING_KEY, type PairingStatus } from './engine'
import { send } from './send'
import { colors, primaryButton } from './ui'

/**
 * "Pair with the engine" (ADR-0022): the service worker asks the engine and
 * opens its approval page; this shows the code to compare, then the outcome.
 */
export function PairButton({ onPaired }: { onPaired: () => void }) {
  const [status, setStatus] = useState<PairingStatus | null>(null)
  // The latest callback, without re-subscribing (callers pass a new one each render).
  const paired = useRef(onPaired)
  paired.current = onPaired
  useEffect(() => {
    // A finished pairing from an earlier visit isn't news: start blank, once.
    void browser.storage.session.remove(PAIRING_KEY)
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'session' || !(PAIRING_KEY in changes)) return
      const next = (changes[PAIRING_KEY]!.newValue as PairingStatus | undefined) ?? null
      setStatus(next)
      if (next?.state === 'paired') paired.current()
    }
    browser.storage.onChanged.addListener(onChanged)
    return () => browser.storage.onChanged.removeListener(onChanged)
  }, [])

  const waiting = status?.state === 'waiting'
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <button
        data-testid="pair-engine"
        style={waiting ? { ...primaryButton, opacity: 0.6 } : primaryButton}
        disabled={waiting}
        onClick={() => void send({ type: 'engine.pair' })}
      >
        Pair with the engine
      </button>
      {status && (
        <div
          data-testid="pair-status"
          data-state={status.state}
          style={{
            fontSize: 12,
            lineHeight: 1.45,
            color:
              status.state === 'paired'
                ? colors.ok
                : status.state === 'waiting'
                  ? colors.text
                  : colors.bad,
          }}
        >
          {status.state === 'waiting' && (
            <>
              Approve in the tab that opened. It shows the code{' '}
              <b style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: 2 }}>
                {status.code}
              </b>
              .
            </>
          )}
          {status.state === 'paired' && 'Paired: sublight can use the engine.'}
          {status.state === 'denied' && 'Pairing was denied on the engine’s page.'}
          {status.state === 'failed' && status.error}
        </div>
      )}
    </div>
  )
}
