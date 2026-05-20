const { WebSocketServer, WebSocket } = require('ws');
const os = require('os');

const RELAY_PORT = 3001;
const HOSTNAME = os.hostname();

const wss = new WebSocketServer({ port: RELAY_PORT });
console.log(`[Relay] Listening on ws://localhost:${RELAY_PORT}`);

// State
let phoneWs = null;
let phoneConnected = false;
const browsers = new Set();
let outboundPhoneWs = null;
let outboundReconnectTimeout = null;
let outboundTargetUrl = null;
let phoneDeviceName = null;

// Accept-on-phone flow: outboundAwaitingAccept is true between the TCP/WS
// handshake completing and the phone's first DEVICE_INFO frame (which is
// the relay's proof that the user tapped Accept on the phone). While this
// flag is true the browser sees STATUS:{"awaitingAccept":true} and shows
// the "waiting for phone to accept" copy.
let outboundAwaitingAccept = false;

function broadcastToBrowsers(msg) {
  browsers.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(typeof msg === 'string' ? msg : msg.toString());
    }
  });
}

function setPhone(ws, source) {
  // Clean up any existing phone connection
  if (phoneWs && phoneWs !== ws) {
    try { phoneWs.close(); } catch(e) {}
  }
  phoneWs = ws;
  phoneConnected = true;
  phoneDeviceName = null; // Reset until DEVICE_INFO arrives
  console.log(`[Relay] ✅ Phone connected (${source})`);
  broadcastToBrowsers('STATUS:{"connected":true}');
}

function clearPhone(source) {
  phoneWs = null;
  phoneConnected = false;
  phoneDeviceName = null;
  console.log(`[Relay] Phone disconnected (${source})`);
  broadcastToBrowsers('STATUS:{"connected":false}');
}

// Forward browser message to phone (whichever connection is active)
function forwardToPhone(msg) {
  const active = phoneWs;
  if (active && active.readyState === WebSocket.OPEN) {
    active.send(msg);
    return true;
  }
  return false;
}

