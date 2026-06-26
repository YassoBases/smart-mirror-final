import * as os from 'os';

const VIRTUAL_IFACE = /^(docker|br-|veth|tun|tap|tailscale|zt|wg|virbr)/;

/**
 * Returns the best local LAN IPv4 address synchronously.
 * Skips virtual/container interfaces (same list as backend netinfo).
 * Prefers 192.168.x.x → 10.x.x.x → 172.16-31.x.x → any non-loopback.
 * Falls back to 127.0.0.1 if nothing is found.
 */
export function getLocalIp(): string {
  const candidates: string[] = [];

  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        candidates.push(addr.address);
      }
    }
  }

  return (
    candidates.find(ip => ip.startsWith('192.168.')) ??
    candidates.find(ip => ip.startsWith('10.')) ??
    candidates.find(ip => /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) ??
    candidates[0] ??
    '127.0.0.1'
  );
}
