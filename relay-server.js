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

// Outbound connection to phone (fallback mode — when user enters IP manually)
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
  console.log(`[Relay] Connecting outbound to phone at ${url}...`);

  try {
    outboundPhoneWs = new WebSocket(url);

    outboundPhoneWs.on('open', () => {
      setPhone(outboundPhoneWs, `outbound to ${url}`);
      // Tell phone which computer connected
      outboundPhoneWs.send(`HELLO:{"hostname":"${HOSTNAME}"}`);
    });

    outboundPhoneWs.on('message', (data) => {
      const msg = data.toString();
      console.log('[Relay] Phone →', msg.substring(0, 60));
      // Store device name when phone sends it
      if (msg.startsWith('DEVICE_INFO:')) {
        try {
          const payload = JSON.parse(msg.substring('DEVICE_INFO:'.length));
          phoneDeviceName = payload.deviceName || null;
          console.log(`[Relay] Phone device name: ${phoneDeviceName}`);
          broadcastToBrowsers(`STATUS:${JSON.stringify({ connected: true, deviceName: phoneDeviceName })}`);
        } catch(e) {}
      }
      broadcastToBrowsers(msg);
    });

    outboundPhoneWs.on('close', () => {
      if (phoneWs === outboundPhoneWs) {
        clearPhone('outbound closed');
      }
      outboundPhoneWs = null;
      // Retry if we still have browsers connected
      if (browsers.size > 0 && outboundTargetUrl) {
        outboundReconnectTimeout = setTimeout(() => connectOutboundToPhone(outboundTargetUrl), 5000);
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
