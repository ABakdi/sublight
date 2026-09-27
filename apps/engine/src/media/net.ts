import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { JobError } from '../jobs/queue'

/** This computer, the local network, and addresses that aren't hosts (baseline A10/B4/F6). */
const PRIVATE = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv6')

export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return PRIVATE.check(mapped[1]!, 'ipv4')
  const family = isIP(address)
  if (family === 4) return PRIVATE.check(address, 'ipv4')
  if (family === 6) return PRIVATE.check(address, 'ipv6')
  return true // not an address at all
}

/**
 * Page and media URLs come from web pages (through the extension or a Player
 * link): the engine fetches them only from the public internet, unless
 * `allowPrivateNetworks` says a local media server is fine. Checked when
 * resolving; a DNS answer that changes afterwards is out of scope.
 */
export async function assertPublicUrl(url: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return
  let host: string
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '')
  } catch {
    throw new JobError('JOB_INVALID', 'not a valid URL', false, 400)
  }
  const addresses = isIP(host)
    ? [host]
    : await lookup(host, { all: true }).then(
        (r) => r.map((a) => a.address),
        () => [] as string[],
      )
  // Unresolvable names fail later with the fetch's own error.
  if (addresses.some(isPrivateAddress))
    throw new JobError(
      'MEDIA_UNREACHABLE',
      'sublight only fetches videos from the internet, not from this computer or the local network (allowPrivateNetworks in config.json changes that)',
      false,
      422,
    )
}
