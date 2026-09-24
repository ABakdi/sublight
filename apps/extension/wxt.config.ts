import { defineConfig } from 'wxt'

/** Extension config (Spec 09 §1-§2). MV3, Chromium-first (ADR-0003). */
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'sublight',
    description: 'Local AI subtitles for any video',
    permissions: ['storage', 'tabCapture', 'activeTab', 'scripting'],
    host_permissions: ['http://127.0.0.1:17421/*', 'http://localhost:17421/*'],
    action: { default_title: 'sublight' },
  },
})
