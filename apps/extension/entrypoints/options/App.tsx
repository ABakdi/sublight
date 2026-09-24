/** Minimal options page (M00). Engine pairing, defaults and cache controls land here in M06. */
export function OptionsApp() {
  return (
    <main
      style={{
        maxWidth: 560,
        margin: '48px auto',
        padding: '0 24px',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <h1 style={{ fontSize: 20, fontWeight: 600 }}>sublight options</h1>
      <p style={{ color: '#667085', fontSize: 14 }}>
        Engine pairing, model defaults, style presets and cache controls arrive in M06.
      </p>
    </main>
  )
}
