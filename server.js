/**
 * Custom Next.js server that also runs the relay WebSocket server in the same process.
 *
 * Why this exists: previously `npm run dev` only started Next.js, and users had to run
 * `npm run dev:all` (which used concurrently) to also bring up the relay. That setup was
 * brittle — the relay could fail silently and users wouldn't notice until the QR scan
 * stopped working. Embedding the relay here means a single `npm run dev` always brings
 * both up together, with one set of logs.
 */

const next = require('next');
const http = require('http');
const { parse } = require('url');
const { WebSocketServer, WebSocket } = require('ws');
const os = require('os');
const net = require('net');

const NEXT_PORT = parseInt(process.env.PORT || '3000', 10);
const RELAY_PORT = 3001;
const HOSTNAME = os.hostname();
const dev = process.env.NODE_ENV !== 'production';

// ---------------------------------------------------------------------------
// LAN discovery helpers — used by the SCAN_FOR_PHONE relay command so the
// browser can ask the relay to find the Android app on the local subnet
// without the user needing to type an IP.
// ---------------------------------------------------------------------------

/**
 * Scan a /24 subnet for a specific open TCP port.
 * Returns the first IP found, or null if none respond within timeoutMs.
 */
function scanForPhone(subnet, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let found = null;
    let pending = 0;
    let resolved = false;

    const done = (ip) => {
      if (resolved) return;
      resolved = true;
      resolve(ip);
    };

    for (let i = 1; i <= 254; i++) {
      const ip = `${subnet}.${i}`;
      pending++;
      const socket = new net.Socket();
      socket.setTimeout(timeoutMs);
      socket.on('connect', () => {
        socket.destroy();
        if (!found) { found = ip; done(ip); }
        pending--;
      });
      socket.on('error', () => { socket.destroy(); pending--; if (pending === 0) done(null); });
      socket.on('timeout', () => { socket.destroy(); pending--; if (pending === 0) done(null); });
      socket.connect(port, ip);
    }

    // Safety fallback — resolve null after 2.5s regardless
    setTimeout(() => done(null), 2500);
  });
}

/**
 * Best-effort detection of the host's primary LAN /24 subnet.
 * Skips virtual adapters (Hyper-V, WSL, Docker, VMware, VirtualBox) so we
 * scan the real WiFi/Ethernet the phone is on, not a host-only bridge.
 */
function getLocalSubnet() {
  const interfaces = os.networkInterfaces();
  const VIRTUAL = /vEthernet|VMware|VirtualBox|Docker|Hyper-V|WSL|vboxnet|br-|virbr|Tailscale|tailscale|ZeroTier|nordlynx/i;
  const PRIORITY = ['Wi-Fi', 'Ethernet', 'en0', 'en1', 'eth0', 'wlan0'];

  // Returns true for IPs that are NOT usable LAN addresses:
  //   169.254.x.x — link-local / APIPA (no DHCP assigned)
  //   100.64–127.x — Tailscale CGNAT
  function isUnusableIp(ip) {
    const p = ip.split('.').map(Number);
    if (p[0] === 169 && p[1] === 254) return true;       // link-local
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // Tailscale
    return false;
  }

  // Try priority interfaces first, skip bad IPs
  for (const name of PRIORITY) {
    const ifaces = interfaces[name] || [];
    for (const iface of ifaces) {
      if (!iface.internal && iface.family === 'IPv4' && !isUnusableIp(iface.address)) {
        return iface.address.split('.').slice(0, 3).join('.');
      }
    }
  }
  // Fallback: any non-virtual, non-bad IPv4
  for (const [name, ifaces] of Object.entries(interfaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const iface of (ifaces || [])) {
      if (!iface.internal && iface.family === 'IPv4' && !isUnusableIp(iface.address)) {
        return iface.address.split('.').slice(0, 3).join('.');
      }
    }
  }
  return '192.168.1'; // last resort
}

// ---------------------------------------------------------------------------
// Relay server (extracted from relay-server.js, identical behavior)
// ---------------------------------------------------------------------------

