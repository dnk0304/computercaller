const { app, BrowserWindow, ipcMain } = require('electron');
const WebSocket = require('ws');
const path = require('path');

// State
let mainWindow = null;
let phoneWs = null;
let webAppClients = new Set();

// WebSocket server for web app connections
const webAppServer = new WebSocket.Server({ port: 8766 });

webAppServer.on('connection', (ws) => {
  console.log('Web app connected');
  webAppClients.add(ws);
  
  // Send current status
  ws.send(`STATUS:${JSON.stringify({ connected: phoneWs !== null })}`);
  
  ws.on('message', (data) => {
    const message = data.toString();
    console.log('From web app:', message);
    
    // Check for connect command
    if (message.startsWith('CONNECT_PHONE:')) {
      const payload = JSON.parse(message.substring(14));
      connectToPhone(payload.ip);
      return;
    }
    
    // Forward to phone
    if (phoneWs && phoneWs.readyState === WebSocket.OPEN) {
      phoneWs.send(message);
    }
  });
  
  ws.on('close', () => {
    webAppClients.delete(ws);
    console.log('Web app disconnected');
  });
});

// Connect to phone
function connectToPhone(ip) {
  console.log('Connecting to phone at', ip);
  
  if (phoneWs) {
    phoneWs.close();
  }
  
  try {
    phoneWs = new WebSocket(`ws://${ip}:8765`);
    
    phoneWs.on('open', () => {
      console.log('Phone connected');
      broadcastToWebApps(`STATUS:${JSON.stringify({ connected: true })}`);
      updateWindowStatus('Connected to ' + ip);
    });
    
    phoneWs.on('message', (data) => {
      const message = data.toString();
      console.log('From phone:', message);
      broadcastToWebApps(message);
    });
    
    phoneWs.on('close', () => {
      console.log('Phone disconnected');
      phoneWs = null;
      broadcastToWebApps(`STATUS:${JSON.stringify({ connected: false })}`);
      updateWindowStatus('Disconnected');
    });
    
    phoneWs.on('error', (err) => {
      console.error('Phone error:', err.message);
      updateWindowStatus('Error: ' + err.message);
    });
  } catch (err) {
    console.error('Connection error:', err.message);
    updateWindowStatus('Error: ' + err.message);
  }
}

// Broadcast to all web app clients
function broadcastToWebApps(message) {
  webAppClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Update window status
function updateWindowStatus(status) {
  if (mainWindow) {
    mainWindow.webContents.send('status-update', status);
  }
}

// Handle connect from renderer
ipcMain.on('connect-phone', (event, ip) => {
  connectToPhone(ip);
});

// Create window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 450,
    height: 350,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  
  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);
  
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// App lifecycle
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

console.log('Bridge server starting on port 8766...');
