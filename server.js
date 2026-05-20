/**
 * Custom Next.js server that also runs the relay WebSocket server in the same process.
 *
 * Why this exists: previously `npm run dev` only started Next.js, and users had to run
 * `npm run dev:all` (which used concurrently) to also bring up the relay. That setup was
 * brittle — the relay could fail silently and users wouldn't notice until the QR scan
 * stopped working. Embedding the relay here means a single `npm run dev` always brings
 * both up together, with one set of logs.
 *
 * Multi-tenant rooms:
 *   The relay used to maintain a single (phone, browsers) pair globally — fine for the
 *   single-user dev flow, but broken for SaaS. Now every connection is routed into a
 *   `rooms` Map keyed by `phoneToken` (User.phoneToken in Prisma). Browser opens
 *   `ws://host:3001?token=<phoneToken>`; phone opens `ws://host:3001/phone?token=<phoneToken>`.
 *   Each room has its own phoneWs, browsers Set, outbound state, fail counter and device
 *   name — completely isolated. Connections without a token fall into a `'default'` room
 *   so the existing single-user dev flow keeps working without auth.
 */

const next = require('next');
const http = require('http');
const { parse } = require('url');
const { WebSocketServer, WebSocket } = require('ws');
const os = require('os');
const net = require('net');
const { PrismaClient } = require('@prisma/client');

const NEXT_PORT = parseInt(process.env.PORT || '3000', 10);
const RELAY_PORT = parseInt(process.env.RELAY_PORT || '3001', 10);
const HOSTNAME = os.hostname();
const dev = process.env.NODE_ENV !== 'production';

// One Prisma client for the whole relay process. server.js is a long-lived
// custom server (not Next.js runtime), so it can't import the TS singleton from
// lib/db.ts directly — instantiating here is fine because we never hot-reload
// this file. Connection pool is per-process so a single client is enough.
const db = new PrismaClient({ log: dev ? ['error'] : [] });

// Verbose relay logging — off by default to avoid blocking the Node.js event
// loop with synchronous console.log on every WS event. Set RELAY_VERBOSE=1
// in env to re-enable for debugging.
const RELAY_VERBOSE = process.env.RELAY_VERBOSE === '1';
const rlog = (...args) => { if (RELAY_VERBOSE) console.log(...args); };

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
// Relay server — multi-tenant rooms.
// One Room per phoneToken. Connections with no token go to the 'default' room
// so the legacy single-user dev flow keeps working.
// ---------------------------------------------------------------------------

const MAX_OUTBOUND_FAILURES = 3;