// Outbound connection to phone (fallback mode — when user enters IP manually).
//
// Accept-on-phone flow:
//   - WS open  → phone has completed the handshake but is showing the user
//                an Accept/Decline notification. We broadcast STATUS:{"awaitingAccept":true}
//                and send HELLO. We DO NOT call setPhone() / broadcast
//                connected:true yet — the phone's APK explicitly does not
//                send DEVICE_INFO until the user taps Accept.
//   - DEVICE_INFO frame → phone has accepted. Flip outboundAwaitingAccept
//                false, call setPhone(), broadcast connected:true.
//   - close code 1008 → phone declined (user tapped Decline / auto-decline
//                timer fired). Broadcast STATUS:{"declined":true} and STOP
//                the auto-reconnect loop so we don't immediately retry an
//                already-rejected connection.
function connectOutboundToPhone(url) {
  if (outboundReconnectTimeout) {
    clearTimeout(outboundReconnectTimeout);
    outboundReconnectTimeout = null;
  }
  if (outboundPhoneWs) {
    try { outboundPhoneWs.removeAllListeners(); outboundPhoneWs.close(); } catch(e) {}
    outboundPhoneWs = null;
  }

  outboundTargetUrl = url;
  outboundAwaitingAccept = false;
  console.log(`[Relay] Connecting outbound to phone at ${url}...`);

  try {
    outboundPhoneWs = new WebSocket(url);

    outboundPhoneWs.on('open', () => {
      // Accept gate: do NOT mark phone connected yet. The phone is showing
      // the user an Accept/Decline prompt; we'll commit on DEVICE_INFO.
      outboundAwaitingAccept = true;
      console.log(`[Relay] Outbound WS open — awaiting phone Accept`);
      broadcastToBrowsers('STATUS:{"awaitingAccept":true}');
      // Tell phone which computer connected (informational — sent regardless
      // of accept state so the phone can render the source name in its UI).
      try { outboundPhoneWs.send(`HELLO:{"hostname":"${HOSTNAME}"}`); } catch(e) {}
    });

    outboundPhoneWs.on('message', (data) => {
      const msg = data.toString();
      console.log('[Relay] Phone →', msg.substring(0, 60));
      // DEVICE_INFO is the phone's "user accepted" signal. Until we see it,
      // the outbound socket is just a polite handshake — the phone refuses
      // to process commands and we refuse to mark connected:true.
      if (msg.startsWith('DEVICE_INFO:')) {
        try {
          const payload = JSON.parse(msg.substring('DEVICE_INFO:'.length));
          phoneDeviceName = payload.deviceName || null;
          console.log(`[Relay] Phone device name: ${phoneDeviceName}`);
          if (outboundAwaitingAccept) {
            outboundAwaitingAccept = false;
            setPhone(outboundPhoneWs, `outbound to ${url} (accepted)`);
          }
          broadcastToBrowsers(`STATUS:${JSON.stringify({ connected: true, deviceName: phoneDeviceName })}`);
        } catch(e) {}
      }
      broadcastToBrowsers(msg);
    });

    outboundPhoneWs.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : '';
      console.log(`[Relay] Outbound phone closed — code=${code} reason=${reasonStr}`);
      const wasDeclined = code === 1008 || reasonStr === 'user_declined';
      const userDisconnected = code === 1000 && reasonStr === 'user_disconnect';

      if (phoneWs === outboundPhoneWs) {
        clearPhone('outbound closed');
      }
      // If we never finished the Accept handshake the browser never got a
      // connected:true; surface the right copy so the user knows WHY the
      // attempt ended without ever showing as connected.
      if (outboundAwaitingAccept) {
        outboundAwaitingAccept = false;
        if (wasDeclined) {
          broadcastToBrowsers('STATUS:{"declined":true}');
        } else if (!userDisconnected) {
          // Pre-Accept close with neither decline nor explicit disconnect
          // (e.g. phone screen off + Doze killed the socket). Tell the
          // browser the attempt failed so it can offer a retry.
          broadcastToBrowsers('STATUS:{"connected":false}');
        }
      }

      outboundPhoneWs = null;

      // Retry only if the close was NOT a deliberate user action.
      // - 1008 (declined): user said no, don't pester them with retries.
      // - 1000 + user_disconnect: user clicked Disconnect, intentional.
      // Otherwise (network blip, phone restart) the legacy retry loop
      // still applies for parity with the pre-Accept behavior.
      const shouldRetry = !wasDeclined &&
        !userDisconnected &&
        browsers.size > 0 &&
        outboundTargetUrl;
      if (shouldRetry) {
        outboundReconnectTimeout = setTimeout(
          () => connectOutboundToPhone(outboundTargetUrl),
          5000
        );
      } else if (wasDeclined || userDisconnected) {
        // Clear the target so a subsequent reconnect requires an explicit
        // CONNECT_TO from the browser — no silent retry of a rejected URL.
        outboundTargetUrl = null;
      }
    });

    outboundPhoneWs.on('error', (err) => {
      console.log(`[Relay] Outbound phone error: ${err.message}`);
    });
  } catch (err) {
    console.log(`[Relay] Failed to connect outbound: ${err.message}`);
    if (browsers.size > 0) {
      outboundReconnectTimeout = setTimeout(() => connectOutboundToPhone(url), 5000);
    }
  }
}

/**
 * Tear down any outbound phone connection AND stop the auto-reconnect loop.
 * Used by the DISCONNECT_PHONE browser command (the webapp's Disconnect
 * button) so the phone goes cleanly back to its "waiting for connection"
 * state and the relay doesn't immediately re-establish.
 *
 * Pre-fix: DISCONNECT_PHONE was silently forwarded to the phone as just
 * another message; the phone had no handler for it, the outbound WS stayed
 * open, and even if the phone DID close it the relay's onclose retry loop
 * would re-establish 5s later. Net result: the user clicked Disconnect but
 * nothing actually disconnected. This handler is the surgical fix on the
 * relay side; the phone side adds a matching DISCONNECT_PHONE handler in
 * PhoneService.handleCommand that calls server.disconnectAllClients().
 */