function startRelay() {
  const wss = new WebSocketServer({ port: RELAY_PORT });

  // State
  let phoneWs = null;
  let phoneConnected = false;
  const browsers = new Set();
  let outboundPhoneWs = null;
  let outboundReconnectTimeout = null;
  let outboundTargetUrl = null;
  let phoneDeviceName = null;

  function broadcastToBrowsers(msg) {
    browsers.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(typeof msg === 'string' ? msg : msg.toString());
      }
    });
  }

  function setPhone(ws, source, inboundIp = null) {
    if (phoneWs && phoneWs !== ws) {
      try { phoneWs.close(); } catch (e) {}
    }
    phoneWs = ws;
    phoneWs.isAlive = true; // mark alive on connect so the first tick doesn't immediately terminate
    phoneConnected = true;
    phoneDeviceName = null;
    console.log(`[Relay] Phone connected (${source})`);
    // Include phoneIp only for inbound QR connections so the web app can pre-fill
    // the connect field and let the user confirm manually.
    const statusPayload = inboundIp
      ? { connected: true, phoneIp: inboundIp }
      : { connected: true };
    broadcastToBrowsers(`STATUS:${JSON.stringify(statusPayload)}`);
  }

  function clearPhone(source) {
    phoneWs = null;
    phoneConnected = false;
    phoneDeviceName = null;
    console.log(`[Relay] Phone disconnected (${source})`);
    broadcastToBrowsers('STATUS:{"connected":false}');
  }

  function forwardToPhone(msg) {
    const active = phoneWs;
    if (active && active.readyState === WebSocket.OPEN) {
      active.send(msg);
      return true;
    }
    return false;
  }

  // Track consecutive ECONNREFUSED failures so we stop retrying after 3 strikes.
  let outboundFailCount = 0;
  const MAX_OUTBOUND_FAILURES = 3;

  function connectOutboundToPhone(url) {
    if (outboundReconnectTimeout) {
      clearTimeout(outboundReconnectTimeout);
      outboundReconnectTimeout = null;
    }
    if (outboundPhoneWs) {
      try { outboundPhoneWs.removeAllListeners(); outboundPhoneWs.close(); } catch (e) {}
      outboundPhoneWs = null;
    }

    // Stop retrying after MAX_OUTBOUND_FAILURES consecutive ECONNREFUSED.
    // The phone server is not reachable — continuing to retry just spams logs
    // and wastes resources. A fresh CONNECT_TO from the browser resets the counter.
    if (outboundFailCount >= MAX_OUTBOUND_FAILURES) {
      console.log(`[Relay] Giving up outbound connection to ${url} after ${MAX_OUTBOUND_FAILURES} failures. Browser must reconnect manually.`);
      outboundTargetUrl = null;
      outboundFailCount = 0;
      return;
    }

    outboundTargetUrl = url;
    console.log(`[Relay] Connecting outbound to phone at ${url}... (attempt ${outboundFailCount + 1}/${MAX_OUTBOUND_FAILURES})`);

    try {
      outboundPhoneWs = new WebSocket(url);

      outboundPhoneWs.on('open', () => {
        outboundFailCount = 0; // reset on success
        setPhone(outboundPhoneWs, `outbound to ${url}`);
        outboundPhoneWs.send(`HELLO:{"hostname":"${HOSTNAME}"}`);
      });

      outboundPhoneWs.on('message', (data) => {
        const msg = data.toString();
        console.log('[Relay] Phone ->', msg.substring(0, 60));
        if (msg.startsWith('DEVICE_INFO:')) {
          try {
            const payload = JSON.parse(msg.substring('DEVICE_INFO:'.length));
            phoneDeviceName = payload.deviceName || null;
            console.log(`[Relay] Phone device name: ${phoneDeviceName}`);
            broadcastToBrowsers(`STATUS:${JSON.stringify({ connected: true, deviceName: phoneDeviceName })}`);
          } catch (e) {}
        }
        broadcastToBrowsers(msg);
      });

      outboundPhoneWs.on('close', () => {
        if (phoneWs === outboundPhoneWs) {
          clearPhone('outbound closed');
        }
        outboundPhoneWs = null;
        if (browsers.size > 0 && outboundTargetUrl) {
          outboundReconnectTimeout = setTimeout(() => connectOutboundToPhone(outboundTargetUrl), 5000);
        }
      });

      outboundPhoneWs.on('error', (err) => {
        if (err.message.includes('ECONNREFUSED')) {
          outboundFailCount++;
          console.log(`[Relay] Outbound phone error: ${err.message} (failure ${outboundFailCount}/${MAX_OUTBOUND_FAILURES})`);
        } else {
          console.log(`[Relay] Outbound phone error: ${err.message}`);
        }
      });

      outboundPhoneWs.on('pong', () => {
        if (outboundPhoneWs) outboundPhoneWs.isAlive = true;
        console.log('[Relay] Phone pong received');
      });
    } catch (err) {
      console.log(`[Relay] Failed to connect outbound: ${err.message}`);
      if (browsers.size > 0) {
        outboundReconnectTimeout = setTimeout(() => connectOutboundToPhone(url), 5000);
      }
    }
  }

  wss.on('connection', (ws, req) => {
    const path = req.url || '/';

    if (path === '/phone') {
      console.log('[Relay] Phone connected as client (QR scan mode)');

      // Extract the phone's LAN IP so the web app can pre-fill it for manual connect.
      // req.socket.remoteAddress may be IPv6-mapped (::ffff:192.168.x.x) — strip the prefix.
      const rawPhoneIp = req.socket?.remoteAddress || '';
      const phoneInboundIp = rawPhoneIp.replace(/^::ffff:/, '').trim();
      console.log(`[Relay] Phone inbound IP: ${phoneInboundIp}`);

      if (outboundReconnectTimeout) {
        clearTimeout(outboundReconnectTimeout);
        outboundReconnectTimeout = null;
      }
      if (outboundPhoneWs) {
        try { outboundPhoneWs.removeAllListeners(); outboundPhoneWs.close(); } catch (e) {}
        outboundPhoneWs = null;
        outboundTargetUrl = null;
      }

      // Pass phoneInboundIp so setPhone includes it in the STATUS broadcast.
      setPhone(ws, 'inbound QR', phoneInboundIp);
      ws.send(`HELLO:{"hostname":"${HOSTNAME}"}`);

      ws.on('message', (data) => {
        const msg = data.toString();
        console.log('[Relay] Phone ->', msg.substring(0, 60));
        if (msg.startsWith('DEVICE_INFO:')) {
          try {
            const payload = JSON.parse(msg.substring('DEVICE_INFO:'.length));
            phoneDeviceName = payload.deviceName || null;
            console.log(`[Relay] Phone device name: ${phoneDeviceName}`);
            broadcastToBrowsers(`STATUS:${JSON.stringify({ connected: true, deviceName: phoneDeviceName, phoneIp: phoneInboundIp })}`);
          } catch (e) {}
        }
        broadcastToBrowsers(msg);
      });

      ws.on('close', () => {
        if (phoneWs === ws) {
          clearPhone('inbound QR closed');
        }
      });

      ws.on('error', (err) => {
        console.log(`[Relay] Phone (inbound) error: ${err.message}`);
      });

      ws.on('pong', () => {
        ws.isAlive = true;
        console.log('[Relay] Phone pong received');
      });

      return;
    }

    // Browser connection (default)
    console.log(`[Relay] Browser connected (${browsers.size + 1} total)`);
    browsers.add(ws);

    if (phoneConnected) {
      ws.send(`STATUS:${JSON.stringify({ connected: true, deviceName: phoneDeviceName })}`);
    } else {
      ws.send('STATUS:{"connected":false}');
    }

    ws.on('message', (data) => {
      const msg = data.toString();
      console.log('[Relay] Browser ->', msg.substring(0, 60));

      if (msg.startsWith('SCAN_FOR_PHONE:')) {
        console.log('[Relay] Browser requested phone scan...');
        // Tell browser we're scanning
        ws.send('SCAN_STATUS:{"scanning":true}');

        const subnet = getLocalSubnet();
        console.log(`[Relay] Scanning subnet ${subnet}.0/24 for port 8765...`);

        scanForPhone(subnet, 8765).then(ip => {
          if (ip) {
            console.log(`[Relay] Found phone at ${ip}:8765`);
            ws.send(`SCAN_STATUS:{"scanning":false,"found":true,"phoneIp":"${ip}"}`);
          } else {
            console.log('[Relay] No phone found on subnet');
            ws.send('SCAN_STATUS:{"scanning":false,"found":false}');
          }
        });
        return;
      }

      if (msg.startsWith('CONNECT_TO:')) {
        const url = msg.substring('CONNECT_TO:'.length).trim();
        console.log(`[Relay] Browser requested outbound connection to: ${url}`);
        outboundFailCount = 0; // fresh user-initiated attempt resets failure counter
        connectOutboundToPhone(url);
        return;
      }

      if (msg.startsWith('DISCONNECT_PHONE:')) {
        // Browser clicked "Disconnect" — close the phone connection but keep
        // the relay alive and the browser WS open. The relay server stays up
        // so the browser can reconnect a new phone without reloading the page.
        console.log('[Relay] Browser requested phone disconnect');
        if (outboundReconnectTimeout) {
          clearTimeout(outboundReconnectTimeout);
          outboundReconnectTimeout = null;
        }
        if (outboundPhoneWs) {
          try { outboundPhoneWs.removeAllListeners(); outboundPhoneWs.close(); } catch (e) {}
          outboundPhoneWs = null;
          outboundTargetUrl = null;
        }
        if (phoneWs) {
          try { phoneWs.close(); } catch (e) {}
          // clearPhone will be called by the close event handler
        }
        return;
      }

      if (!forwardToPhone(msg)) {
        console.log('[Relay] No phone connected, message dropped');
      }
    });

    ws.on('close', () => {
      browsers.delete(ws);
      console.log(`[Relay] Browser disconnected (${browsers.size} remaining)`);
      if (browsers.size === 0 && outboundReconnectTimeout) {
        clearTimeout(outboundReconnectTimeout);
        outboundReconnectTimeout = null;
        console.log('[Relay] No browsers connected, stopped outbound reconnect');
      }
    });

    ws.on('error', (err) => {
      console.log(`[Relay] Browser error: ${err.message}`);
    });
  });

  wss.on('listening', () => {
    console.log(`[Relay] Ready on ws://localhost:${RELAY_PORT} — accepts browser (/) and phone (/phone) connections`);
  });

  // Keep phone connection alive and detect silent disconnects.
  //
  // Before each ping we mark the phone as "presumed dead". If a pong comes back
  // before the next tick, isAlive is flipped back to true. If we reach the next
  // tick and isAlive is still false the phone vanished without a TCP close —
  // terminate() fires the 'close' event → clearPhone() → STATUS:false broadcast.
  // This catches: killed Android app, phone rebooted, WiFi dropped mid-session.
  const phoneKeepaliveInterval = setInterval(() => {
    if (!phoneWs || phoneWs.readyState !== WebSocket.OPEN) return;

    if (phoneWs.isAlive === false) {
      console.log('[Relay] Phone missed heartbeat — terminating stale connection');
      phoneWs.terminate(); // fires 'close' → clearPhone() → browsers get STATUS:false
      return;
    }

    phoneWs.isAlive = false; // presume dead until pong arrives
    phoneWs.ping();
  }, 15000);

  wss.on('close', () => {
    clearInterval(phoneKeepaliveInterval);
  });

  wss.on('error', (err) => {
    console.error(`[Relay] Server error: ${err.message}`);
  });

  return wss;
}

// ---------------------------------------------------------------------------
// Next.js + relay startup
// ---------------------------------------------------------------------------

async function main() {
  console.log('[Server] Starting DNK Dialer...');
  console.log(`[Server] Mode: ${dev ? 'development' : 'production'}`);

  // Start the relay first so it is ready by the time the browser loads the page.
  console.log('[Server] Launching relay WebSocket server on port 3001...');
  startRelay();

  // Then start Next.js.
  console.log(`[Server] Launching Next.js on port ${NEXT_PORT}...`);
  const app = next({ dev });
  const handle = app.getRequestHandler();
  await app.prepare();

  const httpServer = http.createServer((req, res) => {
    const parsedUrl = parse(req.url || '/', true);
    handle(req, res, parsedUrl);
  });

  httpServer.listen(NEXT_PORT, (err) => {
    if (err) throw err;
    console.log(`[Server] Next.js ready on http://localhost:${NEXT_PORT}`);
    console.log('[Server] Both Next.js (3000) and Relay (3001) are running in this process.');
  });
}

main().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