function startRelay() {
  const wss = new WebSocketServer({ port: RELAY_PORT });

  // token -> Room
  const rooms = new Map();

  function getRoom(token) {
    let room = rooms.get(token);
    if (!room) {
      room = {
        token,
        phoneWs: null,
        phoneConnected: false,
        phoneDeviceName: null,
        browsers: new Set(),
        outboundPhoneWs: null,
        outboundReconnectTimeout: null,
        outboundTargetUrl: null,
        outboundFailCount: 0,
      };
      rooms.set(token, room);
    }
    return room;
  }

  // Drop empty rooms so the Map does not grow forever. Default room is never
  // garbage-collected because it is the fallback for unauth dev.
  function maybeReapRoom(room) {
    if (room.token === 'default') return;
    if (room.phoneWs) return;
    if (room.outboundPhoneWs) return;
    if (room.outboundReconnectTimeout) return;
    if (room.browsers.size > 0) return;
    rooms.delete(room.token);
    console.log(`[Relay] Reaped empty room ${room.token}`);
  }

  function broadcastToBrowsers(room, msg) {
    room.browsers.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(typeof msg === 'string' ? msg : msg.toString());
      }
    });
  }

  /**
   * Notify the phone how many browsers are currently in its room.
   *
   * Wire format: `BROWSER_STATUS:{"count": N, "ts": <unix-ms>}`
   *
   * The Android agent uses this as the inverse of STATUS:{connected:true}:
   * when count > 0, the phone knows at least one browser is paired and stops
   * showing "waiting for web app". When count == 0, the phone can decide to
   * surface a "no browser connected" state in its own UI.
   *
   * Always uses the live room.browsers.size at call time — callers must add
   * the new ws to room.browsers (on join) or remove it (on leave) BEFORE
   * invoking this helper so the count is correct.
   *
   * No-op if no phone in the room or its WS is not open — the phone will
   * receive a fresh count when it next connects (we don't queue).
   */
  function sendBrowserStatusToPhone(room) {
    const phone = room.phoneWs;
    if (!phone || phone.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify({ count: room.browsers.size, ts: Date.now() });
    try {
      phone.send(`BROWSER_STATUS:${payload}`);
    } catch (e) {
      console.log(`[Relay][${room.token}] Failed to send BROWSER_STATUS: ${e.message}`);
    }
  }

  function setPhone(room, ws, source, inboundIp = null) {
    if (room.phoneWs && room.phoneWs !== ws) {
      try { room.phoneWs.close(); } catch (e) {}
    }
    room.phoneWs = ws;
    room.phoneWs.isAlive = true; // mark alive on connect so the first tick doesn't immediately terminate
    room.phoneConnected = true;
    room.phoneDeviceName = null;
    console.log(`[Relay][${room.token}] Phone connected (${source})`);
    // Include phoneIp only for inbound QR connections so the web app can pre-fill
    // the connect field and let the user confirm manually.
    const statusPayload = inboundIp
      ? { connected: true, phoneIp: inboundIp }
      : { connected: true };
    broadcastToBrowsers(room, `STATUS:${JSON.stringify(statusPayload)}`);
  }

  function clearPhone(room, source) {
    room.phoneWs = null;
    room.phoneConnected = false;
    room.phoneDeviceName = null;
    console.log(`[Relay][${room.token}] Phone disconnected (${source})`);
    broadcastToBrowsers(room, 'STATUS:{"connected":false}');
    maybeReapRoom(room);
  }

  function forwardToPhone(room, msg) {
    const active = room.phoneWs;
    if (active && active.readyState === WebSocket.OPEN) {
      active.send(msg);
      return true;
    }
    return false;
  }

  function connectOutboundToPhone(room, url) {
    if (room.outboundReconnectTimeout) {
      clearTimeout(room.outboundReconnectTimeout);
      room.outboundReconnectTimeout = null;
    }
    if (room.outboundPhoneWs) {
      try { room.outboundPhoneWs.removeAllListeners(); room.outboundPhoneWs.close(); } catch (e) {}
      room.outboundPhoneWs = null;
    }

    // Stop retrying after MAX_OUTBOUND_FAILURES consecutive ECONNREFUSED.
    // The phone server is not reachable — continuing to retry just spams logs
    // and wastes resources. A fresh CONNECT_TO from the browser resets the counter.
    if (room.outboundFailCount >= MAX_OUTBOUND_FAILURES) {
      console.log(`[Relay][${room.token}] Giving up outbound connection to ${url} after ${MAX_OUTBOUND_FAILURES} failures. Browser must reconnect manually.`);
      room.outboundTargetUrl = null;
      room.outboundFailCount = 0;
      maybeReapRoom(room);
      return;
    }

    room.outboundTargetUrl = url;
    console.log(`[Relay][${room.token}] Connecting outbound to phone at ${url}... (attempt ${room.outboundFailCount + 1}/${MAX_OUTBOUND_FAILURES})`);

    try {
      const outbound = new WebSocket(url);
      room.outboundPhoneWs = outbound;

      outbound.on('open', () => {
        room.outboundFailCount = 0; // reset on success
        setPhone(room, outbound, `outbound to ${url}`);
        outbound.send(`HELLO:{"hostname":"${HOSTNAME}"}`);
        // Same reason as the inbound path: tell the freshly-connected phone
        // how many browsers are already paired so its UI doesn't sit at
        // "waiting for web app" when there's actually a browser here.
        sendBrowserStatusToPhone(room);
      });

      outbound.on('message', (data) => {
        const msg = data.toString();
        rlog(`[Relay][${room.token}] Phone ->`, msg.substring(0, 60));
        if (msg.startsWith('DEVICE_INFO:')) {
          try {
            const payload = JSON.parse(msg.substring('DEVICE_INFO:'.length));
            room.phoneDeviceName = payload.deviceName || null;
            console.log(`[Relay][${room.token}] Phone device name: ${room.phoneDeviceName}`);
            broadcastToBrowsers(room, `STATUS:${JSON.stringify({ connected: true, deviceName: room.phoneDeviceName })}`);
          } catch (e) {}
        }
        broadcastToBrowsers(room, msg);
      });

      outbound.on('close', () => {
        if (room.phoneWs === outbound) {
          clearPhone(room, 'outbound closed');
        }
        room.outboundPhoneWs = null;
        if (room.browsers.size > 0 && room.outboundTargetUrl) {
          room.outboundReconnectTimeout = setTimeout(
            () => connectOutboundToPhone(room, room.outboundTargetUrl),
            5000
          );
        } else {
          maybeReapRoom(room);
        }
      });

      outbound.on('error', (err) => {
        if (err.message.includes('ECONNREFUSED')) {
          room.outboundFailCount++;
          console.log(`[Relay][${room.token}] Outbound phone error: ${err.message} (failure ${room.outboundFailCount}/${MAX_OUTBOUND_FAILURES})`);
        } else {
          console.log(`[Relay][${room.token}] Outbound phone error: ${err.message}`);
        }
      });

      outbound.on('pong', () => {
        if (room.outboundPhoneWs) room.outboundPhoneWs.isAlive = true;
        rlog(`[Relay][${room.token}] Phone pong received`);
      });
    } catch (err) {
      console.log(`[Relay][${room.token}] Failed to connect outbound: ${err.message}`);
      if (room.browsers.size > 0) {
        room.outboundReconnectTimeout = setTimeout(() => connectOutboundToPhone(room, url), 5000);
      }
    }
  }

  /**
   * Extract phoneToken from the connection request URL.
   * Browser:  ws://host:3001/?token=XYZ      → ('XYZ', '/')
   * Phone:    ws://host:3001/phone?token=XYZ → ('XYZ', '/phone')
   * Missing token falls back to 'default' (legacy unauth dev mode).
   */
  function parseConnection(req) {
    const parsed = parse(req.url || '/', true);
    const pathname = parsed.pathname || '/';
    const rawToken = parsed.query?.token;
    const token = (typeof rawToken === 'string' && rawToken.trim().length > 0)
      ? rawToken.trim()
      : null;
    return { pathname, token };
  }

  /**
   * Validate a phoneToken against the User table.
   * Returns the userId on success, null on miss. Errors are logged and surface
   * as null so a transient DB blip doesn't crash the relay; the caller closes
   * the socket and the client retries.
   */
  async function validateToken(token) {
    try {
      const user = await db.user.findUnique({
        where: { phoneToken: token },
        select: { id: true },
      });
      return user ? user.id : null;
    } catch (err) {
      console.error(`[Relay] Token lookup failed: ${err.message}`);
      return null;
    }
  }

  wss.on('connection', async (ws, req) => {
    const { pathname, token: rawToken } = parseConnection(req);

    // Backwards-compat: no token in query → legacy single-user LAN-IP mode.
    // Everything funnels into the 'default' room; no DB lookup, no userId.
    // Remove this branch once all clients (web + Android) are sending tokens.
    let token = rawToken;
    let userId = null;
    if (!token) {
      token = 'default';
    } else {
      userId = await validateToken(token);
      if (!userId) {
        console.log(`[Relay] Rejecting connection — invalid token: ${token.substring(0, 8)}...`);
        // 4401 = our custom "unauthorized" close code (4xxx is application range).
        try { ws.close(4401, 'invalid_token'); } catch (e) {}
        return;
      }
      // Stash on the socket so message handlers / future audit logging can read it
      // without another DB hit. Auth happens once, here, on connect.
      ws.userId = userId;
      ws.phoneToken = token;
    }

    const room = getRoom(token);

    if (pathname === '/phone') {
      console.log(`[Relay][${token}] Phone connected as client (QR scan mode)`);

      // Extract the phone's LAN IP so the web app can pre-fill it for manual connect.
      // req.socket.remoteAddress may be IPv6-mapped (::ffff:192.168.x.x) — strip the prefix.
      const rawPhoneIp = req.socket?.remoteAddress || '';
      const phoneInboundIp = rawPhoneIp.replace(/^::ffff:/, '').trim();
      console.log(`[Relay][${token}] Phone inbound IP: ${phoneInboundIp}`);

      // Inbound QR overrides any pending outbound attempt for this room.
      if (room.outboundReconnectTimeout) {
        clearTimeout(room.outboundReconnectTimeout);
        room.outboundReconnectTimeout = null;
      }
      if (room.outboundPhoneWs) {
        try { room.outboundPhoneWs.removeAllListeners(); room.outboundPhoneWs.close(); } catch (e) {}
        room.outboundPhoneWs = null;
        room.outboundTargetUrl = null;
      }

      // Pass phoneInboundIp so setPhone includes it in the STATUS broadcast.
      setPhone(room, ws, 'inbound QR', phoneInboundIp);
      ws.send(`HELLO:{"hostname":"${HOSTNAME}"}`);

      // Phone just joined — tell it whether any browsers are already in the room.
      // Without this, a phone that connects AFTER a browser would never receive
      // the initial count and would sit in "waiting for web app" forever.
      sendBrowserStatusToPhone(room);

      ws.on('message', (data) => {
        const msg = data.toString();
        rlog(`[Relay][${token}] Phone ->`, msg.substring(0, 60));
        if (msg.startsWith('DEVICE_INFO:')) {
          try {
            const payload = JSON.parse(msg.substring('DEVICE_INFO:'.length));
            room.phoneDeviceName = payload.deviceName || null;
            console.log(`[Relay][${token}] Phone device name: ${room.phoneDeviceName}`);
            broadcastToBrowsers(room, `STATUS:${JSON.stringify({ connected: true, deviceName: room.phoneDeviceName, phoneIp: phoneInboundIp })}`);
          } catch (e) {}
        }
        broadcastToBrowsers(room, msg);
      });

      ws.on('close', () => {
        if (room.phoneWs === ws) {
          clearPhone(room, 'inbound QR closed');
        }
      });

      ws.on('error', (err) => {
        console.log(`[Relay][${token}] Phone (inbound) error: ${err.message}`);
      });

      ws.on('pong', () => {
        ws.isAlive = true;
        rlog(`[Relay][${token}] Phone pong received`);
      });

      return;
    }

    // Browser connection (default path)
    console.log(`[Relay][${token}] Browser connected (${room.browsers.size + 1} total in room)`);
    room.browsers.add(ws);

    if (room.phoneConnected) {
      ws.send(`STATUS:${JSON.stringify({ connected: true, deviceName: room.phoneDeviceName })}`);
    } else {
      ws.send('STATUS:{"connected":false}');
    }

    // Tell the phone how many browsers are in this room. This is the inverse
    // half of the false-connection fix: webapp gets STATUS:{connected:true}
    // the moment the phone is in the room; the Android agent needs the
    // symmetric signal so it stops showing "waiting for web app" when a
    // browser actually is paired. Sent on join AND on leave so the phone's
    // count is always current.
    sendBrowserStatusToPhone(room);

    ws.on('message', (data) => {
      const msg = data.toString();
      rlog(`[Relay][${token}] Browser ->`, msg.substring(0, 60));

      if (msg.startsWith('SCAN_FOR_PHONE:')) {
        console.log(`[Relay][${token}] Browser requested phone scan...`);
        // Tell browser we're scanning
        ws.send('SCAN_STATUS:{"scanning":true}');

        const subnet = getLocalSubnet();
        console.log(`[Relay][${token}] Scanning subnet ${subnet}.0/24 for port 8765...`);

        scanForPhone(subnet, 8765).then(ip => {
          if (ip) {
            console.log(`[Relay][${token}] Found phone at ${ip}:8765`);
            ws.send(`SCAN_STATUS:{"scanning":false,"found":true,"phoneIp":"${ip}"}`);
          } else {
            console.log(`[Relay][${token}] No phone found on subnet`);
            ws.send('SCAN_STATUS:{"scanning":false,"found":false}');
          }
        });
        return;
      }

      if (msg.startsWith('CONNECT_TO:')) {
        const url = msg.substring('CONNECT_TO:'.length).trim();
        console.log(`[Relay][${token}] Browser requested outbound connection to: ${url}`);
        room.outboundFailCount = 0; // fresh user-initiated attempt resets failure counter
        connectOutboundToPhone(room, url);
        return;
      }

      if (msg.startsWith('DISCONNECT_PHONE:')) {
        // Browser clicked "Disconnect" — close the phone connection but keep
        // the relay alive and the browser WS open. The relay server stays up
        // so the browser can reconnect a new phone without reloading the page.
        console.log(`[Relay][${token}] Browser requested phone disconnect`);
        if (room.outboundReconnectTimeout) {
          clearTimeout(room.outboundReconnectTimeout);
          room.outboundReconnectTimeout = null;
        }
        if (room.outboundPhoneWs) {
          try { room.outboundPhoneWs.removeAllListeners(); room.outboundPhoneWs.close(); } catch (e) {}
          room.outboundPhoneWs = null;
          room.outboundTargetUrl = null;
        }
        if (room.phoneWs) {
          try { room.phoneWs.close(); } catch (e) {}
          // clearPhone will be called by the close event handler
        }
        return;
      }

      if (!forwardToPhone(room, msg)) {
        console.log(`[Relay][${token}] No phone connected, message dropped`);
      }
    });

    ws.on('close', () => {
      room.browsers.delete(ws);
      console.log(`[Relay][${token}] Browser disconnected (${room.browsers.size} remaining in room)`);
      // Tell the phone the count dropped (could be 0 → phone surfaces "no
      // browser paired" UI; could be 2→1 → phone keeps showing paired).
      sendBrowserStatusToPhone(room);
      if (room.browsers.size === 0 && room.outboundReconnectTimeout) {
        clearTimeout(room.outboundReconnectTimeout);
        room.outboundReconnectTimeout = null;
        console.log(`[Relay][${token}] No browsers connected, stopped outbound reconnect`);
      }
      if (room.browsers.size === 0) {
        maybeReapRoom(room);
      }
    });

    ws.on('error', (err) => {
      console.log(`[Relay][${token}] Browser error: ${err.message}`);
    });
  });

  wss.on('listening', () => {
    console.log(`[Relay] Ready on ws://localhost:${RELAY_PORT} — accepts browser (/) and phone (/phone) connections with ?token=<phoneToken> (validated against User.phoneToken; missing token falls back to legacy 'default' room)`);
  });

  // Keep every active phone connection alive and detect silent disconnects.
  //
  // Before each ping we mark each phone as "presumed dead". If a pong comes back
  // before the next tick, isAlive is flipped back to true. If we reach the next
  // tick and isAlive is still false the phone vanished without a TCP close —
  // terminate() fires the 'close' event → clearPhone() → STATUS:false broadcast.
  // This catches: killed Android app, phone rebooted, WiFi dropped mid-session.
  const phoneKeepaliveInterval = setInterval(() => {
    rooms.forEach((room) => {
      const phoneWs = room.phoneWs;
      if (!phoneWs || phoneWs.readyState !== WebSocket.OPEN) return;

      if (phoneWs.isAlive === false) {
        console.log(`[Relay][${room.token}] Phone missed heartbeat — terminating stale connection`);
        phoneWs.terminate(); // fires 'close' → clearPhone() → browsers get STATUS:false
        return;
      }

      phoneWs.isAlive = false; // presume dead until pong arrives
      phoneWs.ping();
    });
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
  console.log(`[Server] Launching relay WebSocket server on port ${RELAY_PORT}...`);
  startRelay();

  // Then start Next.js.
  console.log(`[Server] Launching Next.js on port ${NEXT_PORT}...`);
  // webpack: true — Turbopack panics on Windows when bundling Prisma's
  // native client (tries to symlink `@prisma/client` into the build chunks;
  // hits `os error 1314 / SeCreateSymbolicLinkPrivilege` for non-admin users).
  // IMPORTANT: Next 16's `next()` factory silently ignores `turbopack: false`
  // (only checks truthy). To actually opt OUT of Turbopack you must pass
  // `webpack: true`. Verified 2026-05-19 in the saas-test rig — without this
  // flag Turbopack runs regardless of any other config and every Prisma-
  // importing API route 500s.
  const app = next({ dev, webpack: true });
  const handle = app.getRequestHandler();
  await app.prepare();

  const httpServer = http.createServer((req, res) => {
    const parsedUrl = parse(req.url || '/', true);
    handle(req, res, parsedUrl);
  });

  httpServer.listen(NEXT_PORT, (err) => {
    if (err) throw err;
    console.log(`[Server] Next.js ready on http://localhost:${NEXT_PORT}`);
    console.log(`[Server] Both Next.js (${NEXT_PORT}) and Relay (${RELAY_PORT}) are running in this process.`);
  });
}

main().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