function teardownOutboundPhone(reasonForLog) {
  console.log(`[Relay] teardownOutboundPhone: ${reasonForLog}`);
  if (outboundReconnectTimeout) {
    clearTimeout(outboundReconnectTimeout);
    outboundReconnectTimeout = null;
  }
  // Forward DISCONNECT_PHONE to the phone if there's a live WS so it can
  // clean up its own state — then close from our side. The phone-side
  // PhoneService.handleCommand("DISCONNECT_PHONE") calls disconnectAllClients()
  // which closes everything with code 1000.
  try {
    if (outboundPhoneWs && outboundPhoneWs.readyState === WebSocket.OPEN) {
      outboundPhoneWs.send('DISCONNECT_PHONE:{}');
    }
  } catch (e) {}
  if (outboundPhoneWs) {
    try {
      outboundPhoneWs.removeAllListeners();
      outboundPhoneWs.close(1000, 'user_disconnect');
    } catch (e) {}
  }
  outboundPhoneWs = null;
  outboundTargetUrl = null;
  outboundAwaitingAccept = false;
  if (phoneWs && phoneWs === outboundPhoneWs) {
    phoneWs = null;
  }
  // Always broadcast disconnected so the browser updates immediately
  // (don't wait for the WS onclose, which may be racing).
  phoneConnected = false;
  phoneDeviceName = null;
  broadcastToBrowsers('STATUS:{"connected":false}');
}

wss.on('connection', (ws, req) => {
  const path = req.url || '/';

  // Phone connecting as client (via QR scan)
  if (path === '/phone') {
    console.log('[Relay] Phone connected as client (QR scan mode)');

    // Stop any outbound connection attempts
    if (outboundReconnectTimeout) {
      clearTimeout(outboundReconnectTimeout);
      outboundReconnectTimeout = null;
    }
    if (outboundPhoneWs) {
      try { outboundPhoneWs.removeAllListeners(); outboundPhoneWs.close(); } catch(e) {}
      outboundPhoneWs = null;
      outboundTargetUrl = null;
    }

    setPhone(ws, 'inbound QR');

    // Tell phone which computer it connected to
    ws.send(`HELLO:{"hostname":"${HOSTNAME}"}`);

    ws.on('message', (data) => {
      const msg = data.toString();
      console.log('[Relay] Phone →', msg.substring(0, 60));
      // Store device name when phone sends it
      if (msg.startsWith('DEVICE_INFO:')) {
        try {
          const payload = JSON.parse(msg.substring('DEVICE_INFO:'.length));
          phoneDeviceName = payload.deviceName || null;
          console.log(`[Relay] Phone device name: ${phoneDeviceName}`);
          // Re-broadcast STATUS with deviceName so browsers update
          broadcastToBrowsers(`STATUS:${JSON.stringify({ connected: true, deviceName: phoneDeviceName })}`);
        } catch(e) {}
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

    return;
  }

  // Browser connection (default)
  console.log(`[Relay] Browser connected (${browsers.size + 1} total)`);
  browsers.add(ws);

  // Tell browser current phone status (include deviceName if known)
  if (phoneConnected) {
    ws.send(`STATUS:${JSON.stringify({ connected: true, deviceName: phoneDeviceName })}`);
  } else if (outboundAwaitingAccept) {
    // New browser joined mid-Accept-handshake — show the same pending state
    // the other browsers see.
    ws.send('STATUS:{"awaitingAccept":true}');
  } else {
    ws.send('STATUS:{"connected":false}');
  }

  ws.on('message', (data) => {
    const msg = data.toString();
    console.log('[Relay] Browser →', msg.substring(0, 60));

    // Special command: browser wants to connect to a specific phone IP
    if (msg.startsWith('CONNECT_TO:')) {
      const url = msg.substring('CONNECT_TO:'.length).trim();
      console.log(`[Relay] Browser requested outbound connection to: ${url}`);
      connectOutboundToPhone(url);
      return;
    }

    // Special command: browser wants to disconnect the current phone
    // session. Pre-fix this fell through to forwardToPhone and got silently
    // dropped at both ends — see teardownOutboundPhone for the full fix.
    if (msg.startsWith('DISCONNECT_PHONE')) {
      teardownOutboundPhone('browser DISCONNECT_PHONE');
      return;
    }

    // Forward to phone
    if (!forwardToPhone(msg)) {
      console.log('[Relay] No phone connected, message dropped');
    }
  });

  ws.on('close', () => {
    browsers.delete(ws);
    console.log(`[Relay] Browser disconnected (${browsers.size} remaining)`);
    // If no browsers left, stop outbound reconnect attempts
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
  console.log(`[Relay] ✅ Ready on port ${RELAY_PORT} — accepts browser (/) and phone (/phone) connections`);
});

wss.on('error', (err) => {
  console.error(`[Relay] Server error: ${err.message}`);
});
