import { defineConfig } from 'wxt'

/**
 * Public half of the dev signing key. Chromium derives the extension ID from
 * it, so every unpacked install gets the same ID (DEV_EXTENSION_ID in
 * @sublight/protocol) and the engine can allowlist its origin. Not a secret:
 * the private key is never needed for unpacked loads. Store builds drop it.
 */
const DEV_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsUabSRr2SUtLUHi1IyNPgUZPStvAunHXiet+J2LgRpzlkkHCILFRmAxdO2OpmjTXIhi1TCUEi/yTKwX8usd4Oo6+sR71aSGsbfjY7m52BtmjiWGttBGPQQUHtz7zhBZBK7k0NXMRfQyev0+Zl9N6uuI0OjR8o1yS2AlYuwT9DIEKHdC1NwRHy4XjCKmFOavbcRx2IGKHhtN+EgL6bo1Sb7nvbpCaxoqKWL8i97eYE89oZiJ53AGHCM9OTmqy4TF+UvSG3jT+hNKY5d6auNgZza5JJ8tiXDbydGEQmLLwV9ldKRlCbbBO9kJdB3w/IcTmnohnK2PmeDP5wlzo+sMklwIDAQAB'

/** Extension config (Spec 09 §1-§2). MV3, Chromium-first (ADR-0003). */
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'sublight',
    description: 'Local AI subtitles for any video',
    key: DEV_PUBLIC_KEY,
    permissions: ['storage', 'tabCapture', 'activeTab', 'scripting'],
    host_permissions: ['http://127.0.0.1:17421/*', 'http://localhost:17421/*'],
    action: { default_title: 'sublight' },
  },
})
