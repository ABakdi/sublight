declare const __SUBLIGHT_BUILD__: string | undefined

/**
 * This build's id (wxt.config.ts). After an update on disk, Chromium keeps
 * running the old service worker until the extension is reloaded, while the
 * popup loads the new files: the popup compares ids to catch that.
 */
export const BUILD_ID: string = typeof __SUBLIGHT_BUILD__ === 'string' ? __SUBLIGHT_BUILD__ : 'dev'
