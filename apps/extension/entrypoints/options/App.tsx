import { useState } from 'react'
import { browser } from 'wxt/browser'
import type { EngineStatus } from '../../src/messages'
import {
  CaptionStyleSettings,
  DeveloperSettings,
  EnginePairing,
  FetchSettings,
  LiveSettings,
  Shortcuts,
  TranslationModel,
} from '../../src/settings'
import { EngineCard, ModelsCard } from '../../src/engineCards'
import { colors } from '../../src/ui'

/**
 * Options (Spec 09 §7): everything the popup's tabs hold, on one full page
 * (M06b.7), with pairing by hand at the end.
 */
export function OptionsApp() {
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const online = status?.state === 'online'
  return (
    <main
      style={{
        maxWidth: 560,
        margin: '40px auto',
        padding: '0 24px',
        fontFamily: 'system-ui, sans-serif',
        color: colors.text,
      }}
    >
      <h1 style={{ fontSize: 20, fontWeight: 650, marginBottom: 4 }}>sublight settings</h1>
      <p style={{ color: colors.muted, fontSize: 13, marginTop: 0 }}>
        Extension ID <code data-testid="extension-id">{browser.runtime.id}</code>
      </p>
      <EngineCard />
      <ModelsCard />
      <LiveSettings online={online} />
      <CaptionStyleSettings />
      <FetchSettings />
      <TranslationModel online={online} />
      <Shortcuts />
      <DeveloperSettings />
      <EnginePairing onStatus={setStatus} />
    </main>
  )
}
