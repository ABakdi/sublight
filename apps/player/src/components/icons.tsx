/** The control bar's icons (24×24, currentColor): crisp at any size, no emoji fonts. */
const Svg = ({ d, label }: { d: string; label?: string }) => (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="currentColor"
    aria-hidden={!label}
    role={label ? 'img' : undefined}
  >
    <path d={d} />
  </svg>
)

export const PlayIcon = () => (
  <Svg d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" />
)
export const PauseIcon = () => <Svg d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
export const BackIcon = () => (
  <Svg d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8zm-1.1 11H10v-3.3l-1 .3v-.7l1.8-.6h.1zm4.3-1.8c0 1.2-.8 1.9-1.8 1.9s-1.8-.7-1.8-1.9v-.7c0-1.2.8-1.9 1.8-1.9s1.8.7 1.8 1.9zm-.9-.8c0-.7-.3-1.1-.9-1.1s-.9.4-.9 1.1v.9c0 .7.3 1.1.9 1.1s.9-.4.9-1.1z" />
)
export const ForwardIcon = () => (
  <Svg d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8zm-1.1 11H10v-3.3l-1 .3v-.7l1.8-.6h.1zm4.3-1.8c0 1.2-.8 1.9-1.8 1.9s-1.8-.7-1.8-1.9v-.7c0-1.2.8-1.9 1.8-1.9s1.8.7 1.8 1.9zm-.9-.8c0-.7-.3-1.1-.9-1.1s-.9.4-.9 1.1v.9c0 .7.3 1.1.9 1.1s.9-.4.9-1.1z" />
)
export const VolumeIcon = ({ level }: { level: number }) =>
  level === 0 ? (
    <Svg d="M3 9v6h4l5 5V4L7 9H3zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z" />
  ) : level < 0.5 ? (
    <Svg d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z" />
  ) : (
    <Svg d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z" />
  )
export const PipIcon = () => (
  <Svg d="M19 11h-8v6h8zm4 8V5a2 2 0 0 0-2-2H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2zm-2 0H3V5h18z" />
)
export const FullscreenIcon = () => (
  <Svg d="M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z" />
)
export const HelpIcon = () => (
  <Svg d="M11 18h2v-2h-2zm1-16a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm0-14a4 4 0 0 0-4 4h2a2 2 0 1 1 4 0c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5a4 4 0 0 0-4-4z" />
)
