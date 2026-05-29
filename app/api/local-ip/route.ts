import { NextResponse } from 'next/server';
import os from 'os';

// F-3 (2026-05-29): /api/local-ip enumerates the host's network interfaces and
// returns a LAN IP. In dev this drives the QR-code value (so a phone on the
// same Wi-Fi can scan and reach the dev server). In production this endpoint
// has no use — the QR uses the public APP_URL — and an unauthenticated probe
// of the container's network topology is information leakage. Hard 404 in
// production; leave the original behavior in dev untouched.
const PRIORITY_NAMES = ['Wi-Fi', 'Ethernet', 'en0', 'en1', 'eth0', 'wlan0'];
const VIRTUAL_PATTERNS = /vEthernet|VMware|VirtualBox|Docker|Hyper-V|WSL|Loopback|vboxnet|br-|virbr|Tailscale|tailscale|ZeroTier|nordlynx|ProtonVPN|ExpressVPN|NordVPN/i;

/** Returns true for VPN/tunnel IP ranges that won't work on a local LAN.
 *  - 100.64.0.0/10  — Tailscale CGNAT
 *  - 10.x.x.x       — often used by corporate VPNs (skip if it's a VPN adapter)
 */
function isVpnIp(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  // Tailscale CGNAT: 100.64.0.0 – 100.127.255.255
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  return false;
}

export async function GET() {
  // F-3: not for production. Return 404 so the route is indistinguishable
  // from any other unknown path to an external prober.
  if (process.env.NODE_ENV === 'production') {
    return new NextResponse('Not Found', { status: 404 });
  }

  const interfaces = os.networkInterfaces();
  let localIp = 'localhost';

  // Pass 1: Try priority interface names first (skip VPN IPs even on priority interfaces)
  for (const name of PRIORITY_NAMES) {
    for (const iface of interfaces[name] || []) {
      if (iface.internal || iface.family !== 'IPv4') continue;
      if (isVpnIp(iface.address)) continue; // skip Tailscale / VPN IPs
      return NextResponse.json({ ip: iface.address });
    }
  }

  // Pass 2: Any non-virtual, non-internal, non-VPN IPv4
  for (const name of Object.keys(interfaces)) {
    if (VIRTUAL_PATTERNS.test(name)) continue;
    for (const iface of interfaces[name] || []) {
      if (iface.internal || iface.family !== 'IPv4') continue;
      if (isVpnIp(iface.address)) continue;
      localIp = iface.address;
      break;
    }
    if (localIp !== 'localhost') break;
  }

  return NextResponse.json({ ip: localIp });
}
