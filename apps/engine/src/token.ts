import { loadConfig, sublightHome } from './config'

/**
 * Print the engine bearer token for pairing a client by hand (paste it into
 * the extension options page). Creates the config on first run. The M06
 * pairing flow replaces this.
 */
const config = loadConfig()
console.log(config.token)
console.error(`(from ${sublightHome()}/config.json)`)
