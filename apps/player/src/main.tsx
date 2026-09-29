import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './index.css'
import { resolveTheme, savedTheme } from './lib/theme'

// The saved theme before the first paint, so a light page never flashes dark.
document.documentElement.dataset.theme = resolveTheme(
  savedTheme(),
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches,
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
