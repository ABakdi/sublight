import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { OptionsApp } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
)
