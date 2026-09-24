/** Minimal popup (M00). The real UI — active tab status, caption toggle, open-in-player — lands in M05/M05b. */
export function PopupApp() {
  return (
    <main style={{ width: 260, padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>sublight</h1>
      <p style={{ margin: '8px 0 0', fontSize: 12, color: '#667085', lineHeight: 1.5 }}>
        Local AI subtitles for any video.
      </p>
      <p
        style={{
          margin: '12px 0 0',
          fontSize: 12,
          color: '#344054',
          borderTop: '1px solid #e4e7ec',
          paddingTop: 10,
        }}
      >
        Captioning controls arrive with M05. The engine stays local — nothing leaves your machine.
      </p>
    </main>
  )
}
